"""Real Unix-socket worker smoke test with a synthetic clip and no cloud access."""
import csv
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

import cv2
import numpy as np

REPO = Path(__file__).resolve().parents[2]


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('127.0.0.1', 4350, timeout=10)
        self.socket_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self.socket_path))


class PrivateWorkerSmoke(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='courtside-worker-smoke-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        shutil.copytree(REPO/'scripts/kbl_grayzone', self.root/'scripts/kbl_grayzone',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        self.sock = self.root/'run/test.sock'
        self.start_worker()
        self.addCleanup(self.stop_worker)

    def start_worker(self):
        env = {**os.environ, 'KBL_GPU_DISABLED': '1', 'KBL_VIDEO_RENDER_ENABLED': '0'}
        self.worker = subprocess.Popen([sys.executable, str(self.root/'scripts/kbl_grayzone/serve_socket.py'),
                                        '--socket', 'run/test.sock'], cwd=self.root, env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic()+15
        while not self.sock.exists() and self.worker.poll() is None and time.monotonic()<deadline:
            time.sleep(.05)
        if not self.sock.exists():
            error = self.worker.stderr.read().decode(errors='replace') if self.worker.poll() is not None else 'startup timed out'
            self.fail('worker did not start: '+error)

    def stop_worker(self):
        if self.worker.poll() is None:
            self.worker.terminate()
            try: self.worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.worker.kill(); self.worker.wait(timeout=5)
        if self.worker.stderr: self.worker.stderr.close()

    def request(self, method, path, value=None, binary=False):
        conn = UnixHTTPConnection(self.sock)
        try:
            headers = {'Host': '127.0.0.1:4350', 'Origin': 'http://127.0.0.1:4350'}
            if value is None: body = None
            elif binary:
                body = value; headers['Content-Type'] = 'application/octet-stream'
            else:
                body = json.dumps(value, ensure_ascii=False).encode(); headers['Content-Type'] = 'application/json'
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse(); raw = response.read()
            return response.status, json.loads(raw) if raw else None
        finally: conn.close()

    def test_new_store_catalog_is_created_and_existing_catalog_preserved(self):
        catalog = self.root/'outputs/kbl-library/matches.json'
        self.assertEqual(json.loads(catalog.read_text()), {'matches': []})
        saved = {'matches': [{'id': 'existing', 'home': 'A', 'away': 'B'}]}
        catalog.write_text(json.dumps(saved))
        self.stop_worker()
        # A terminated server can leave a stale Unix socket behind.
        if self.sock.exists(): self.sock.unlink()
        self.start_worker()
        self.assertEqual(json.loads(catalog.read_text()), saved)

    def test_create_upload_resume_and_choose_frame(self):
        source = self.root/'synthetic.mp4'
        writer = cv2.VideoWriter(str(source), cv2.VideoWriter_fourcc(*'mp4v'), 30, (1920,1080))
        self.assertTrue(writer.isOpened())
        try:
            for i in range(60): writer.write(np.full((1080,1920,3), i, dtype=np.uint8))
        finally: writer.release()
        media = source.read_bytes(); self.assertGreater(len(media), 0)
        fields = ['경기번호','경기일','홈팀','원정팀','판독횟수','쿼터','경기시간','소요시간(초)',
                  '판독구분','요청팀','판독결과','판독결과(직접입력)','기록시각','작성자','심판1']
        csv_file = io.StringIO(); csv_writer = csv.DictWriter(csv_file, fieldnames=fields); csv_writer.writeheader()
        csv_writer.writerow(dict(zip(fields,['999','2026-11-13','Test Home','Test Away','1','1','5:22','30',
                                            '감독 요청','Test Home','유지','파울 유지','','','#11.김도명'])))
        payload = {'fpcMatchId':str(uuid.uuid4()),'home':'Test Home','away':'Test Away','expectedDate':'2026-11-13',
                   'csvText':csv_file.getvalue(),'candidateMode':'manual','media':[{'name':'synthetic.mp4','size':len(media)}]}
        status, created = self.request('POST','/api/internal/fpc-intakes',payload)
        self.assertEqual(status,200,created)
        key = created['id']; base = '/api/intake/'+key
        split = len(media)//2
        self.assertEqual(self.request('POST',base+'/media/0?offset=0',media[:split],True)[0],200)
        self.assertEqual(self.request('POST',base+'/media/0?offset=0',media[:split],True)[0],409)
        status, partial = self.request('GET',base)
        self.assertEqual(status,200); self.assertEqual(partial['media'][0]['received'],split)
        self.assertEqual(partial['media'][0]['uploadChunks'][0]['sha256'],hashlib.sha256(media[:split]).hexdigest())
        self.assertEqual(self.request('POST',base+'/media/0?offset='+str(split),media[split:],True)[0],200)
        self.assertEqual(self.request('POST',base+'/finalize',{})[0],200)
        deadline = time.monotonic()+10
        while time.monotonic()<deadline:
            status, data = self.request('GET',base)
            if data['status']!='matching': break
            time.sleep(.05)
        self.assertEqual(data['status'],'awaiting-selection',data.get('error'))
        self.assertEqual((data['media'][0]['frames'],data['media'][0]['fps']),(60,30))
        self.assertEqual(data['referees'][0]['number'],11)
        selection = {'revision':data['revision'],'eventId':'review-1','mediaId':'0','frameIndex':15,
                     'mode':'manual','wideChoice':'skip'}
        status, selected = self.request('POST',base+'/selection',selection)
        self.assertEqual(status,200,selected); self.assertEqual(selected['status'],'selected')
        self.assertEqual(selected['events'][0]['selection']['sourceSha256'],hashlib.sha256(media).hexdigest())


if __name__ == '__main__':
    unittest.main()
