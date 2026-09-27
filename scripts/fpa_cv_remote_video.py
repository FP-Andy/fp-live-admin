"""Seek a private S3 video through a short-lived loopback Range reader.

FFmpeg receives no AWS credentials or presigned URLs. S3 streams close as soon
as the decoder seeks or releases the source; no full video cache is created.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import re
import threading
import uuid


def byte_range(header, size):
    if not header:return 0,size-1,False
    match=re.fullmatch(r'bytes=(\d*)-(\d*)',header)
    if not match or not any(match.groups()):raise ValueError('Invalid range')
    left,right=match.groups()
    if not left:
        length=int(right)
        if length<=0:raise ValueError('Invalid suffix')
        return max(0,size-length),size-1,True
    start=int(left);end=min(size-1,int(right)) if right else size-1
    if start>=size or start>end:raise ValueError('Unsatisfiable range')
    return start,end,True


class S3VideoReader:
    def __init__(self,storage,key):
        self.storage=storage;self.key=storage.key(key)
        self.size=storage.head(key)['ContentLength']
        self.bytes_read=0;self.requests=0
        self.path='/'+uuid.uuid4().hex+'/source.mp4'

    def __enter__(self):
        source=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_HEAD(self):self.respond(False)
            def do_GET(self):self.respond(True)
            def respond(self,read):
                if self.path!=source.path:self.send_error(404);return
                try:start,end,partial=byte_range(self.headers.get('Range'),source.size)
                except ValueError:
                    self.send_response(416);self.send_header('Content-Range',f'bytes */{source.size}');self.end_headers();return
                body=None
                try:
                    if read:
                        body=source.storage.client.get_object(Bucket=source.storage.bucket,Key=source.key,Range=f'bytes={start}-{end}')['Body']
                        source.requests+=1
                    self.send_response(206 if partial else 200)
                    self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
                    self.send_header('Content-Type','video/mp4')
                    if partial:self.send_header('Content-Range',f'bytes {start}-{end}/{source.size}')
                    self.end_headers()
                    if body:
                        while chunk:=body.read(64*1024):
                            source.bytes_read+=len(chunk);self.wfile.write(chunk)
                except (OSError,ConnectionError):pass
                except Exception:
                    if body is None:self.send_error(502,'S3 range read failed')
                finally:
                    if body is not None:body.close()
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.server.server_port}{self.path}'
        return self

    def __exit__(self,*args):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
