"""Real authenticated API, durable recovery and isolated scene worker contracts."""
import asyncio
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

    def test_get_enqueues_without_storage_or_render_and_deduplicates(self):
        with patch('app.scene_motion.render_scene_data', side_effect=AssertionError('HTTP capture')):
            for _ in range(3):
                response = self.client.get(self.route)
                self.assertEqual(response.status_code, 200, response.text)
                motion = response.json()['motions'][0]
                self.assertTrue(motion['sceneData']['players'])
                self.assertEqual(motion['render_status'], 'queued')
                self.assertIsNone(motion['url'])
        self.storage.exists.assert_not_called()
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(queue.SceneMotionTask).count(), 1)
        self.worker().run_one()
        ready = self.client.get(self.route).json()['motions'][0]
        self.assertEqual(ready['render_status'], 'completed')
        self.assertTrue(ready['url'].startswith('https://fixture.invalid/prefix/scene-motion/'))
        with fixture.SessionLocal() as db:
            action = db.get(HighlightClipAction, 1)
            action.extra = {'sceneState': {**STATE, 'beforeDots': [{**STATE['beforeDots'][0], 'x': 25}]}}
            db.commit()
        changed = self.client.get(self.route).json()['motions'][0]
        self.assertIsNone(changed['url'])
        self.assertEqual(changed['render_status'], 'queued')
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(queue.SceneMotionTask).count(), 2)
        self.assertEqual(self.clients['anonymous'].get(self.route).status_code, 401)

    def test_sixty_clip_requests_and_login_stay_responsive_while_render_is_blocked(self):
        self.client.get(self.route)
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
