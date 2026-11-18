"""Synthetic browser-to-worker check; never uses actual case data."""
import json,os,shutil,socketserver,tempfile,threading,unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
import server_auto_pose

class ServerAutoPoseTests(unittest.TestCase):
 def test_authorization_is_scoped_to_job_and_event(self):
  with server_auto_pose.authorize('game-test','review-1','job1') as key:
   self.assertTrue(server_auto_pose.permitted('game-test','review-1','job1',key))
   self.assertFalse(server_auto_pose.permitted('game-test','review-2','job1',key))
   self.assertFalse(server_auto_pose.permitted('game-test','review-1','job2',key))
   self.assertFalse(server_auto_pose.permitted('game-test','review-1','job1','bad'))
  self.assertFalse(server_auto_pose.permitted('game-test','review-1','job1',key))

 @unittest.skipUnless(os.environ.get('COURTSIDE_AUTO_POSE_BROWSER_TEST')=='1','explicit isolated browser test only')
 def test_private_browser_prepares_via_worker_without_a_user_tab(self):
  case='game-test';event='review-1';old='a'*24;new='b'*24;received=[]
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_GET(self):
    if not self.path.startswith('/reconstruction.html'):
     self.send_response(404);self.end_headers();return
    html='''<!doctype html><script>
      const params=new URLSearchParams(location.search),token=params.get('autoPrepare'),caseId=params.get('id');
      window.addEventListener('message',async e=>{if(e.data?.type!=='kbl-auto-pose-start')return;
       const response=await fetch('/api/cases/game-test/events/review-1/reconstruction?automatic=1&expectedCapture=aaaaaaaaaaaaaaaaaaaaaaaa',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
       const data=await response.json();parent.postMessage({type:'kbl-auto-pose-complete',caseId,eventId:'review-1',token,previousCaptureId:'aaaaaaaaaaaaaaaaaaaaaaaa',captureId:data.captureId},location.origin);
      });
      parent.postMessage({type:'kbl-auto-pose-ready',caseId,eventId:'review-1',token},location.origin);
    </script>'''.encode()
    self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(html)));self.end_headers();self.wfile.write(html)
   def do_POST(self):
    received.append((self.path,self.headers.get('X-Courtside-Auto-Key')))
    self.rfile.read(int(self.headers.get('Content-Length',0)));payload=json.dumps({'captureId':new}).encode()
    self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
  class UnixServer(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
   daemon_threads=True
   # BaseHTTPRequestHandler expects an IP-style client address.
   def get_request(self):
    conn,_=super().get_request();return conn,('127.0.0.1',0)
  for transport in ('tcp','unix'):
   with self.subTest(transport=transport),tempfile.TemporaryDirectory(prefix='kbl-auto-test-') as tmp:
    root=Path(tmp);(root/'run').mkdir();(root/'scripts/kbl_grayzone').mkdir(parents=True)
    shutil.copyfile(server_auto_pose.ROOT/'scripts/kbl_grayzone/render_auto_pose.mjs',root/'scripts/kbl_grayzone/render_auto_pose.mjs')
    server=UnixServer(str(root/'run/courtside.sock'),Handler) if transport=='unix' else ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
     env={'KBL_LOCAL_PORT':str(server.server_port)} if transport=='tcp' else {}
     with patch.object(server_auto_pose,'ROOT',root),patch.dict(os.environ,env):
      with server_auto_pose.authorize(case,event,'c'*24) as key:
       result=server_auto_pose.render(case,event,key)
     self.assertEqual(result,{'previousCaptureId':old,'captureId':new})
     self.assertEqual(received[-1][1],key)
     self.assertIn('expectedCapture='+old,received[-1][0])
    finally:
     server.shutdown();server.server_close();thread.join()
  self.assertEqual(len(received),2)

if __name__=='__main__':unittest.main()
