import base64
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import gpu_eic_transport as transport
import gpu_eic_bootstrap as bootstrap

KEY='ssh-ed25519 '+base64.b64encode(b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20'+bytes(range(32))).decode()

def settings():
 return {'role':'arn:aws:iam::123456789012:role/test','region':'us-east-1','instance':'i-12345678901234567',
         'zone':'us-east-1a','user':'ubuntu','address':'127.0.0.1','port':22,'peerUid':os.getuid(),'externalId':'a'*32}

class TransportTests(unittest.TestCase):
 def test_bootstrap_generates_private_key_and_pins_host(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);directory=root/'runtime';known=root/'known-hosts';known.write_text('courtside-t4 ssh-ed25519 test\n')
   with patch.object(bootstrap,'DIRECTORY',directory),patch.object(bootstrap,'KEY',directory/'id_ed25519'),patch.object(bootstrap,'CONFIG',directory/'ssh_config'),patch.object(bootstrap,'KNOWN',str(known)),patch.object(bootstrap.os,'execv') as execute:
    bootstrap.main();execute.assert_called_once()
   self.assertEqual((directory/'id_ed25519').stat().st_mode & 0o777,0o600)
   resolved=subprocess.run(['ssh','-F',str(directory/'ssh_config'),'-G','courtside-t4'],capture_output=True,text=True,check=True).stdout
   self.assertIn('hostkeyalias courtside-t4\n',resolved)
   self.assertIn('stricthostkeychecking true\n',resolved)
   self.assertIn('proxycommand '+bootstrap.PROXY+'\n',resolved)
 def test_public_key_is_bounded_ed25519(self):
  self.assertEqual(transport.public_key(KEY+' comment'),KEY)
  for value in ('ssh-rsa AAAA', 'ssh-ed25519 !!!!', KEY+'A'*600, 'ssh-ed25519 '+base64.b64encode(b'x'*51).decode()):
   with self.assertRaises(ValueError):transport.public_key(value)

 def test_fixed_target_configuration_rejects_unexpected_targets(self):
  values=settings();self.assertEqual(transport.validate(values),values)
  for key,value in [('user','root'),('port',443),('address','attacker.invalid'),('peerUid',0),('instance','i-bad'),('zone','us-west-1a'),('externalId','short')]:
   with self.subTest(key=key),self.assertRaises(ValueError):transport.validate({**values,key:value})

 @unittest.skipUnless(hasattr(socket,'SO_PEERCRED'),'Linux peer credentials required')
 def test_authorized_peer_relays_and_wrong_peer_is_rejected(self):
  with tempfile.TemporaryDirectory() as folder:
   path=str(Path(folder)/'broker.sock');server=transport.Server(path,settings());thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   self.addCleanup(thread.join,2);self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
   left,right=socket.socketpair()
   def remote():
    with right:
     data=right.recv(128);right.sendall(b'reply:'+data);right.shutdown(socket.SHUT_WR)
   other=threading.Thread(target=remote,daemon=True);other.start()
   with patch.object(transport,'authorize') as authorize,patch.object(transport.socket,'create_connection',return_value=left):
    with socket.socket(socket.AF_UNIX) as client:
     client.settimeout(3);client.connect(path);key=KEY.encode();client.sendall(struct.pack('!H',len(key))+key)
     self.assertEqual(client.recv(1),b'\x01');client.sendall(b'hello');client.shutdown(socket.SHUT_WR)
     self.assertEqual(client.recv(128),b'reply:hello')
    authorize.assert_called_once_with(settings(),KEY)
   other.join(2)
   server.settings={**settings(),'peerUid':os.getuid()+1}
   with patch.object(transport,'authorize') as authorize:
    with socket.socket(socket.AF_UNIX) as client:
     client.settimeout(3);client.connect(path);self.assertEqual(client.recv(1),b'\x00')
    authorize.assert_not_called()

 @unittest.skipUnless(hasattr(socket,'SO_PEERCRED'),'Linux peer credentials required')
 def test_proxy_process_uses_private_socket_end_to_end(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);path=str(root/'broker.sock');key=root/'id.pub';key.write_text(KEY+'\n')
   server=transport.Server(path,settings());thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   self.addCleanup(thread.join,2);self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
   left,right=socket.socketpair()
   def remote():
    with right:
     data=right.recv(128);right.sendall(b'reply:'+data);right.shutdown(socket.SHUT_WR)
   other=threading.Thread(target=remote,daemon=True);other.start()
   with patch.object(transport,'authorize') as authorize,patch.object(transport.socket,'create_connection',return_value=left):
    result=subprocess.run([sys.executable,transport.__file__,'proxy','--socket',path,'--public-key',str(key)],
                          input=b'hello',capture_output=True,timeout=10,check=True)
    self.assertEqual(result.stdout,b'reply:hello');authorize.assert_called_once_with(settings(),KEY)
   other.join(2)

if __name__=='__main__':unittest.main()
