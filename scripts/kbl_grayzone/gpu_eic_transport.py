"""Fixed-target SSH transport over a private local socket.

The networked broker holds no static AWS key. It may publish a short-lived
public key only for its configured EC2 instance and OS user, then relays one
SSH connection to the configured IP. The worker has no network namespace.
"""
import argparse
import base64
import errno
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import socket
import socketserver
import stat
import struct
import sys
import threading

MAX_KEY=512

def public_key(text):
    if not isinstance(text,str) or len(text)>MAX_KEY:raise ValueError('invalid public key')
    parts=text.strip().split()
    if len(parts) not in (2,3) or parts[0]!='ssh-ed25519':raise ValueError('invalid public key')
    try:raw=base64.b64decode(parts[1],validate=True)
    except ValueError:raise ValueError('invalid public key') from None
    if len(raw)!=51 or raw[:19]!=b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20':raise ValueError('invalid public key')
    return ' '.join(parts[:2])

def read_exact(sock,size):
    result=bytearray()
    while len(result)<size:
        data=sock.recv(size-len(result))
        if not data:raise EOFError('connection closed')
        result.extend(data)
    return bytes(result)

def transfer(a,b,idle=90):
    """Relay both directions and propagate half-close without buffering files."""
    inputs={a:b,b:a}
    while inputs:
        ready,_,_=select.select(list(inputs),[],[],idle)
        if not ready:raise TimeoutError('SSH transport idle')
        for source in ready:
            dest=inputs[source];chunk=source.recv(65536)
            if chunk:dest.sendall(chunk)
            else:
                del inputs[source]
                try:dest.shutdown(socket.SHUT_WR)
                except OSError:pass

def authorize(settings,key):
    # The broker has no access to the API's long-lived credential variables.
    # It assumes the configured narrowly scoped role via its instance profile.
    if any(os.environ.get(k) for k in ('AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE','AWS_DEFAULT_PROFILE')):
        raise RuntimeError('static AWS credentials are not permitted')
    import boto3
    from botocore.config import Config
    limits=Config(connect_timeout=3,read_timeout=8,retries={'max_attempts':1})
    session=boto3.Session(region_name=settings['region'])
    credentials=session.client('sts',config=limits).assume_role(RoleArn=settings['role'],RoleSessionName='courtside-t4',DurationSeconds=900)['Credentials']
    client=session.client('ec2-instance-connect',aws_access_key_id=credentials['AccessKeyId'],
        aws_secret_access_key=credentials['SecretAccessKey'],aws_session_token=credentials['SessionToken'],config=limits)
    response=client.send_ssh_public_key(InstanceId=settings['instance'],AvailabilityZone=settings['zone'],
        InstanceOSUser=settings['user'],SSHPublicKey=key)
    if not response.get('Success'):raise RuntimeError('key publication failed')

def validate(settings):
    if not isinstance(settings,dict):raise ValueError('invalid broker settings')
    if set(settings)!={'role','region','instance','zone','user','address','port','peerUid'}:raise ValueError('invalid broker settings')
    if not re.fullmatch(r'arn:aws(?:-[a-z-]+)?:iam::\d{12}:role/[A-Za-z0-9_+=,.@/-]+',settings['role']):raise ValueError('invalid role')
    if not re.fullmatch(r'[a-z]{2}(?:-gov)?-[a-z]+-\d',settings['region']):raise ValueError('invalid region')
    if not re.fullmatch(r'i-[0-9a-f]{8}(?:[0-9a-f]{9})?',settings['instance']):raise ValueError('invalid instance')
    if not re.fullmatch(re.escape(settings['region'])+r'[a-z]',settings['zone']):raise ValueError('invalid availability zone')
    if settings['user']!='ubuntu':raise ValueError('invalid target user')
    ipaddress.ip_address(settings['address'])
    if settings['port']!=22 or type(settings['peerUid']) is not int or settings['peerUid']<=0:raise ValueError('invalid broker target')
    return settings

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        client=self.request;remote=None
        try:
            if not hasattr(socket,'SO_PEERCRED'):raise RuntimeError('peer credentials unavailable')
            _,uid,_=struct.unpack('3i',client.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            if uid!=self.server.settings['peerUid']:raise PermissionError('unexpected peer')
            client.settimeout(15)
            length=struct.unpack('!H',read_exact(client,2))[0]
            if not 1<=length<=MAX_KEY:raise ValueError('invalid key length')
            key=public_key(read_exact(client,length).decode('ascii'))
            authorize(self.server.settings,key)
            remote=socket.create_connection((self.server.settings['address'],self.server.settings['port']),timeout=12)
            remote.settimeout(None);client.settimeout(None);client.sendall(b'\x01')
            transfer(client,remote)
        except Exception:
            try:client.sendall(b'\x00')
            except OSError:pass
        finally:
            if remote:remote.close()
            self.server.slots.release()

class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
    daemon_threads=True
    def __init__(self,path,settings):
        self.settings=validate(settings);self.slots=threading.BoundedSemaphore(8)
        super().__init__(path,Handler)
    def process_request(self,request,address):
        if not self.slots.acquire(blocking=False):request.close();return
        try:super().process_request(request,address)
        except BaseException:self.slots.release();raise

def broker(path,settings):
    path=Path(path)
    if not path.is_absolute():raise ValueError('socket must be absolute')
    parent=path.parent;info=parent.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:raise ValueError('socket directory must be private')
    with (parent/(path.name+'.lock')).open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if path.exists():
            if not stat.S_ISSOCK(path.lstat().st_mode):raise ValueError('socket path occupied')
            with socket.socket(socket.AF_UNIX) as probe:
                probe.settimeout(1)
                result=probe.connect_ex(str(path))
                if result not in (errno.ECONNREFUSED,errno.ENOENT):raise RuntimeError('socket may still be active')
            path.unlink()
        old=os.umask(0o077)
        try:server=Server(str(path),settings)
        finally:os.umask(old)
        inode=path.stat().st_ino
        try:server.serve_forever()
        finally:
            server.server_close()
            try:
                if path.stat().st_ino==inode:path.unlink()
            except FileNotFoundError:pass

def proxy(path,key_path):
    key=public_key(Path(key_path).read_text()).encode('ascii')
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as sock:
        sock.settimeout(60);sock.connect(path);sock.sendall(struct.pack('!H',len(key))+key)
        if read_exact(sock,1)!=b'\x01':raise RuntimeError('T4 connection unavailable')
        sock.settimeout(None)
        inputs={sock:sys.stdout.buffer,sys.stdin.buffer:sock}
        while inputs:
            ready,_,_=select.select(list(inputs),[],[],90)
            if not ready:raise TimeoutError('SSH transport idle')
            for source in ready:
                chunk=source.recv(65536) if source is sock else os.read(source.fileno(),65536)
                if not chunk:
                    del inputs[source]
                    if source is not sock:
                        try:sock.shutdown(socket.SHUT_WR)
                        except OSError:pass
                    else:return
                elif source is sock:sys.stdout.buffer.write(chunk);sys.stdout.buffer.flush()
                else:sock.sendall(chunk)

def main():
    parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='action',required=True)
    server=sub.add_parser('broker');server.add_argument('--socket',required=True);server.add_argument('--config',required=True)
    client=sub.add_parser('proxy');client.add_argument('--socket',required=True);client.add_argument('--public-key',required=True)
    args=parser.parse_args()
    if args.action=='broker':broker(args.socket,json.loads(Path(args.config).read_text()))
    else:proxy(args.socket,args.public_key)

if __name__=='__main__':main()
