"""Exercise boto3 streaming and range resume against synthetic localhost data."""
import hashlib
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import re
import socket
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

try:
 import boto3
 from botocore import UNSIGNED
 from botocore.config import Config
except ImportError:boto3=None
from app.courtside_recording_source import copy_part_to_shared_store


@unittest.skipUnless(boto3,'boto3 is not installed')
class SyntheticS3WireTests(unittest.TestCase):
 def test_stream_interruption_resumes_over_real_http(self):
  data=bytes(range(256))*(32768);etag='"synthetic-v1"';calls=[]
  class Handler(BaseHTTPRequestHandler):
   protocol_version='HTTP/1.1'
   def log_message(self,*args):pass
   def do_HEAD(self):
    self.send_response(200);self.send_header('Content-Length',str(len(data)));self.send_header('ETag',etag);self.end_headers()
   def do_GET(self):
    request=self.headers.get('Range');calls.append((request,self.headers.get('If-Match')))
    start=int(re.fullmatch(r'bytes=(\d+)-',request)[1]) if request else 0
    self.send_response(206 if request else 200);self.send_header('Content-Length',str(len(data)-start));self.send_header('ETag',etag)
    if request:self.send_header('Content-Range',f'bytes {start}-{len(data)-1}/{len(data)}')
    self.end_headers()
    if len(calls)==1:
     self.wfile.write(data[:2*1024*1024]);self.wfile.flush();self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();self.close_connection=True
    else:self.wfile.write(data[start:]);self.wfile.flush()
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
  thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  self.addCleanup(thread.join,5);self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
  client=boto3.client('s3',endpoint_url=f'http://127.0.0.1:{server.server_port}',region_name='us-east-1',
   aws_access_key_id='synthetic',aws_secret_access_key='synthetic',config=Config(signature_version=UNSIGNED,retries={'max_attempts':0},s3={'addressing_style':'path'}))
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);args=(client,'synthetic-bucket',root,str(uuid.uuid4()),'a'*24,str(uuid.uuid4()),'take-00001-part-000001.mp4')
   with self.assertRaises(Exception):copy_part_to_shared_store(*args)
   result=copy_part_to_shared_store(*args)
   self.assertEqual(result['sha256'],hashlib.sha256(data).hexdigest());self.assertEqual((root/result['relativePath']).read_bytes(),data)
   self.assertEqual(len(calls),2);self.assertIsNone(calls[0][0]);self.assertRegex(calls[1][0],r'^bytes=[1-9]\d*-$');self.assertTrue(all(c[1]==etag for c in calls))

if __name__=='__main__':unittest.main()
