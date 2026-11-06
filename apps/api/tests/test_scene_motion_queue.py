"""Real authenticated API, durable recovery and isolated scene worker contracts."""
import asyncio
import hashlib
import json
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_match_write_access as fixture
import anyio
import httpx
from sqlalchemy import text
from app import scene_motion_queue as queue
from app import scene_motion_worker as worker_module
from app.models import HighlightClip, HighlightClipAction, HighlightJob
from app.scene_motion import scene_motion_key
from app.scene_motion_worker import SceneMotionWorker, RenderInterrupted

DATA = {'players': [{'x': 20, 'y': 30, 'team': 'home', 'number': '7'}]}
STATE = {'beforeDots': [{'id': 'h7', 'group': 'home', 'jersey': '7', 'x': 20, 'y': 30}],
         'afterDots': [{'id': 'h7', 'group': 'home', 'jersey': '7', 'x': 60, 'y': 40}]}
# 아래 픽스처로 만든 FinePlay 페이로드(sort_keys·compact JSON)의 sha256.
# mp4 를 다운로드 때만 만들도록 바꾸기 전 origin/main(621eb52)에서 뽑은 값이다 —
# 이 값이 바뀌면 FinePlay 로 나가는 계약(G2)이 바뀐 것이니 의도한 변경인지 확인할 것.
PAYLOAD_SHA256 = 'f654fc4e5944038bf5da8a7507fc6f5ae82c581bab9351e96daa4785642d88a3'


class SceneQueueTests(fixture.MatchWriteAccess):
    def setUp(self):
        super().setUp()
        self.mutex = threading.Lock()
        self.client = self.clients['admin']
        self.storage = SimpleNamespace(configured=True, bucket='scene-fixture',
            exists=Mock(side_effect=AssertionError('S3 lookup must not run in scene GET')),
            presigned_get=lambda key, **kw: 'https://fixture.invalid/' + key)
        p = patch.object(fixture.main, 'highlight_default_storage', return_value=self.storage)
        p.start(); self.addCleanup(p.stop)
        with fixture.SessionLocal() as db:
            db.add(HighlightJob(id='scene-job', mode='manual', status='done', original_filename='fixture.mp4', job_metadata={}))
            db.flush()
            db.add(HighlightClip(id='scene-clip', job_id='scene-job', horizontal_s3_key='prefix/clip.mp4'))
            db.flush()
            db.add(HighlightClipAction(id=1, clip_id='scene-clip', seq=1, action_name='Dribble',
                jersey='7', team_side='home', extra={'sceneState': STATE}))
            db.commit()
        self.route = '/api/highlight/clip-results/clips/scene-clip/scene-motions'

    @contextmanager
    def local_lock(self):
        acquired = self.mutex.acquire(blocking=False)
        try:
            yield object() if acquired else None
        finally:
            if acquired:
                self.mutex.release()

    def worker(self, render=None, lock=None):
        return SceneMotionWorker(fixture.SessionLocal, fixture.engine,
            lock=lock or self.local_lock, render=render or (lambda *args: None))

    def submit(self, key='one', **kwargs):
        with fixture.SessionLocal() as db:
            task = queue.enqueue(db, 'scene-fixture', key, DATA, **kwargs)
            value = task.id if task else None
            db.commit()
            return value

    def uploaded(self, keys):
        """워커가 올린 것으로 칠 S3 키 집합 — exists 가 이 집합만 참으로 본다."""
        self.storage.exists = Mock(side_effect=lambda key: key in keys)
        self.storage.presigned_download = lambda key, filename, **kw: 'https://fixture.invalid/dl/' + key

    def test_opening_clip_lists_scene_data_without_enqueue_or_storage(self):
        # 상세를 몇 번 열어도(목록 조회) mp4 렌더가 큐에 들어가지 않는다 — 다운로드 때만 만든다.
        with patch('app.scene_motion.render_scene_data', side_effect=AssertionError('HTTP capture')):
            for _ in range(3):
                response = self.client.get(self.route)
                self.assertEqual(response.status_code, 200, response.text)
                motion = response.json()['motions'][0]
                self.assertTrue(motion['sceneData']['players'])
                self.assertEqual(motion['render_status'], 'none')
                self.assertIsNone(motion['url'])
        self.storage.exists.assert_not_called()
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(queue.SceneMotionTask).count(), 0)
        self.assertEqual(self.clients['anonymous'].get(self.route).status_code, 401)

    def test_scenes_are_listed_without_s3_and_only_download_needs_it(self):
        # S3 가 없는 환경(로컬)에서도 장면 목록(sceneData)은 보여야 한다 — 브라우저가 그린다.
        # mp4 다운로드만 S3 가 필요하므로 그쪽만 막힌다.
        self.storage.configured = False
        response = self.client.get(self.route)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertIs(body['storage_configured'], False)
        motion = body['motions'][0]
        self.assertTrue(motion['sceneData']['players'])
        self.assertIsNone(motion['url'])
        self.assertEqual(motion['render_status'], 'none')
        download = self.client.get(self.route + f"/{motion['seq']}/download")
        self.assertEqual(download.status_code, 409, download.text)
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(queue.SceneMotionTask).count(), 0)

    def test_download_enqueues_once_per_key_and_returns_file_when_completed(self):
        uploaded = set()
        self.uploaded(uploaded)
        download = self.route + '/1/download'
        with patch('app.scene_motion.render_scene_data', side_effect=AssertionError('HTTP capture')):
            for _ in range(3):  # 여러 번 눌러도(또는 화면이 다시 불러도) 작업은 하나
                response = self.client.get(download)
                self.assertEqual(response.status_code, 202, response.text)
                self.assertEqual(response.json()['status'], 'queued')
                self.assertIsNone(response.json()['url'])
        with fixture.SessionLocal() as db:
            tasks = db.query(queue.SceneMotionTask).all()
            self.assertEqual(len(tasks), 1)
            key = tasks[0].object_key
        # 만드는 중에는 S3 를 두드리지 않는다(첫 요청에서 없는지 한 번만 확인).
        self.assertEqual(self.storage.exists.call_count, 1)
        listed = self.client.get(self.route).json()['motions'][0]
        self.assertEqual((listed['render_status'], listed['url']), ('queued', None))
        self.assertTrue(self.worker(lambda *args: uploaded.add(key)).run_one())
        ready = self.client.get(download)
        self.assertEqual(ready.status_code, 200, ready.text)
        body = ready.json()
        self.assertEqual(body['status'], 'ready')
        self.assertEqual(body['url'], 'https://fixture.invalid/dl/' + key)
        self.assertTrue(body['filename'].endswith('-action-1.mp4'))
        listed = self.client.get(self.route).json()['motions'][0]
        self.assertEqual(listed['render_status'], 'completed')
        self.assertTrue(listed['url'].startswith('https://fixture.invalid/prefix/scene-motion/'))
        # 좌표를 고치면 키가 바뀐다 — 옛 mp4 를 주지 않고, 목록 조회는 여전히 큐에 넣지 않는다.
        with fixture.SessionLocal() as db:
            action = db.get(HighlightClipAction, 1)
            action.extra = {'sceneState': {**STATE, 'beforeDots': [{**STATE['beforeDots'][0], 'x': 25}]}}
            db.commit()
        changed = self.client.get(self.route).json()['motions'][0]
        self.assertEqual((changed['render_status'], changed['url']), ('none', None))
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(queue.SceneMotionTask).count(), 1)
        self.assertEqual(self.client.get(download).status_code, 202)
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(queue.SceneMotionTask).count(), 2)
        self.assertEqual(self.clients['anonymous'].get(download).status_code, 401)

    def test_download_reports_failure_and_queue_backpressure(self):
        self.uploaded(set())
        download = self.route + '/1/download'
        with patch.object(fixture.main, 'enqueue_scene_motion',
                          lambda *a, **kw: queue.enqueue(*a, **kw, limit=0)):
            full = self.client.get(download)
        self.assertEqual((full.status_code, full.json()['status']), (202, 'deferred'))
        self.client.get(download)
        def fail(*args): raise RuntimeError('synthetic failure')
        with fixture.SessionLocal() as db:
            db.query(queue.SceneMotionTask).update({'attempts': 2})
            db.commit()
        with self.assertLogs('app.scene_motion_worker', level='ERROR'):
            self.worker(fail).run_one()
        failed = self.client.get(download)
        self.assertEqual((failed.status_code, failed.json()['status']), (202, 'failed'))
        self.assertIn('synthetic failure', failed.json()['detail'])

    def fineplay_payload(self):
        """FinePlay 전송 페이로드(G2) — 'mp4 포함'을 켜지 않은 기본 전송 그대로."""
        with fixture.SessionLocal() as db:
            clip, job = db.get(HighlightClip, 'scene-clip'), db.get(HighlightJob, 'scene-job')
            payload = fixture.main._build_clip_result_payload(
                db, [clip], job, our_side='home', labels={'home': 'H', 'away': 'A'},
                rid='fixture-request', team_id='fixture-team')
        return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':'))

    def test_fineplay_payload_is_unchanged_by_opening_or_downloading(self):
        # 앱은 sceneData 로 그린다 — 전송 페이로드는 mp4 유무·다운로드 여부와 무관해야 한다.
        self.uploaded(set())
        with patch('app.scene_motion.render_scene_data', side_effect=AssertionError('send render')):
            before = self.fineplay_payload()
            self.client.get(self.route)
            self.client.get(self.route + '/1/download')
            with fixture.SessionLocal() as db:
                key = db.query(queue.SceneMotionTask).one().object_key
            self.worker().run_one()
            self.uploaded({key})
            self.assertEqual(self.client.get(self.route + '/1/download').status_code, 200)
            after = self.fineplay_payload()
        self.assertEqual(before, after)
        action = json.loads(before)['clips'][0]['teamView']['actions'][0]
        self.assertTrue(action['sceneData']['players'])
        self.assertNotIn('sceneMotionKey', before)
        # 기준 해시 — origin/main(621eb52)에서 같은 픽스처로 뽑은 값과 같다(보고서 참조).
        self.assertEqual(hashlib.sha256(before.encode()).hexdigest(), PAYLOAD_SHA256)

    def test_sixty_clip_requests_and_login_stay_responsive_while_render_is_blocked(self):
        self.uploaded(set())
        self.client.get(self.route + '/1/download')  # 렌더 작업은 다운로드 요청만 만든다
        entered, release = threading.Event(), threading.Event()
        def slow_render(*args):
            entered.set()
            if not release.wait(15):
                raise AssertionError('Fixture render was not released')
        thread = threading.Thread(target=self.worker(slow_render).run_one)
        thread.start()
        self.assertTrue(entered.wait(2))
        async def requests():
            limiter = anyio.to_thread.current_default_thread_limiter()
            previous, limiter.total_tokens = limiter.total_tokens, 4
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=fixture.main.app),
                    base_url='http://testserver', cookies=self.client.cookies) as client:
                    for _ in range(10):
                        started = time.monotonic()
                        results = await asyncio.wait_for(asyncio.gather(
                            *[client.get(self.route) for _ in range(6)],
                            client.get('/health'), client.get('/api/session/me')), timeout=2)
                        self.assertLess(time.monotonic() - started, 2)
                        self.assertTrue(all(r.status_code == 200 for r in results))
                self.assertFalse(release.is_set())
            finally:
                limiter.total_tokens = previous
        try:
            asyncio.run(requests())
        finally:
            release.set(); thread.join(5)
        self.assertFalse(thread.is_alive())
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(queue.SceneMotionTask).count(), 1)
            self.assertEqual(db.query(queue.SceneMotionTask).one().status, 'completed')

    def test_fifo_single_worker_and_restart_recovery(self):
        first, second = self.submit('first'), self.submit('second')
        def interrupted(*args): raise RenderInterrupted()
        self.assertFalse(self.worker(interrupted).run_one())
        with fixture.SessionLocal() as db:
            self.assertEqual(db.get(queue.SceneMotionTask, first).status, 'running')
        calls = []
        def render(task_id, connection):
            calls.append(task_id)
            self.assertFalse(self.worker().run_one())
            # A renderer owns no request-scoped transaction; other queries work.
            with fixture.SessionLocal() as db:
                self.assertEqual(db.scalar(text('SELECT 1')), 1)
        replacement = self.worker(render)
        self.assertTrue(replacement.run_one()); self.assertTrue(replacement.run_one())
        self.assertFalse(replacement.run_one())
        self.assertEqual(calls, [first, second])
        with fixture.SessionLocal() as db:
            row = db.get(queue.SceneMotionTask, first)
            self.assertEqual(row.attempts, 2)
            self.assertEqual(row.scene_data, {})

    def test_bounded_admission_preserves_existing_jobs(self):
        one = self.submit('one', limit=2)
        self.submit('two', limit=2)
        self.assertIsNone(self.submit('three', limit=2))
        self.assertEqual(self.submit('one', limit=2), one)
        self.worker().run_one()
        self.assertIsNotNone(self.submit('three', limit=2))

    def test_failure_backoff_does_not_block_other_jobs_and_retries_are_bounded(self):
        first, second = self.submit('bad'), self.submit('good')
        def fail(*args): raise RuntimeError('synthetic failure')
        for attempt in range(3):
            with self.assertLogs('app.scene_motion_worker', level='ERROR'):
                self.worker(fail).run_one()
            if attempt == 0:
                self.worker().run_one()
                with fixture.SessionLocal() as db:
                    self.assertEqual(db.get(queue.SceneMotionTask, second).status, 'completed')
            with fixture.SessionLocal() as db:
                db.get(queue.SceneMotionTask, first).available_at = datetime.utcnow() - timedelta(seconds=1)
                db.commit()
        with fixture.SessionLocal() as db:
            task = db.get(queue.SceneMotionTask, first)
            self.assertEqual((task.status, task.attempts), ('failed', 3))
            task.finished_at = datetime.utcnow() - timedelta(seconds=61)
            db.commit()
        self.submit('bad')
        self.assertFalse(self.worker().run_one())
        self.submit('bad', retry=True)
        self.assertTrue(self.worker().run_one())

    def test_cached_upload_is_reused_after_worker_restart(self):
        task_id = self.submit()
        with fixture.SessionLocal() as db:
            db.get(queue.SceneMotionTask, task_id).status = 'running'
            db.commit()
        storage = Mock(); storage.region = None; storage.endpoint_url = None
        storage.exists.return_value = True
        with patch.object(worker_module, 'SessionLocal', fixture.SessionLocal), \
             patch('app.highlight_storage.S3Storage', return_value=storage), \
             patch('boto3.client'), patch('app.scene_motion_renderer.render_scene_data') as render:
            worker_module.render_job(task_id)
        render.assert_not_called(); storage.upload.assert_not_called()

    @unittest.skipUnless(fixture.engine.dialect.name == 'postgresql', 'PostgreSQL advisory lock contract')
    def test_postgres_busy_admission_and_duplicate_workers_return_immediately(self):
        self.submit('first')
        with fixture.engine.connect() as conn:
            conn.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': queue.ENQUEUE_LOCK})
            start = time.monotonic()
            self.assertIsNone(self.submit('second'))
            self.assertLess(time.monotonic() - start, 1)
            conn.rollback()
        with queue.exclusive_worker(fixture.engine) as owner:
            self.assertIsNotNone(owner)
            contender = SceneMotionWorker(fixture.SessionLocal, fixture.engine, render=lambda *args: None)
            self.assertFalse(contender.run_one())


if __name__ == '__main__':
    names = [name for name in SceneQueueTests.__dict__ if name.startswith('test_')]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(SceneQueueTests(name) for name in names))
    sys.exit(not result.wasSuccessful())
