import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch
from types import SimpleNamespace
from app.recording_engine import Recorder, ArchiveStore, capture_command


class MultipartClient:
    def __init__(self, root): self.root, self.blocks, self.aborted = root, [], False
    def create_multipart_upload(self, **kw): return {'UploadId': 'test'}
    def upload_part(self, **kw): self.blocks.append(kw['Body']); return {'ETag': str(len(self.blocks))}
    def complete_multipart_upload(self, **kw): (self.root / 'full.mp4').write_bytes(b''.join(self.blocks))
    def head_object(self, **kw): return {'ContentLength': (self.root / 'full.mp4').stat().st_size}
    def abort_multipart_upload(self, **kw): self.aborted = True


class LocalStore(ArchiveStore):
    def __init__(self, root):
        self.root, self.bucket, self.client = root, 'test', MultipartClient(root)
        self.fail = False
    def probe(self): pass
    def upload(self, path, key):
        if self.fail: raise RuntimeError('simulated upload failure')
        shutil.copyfile(path, self.root / Path(key).name)
        return path.stat().st_size
    def url(self, key, download=False): return str(self.root / Path(key).name)


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'remote').mkdir()
        self.store = LocalStore(self.root / 'remote')
        self.rec = Recorder(self.root / 'data', self.store, 'rtmp://localhost/live', 'rtmp://example/live', 2)
        self.rec.launch = lambda sid: None
        self.mid = str(uuid.uuid4())

    def tearDown(self): self.temp.cleanup()

    def test_start_idempotent_and_random_stream_keys(self):
        first = self.rec.start(self.mid)
        self.assertEqual(first['id'], self.rec.start(self.mid)['id'])
        second = self.rec.start(str(uuid.uuid4()))
        self.assertNotEqual(first['stream_key'], second['stream_key'])
        self.rec.stop(first['id'])
        self.assertFalse(self.rec.load(first['id'])['desired'])
        resumed = self.rec.start(self.mid)
        self.assertNotEqual(first['id'], resumed['id'])
        self.assertEqual(first['stream_key'], resumed['stream_key'])

    def fixture(self):
        state = self.rec.start(self.mid)
        folder = self.rec.path(state['id']) / 'take-00001'
        folder.mkdir()
        source = self.root / 'source.mp4'
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25',
                        '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','6',
                        '-c:v','libx264','-preset','ultrafast','-g','25','-c:a','aac',str(source)],check=True)
        subprocess.run(capture_command(str(source), folder, 2), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,check=True)
        return state

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg integration requires ffmpeg')
    def test_segments_preview_full_mp4_and_preservation(self):
        state = self.fixture()
        sid = state['id']
        self.rec.stop(sid)
        self.rec.run(sid)
        saved = self.rec.load(sid)
        self.assertEqual(saved['status'], 'ready', saved)
        self.assertGreaterEqual(len(saved['parts']), 3)
        self.assertAlmostEqual(sum(p['duration'] for p in saved['parts']), 6, delta=.2)
        self.assertTrue((self.rec.path(sid) / 'preview.jpg').exists())
        self.assertEqual(list(self.rec.path(sid).glob('take-*/*.mp4')), [])
        subprocess.run(['ffmpeg','-v','error','-i',str(self.root/'remote/full.mp4'),'-f','null','-'],check=True)
        before=len(saved['parts']);self.rec.upload_closed(sid)
        self.assertEqual(len(self.rec.load(sid)['parts']),before)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg integration requires ffmpeg')
    def test_failed_upload_retains_original_and_retry_recovers(self):
        state=self.fixture();sid=state['id'];self.rec.stop(sid);self.store.fail=True
        self.rec.run(sid)
        self.assertEqual(self.rec.load(sid)['status'],'error')
        self.assertGreater(len(list(self.rec.path(sid).glob('take-*/*.mp4'))),0)
        self.store.fail=False;self.rec.run(sid)
        self.assertEqual(self.rec.load(sid)['status'],'ready')

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg integration requires ffmpeg')
    def test_temporary_storage_failure_keeps_capture_armed(self):
        state=self.fixture();sid=state['id'];self.store.fail=True
        self.rec.upload_during_capture(sid)
        self.assertTrue(self.rec.load(sid)['desired'])
        self.assertTrue(self.rec.load(sid)['error'])
        self.assertGreater(len(list(self.rec.path(sid).glob('take-*/*.mp4'))),0)
        self.store.fail=False;self.rec.upload_retry_at[sid]=0
        self.rec.upload_during_capture(sid)
        self.assertTrue(self.rec.load(sid)['desired'])
        self.assertFalse(self.rec.load(sid)['error'])
        self.assertGreater(len(self.rec.load(sid)['parts']),0)

    def test_recovery_and_limit(self):
        states=[self.rec.start(str(uuid.uuid4())) for _ in range(3)]
        with self.assertRaises(ValueError): self.rec.start(str(uuid.uuid4()))
        self.rec.stop(states[1]['id'])
        recovered=[];self.rec.launch=recovered.append;self.rec.recover()
        self.assertEqual(set(recovered),{s['id'] for s in states})
        with self.assertRaises(ValueError): self.rec.path('../escape')

    def test_prepare_waiting_session_restarts_receiver_without_changing_key(self):
        from app import recording_service as service
        from fastapi.testclient import TestClient
        from app.auth import require_session_user
        from app.db import get_db
        service.recorder = self.rec
        state = self.rec.start(self.mid)
        # Preserve a previously shared legacy key, not only new basketball keys.
        self.rec.update(state['id'], stream_key=str(uuid.uuid4()))
        previous = self.rec.load(state['id'])
        match = SimpleNamespace(sport='BASKETBALL', operator_id=None, archived=False)
        service.app.dependency_overrides[get_db] = lambda: SimpleNamespace(get=lambda *args: match)
        service.app.dependency_overrides[require_session_user] = lambda: SimpleNamespace(id='admin', role='SUPERADMIN')
        client = TestClient(service.app)
        try:
            with patch.dict(os.environ, {'MEDIA_CONTROL_URL':'https://media.example/start'}), patch('urllib.request.urlopen') as control:
                control.return_value.__enter__.return_value = io.BytesIO(b'{"ok":true,"state":"pending"}')
                response = client.post(f'/api/recordings/matches/{self.mid}/start')
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()['id'], previous['id'])
                self.assertEqual(response.json()['stream_key'], previous['stream_key'])
                self.assertEqual(json.loads(control.call_args.args[0].data)['action'], 'start')
            with patch('app.recording_service.socket.create_connection', side_effect=OSError):
                self.assertFalse(client.get(f'/api/recordings/matches/{self.mid}').json()['receiver_ready'])
            with patch('app.recording_service.socket.create_connection'):
                self.assertTrue(client.get(f'/api/recordings/matches/{self.mid}').json()['receiver_ready'])
            self.rec.stop(previous['id'])
            self.assertEqual(self.rec.start(self.mid)['stream_key'], previous['stream_key'])
        finally:
            service.app.dependency_overrides.clear()

    def test_http_auth_ownership_and_cross_match(self):
        from fastapi.testclient import TestClient
        from app import recording_service as service
        from app.auth import require_session_user
        from app.db import get_db
        service.recorder=self.rec
        match=SimpleNamespace(sport='BASKETBALL',operator_id='owner',archived=False)
        service.app.dependency_overrides[get_db]=lambda:SimpleNamespace(get=lambda *args:match)
        client=TestClient(service.app)
        try:
            self.assertEqual(client.get(f'/api/recordings/matches/{self.mid}').status_code,401)
            service.app.dependency_overrides[require_session_user]=lambda:SimpleNamespace(id='other',role='OPERATOR')
            self.assertEqual(client.post(f'/api/recordings/matches/{self.mid}/start').status_code,403)
            service.app.dependency_overrides[require_session_user]=lambda:SimpleNamespace(id='owner',role='OPERATOR')
            with patch.dict(os.environ,{'MEDIA_CONTROL_URL':''}):
                started=client.post(f'/api/recordings/matches/{self.mid}/start')
            self.assertEqual(started.status_code,200,started.text)
            sid=started.json()['id']
            self.assertEqual(client.get(f'/api/recordings/matches/{uuid.uuid4()}/{sid}/files/full').status_code,404)
            self.assertEqual(client.post(f'/api/recordings/matches/{self.mid}/{sid}/stop',headers={'Origin':'https://evil.example'}).status_code,403)
            self.assertEqual(client.post(f'/api/recordings/matches/{self.mid}/{sid}/stop',headers={'Origin':'https://console.fineludens.kr','Host':'recording:8010'}).status_code,200)
            self.assertEqual(client.post(f'/api/recordings/matches/{self.mid}/{sid}/stop').status_code,200)
        finally:
            service.app.dependency_overrides.clear()

if __name__=='__main__': unittest.main()
