"""Isolated, single-consumer scene rendering with crash recovery and bounded retries."""
from datetime import datetime, timedelta
import logging
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time

from sqlalchemy import or_, text

from .db import SessionLocal, engine
from .highlight_render_worker import RenderInterrupted, terminate_group
from .scene_motion_queue import SceneMotionTask, exclusive_worker

logger = logging.getLogger(__name__)
HEARTBEAT = Path('/tmp/scene-render-heartbeat')


class SceneMotionWorker:
    def __init__(self, sessions=SessionLocal, db_engine=engine, *, lock=None, render=None):
        self.sessions = sessions
        self.lock = lock or (lambda: exclusive_worker(db_engine))
        self.render = render or self.run_child
        self.stop = threading.Event()

    def run_child(self, task_id, connection):
        child = subprocess.Popen([sys.executable, '-m', 'app.scene_motion_worker', '--job', str(task_id)],
                                 start_new_session=True)
        deadline = time.monotonic() + 300
        try:
            while child.poll() is None:
                HEARTBEAT.touch()
                if self.stop.wait(1):
                    raise RenderInterrupted('scene worker shutdown')
                if time.monotonic() >= deadline:
                    raise RuntimeError('Scene render exceeded five minutes')
                # Losing this connection means losing the singleton lock. Stop
                # the child before allowing a replacement worker to proceed.
                connection.execute(text('SELECT 1'))
                connection.commit()
            if child.returncode:
                raise RuntimeError(f'Scene render subprocess exited ({child.returncode})')
        finally:
            if child.poll() is None:
                terminate_group(child)

    def run_one(self):
        with self.lock() as connection:
            if not connection or self.stop.is_set():
                return False
            with self.sessions() as db:
                task = db.query(SceneMotionTask).filter(or_(
                    SceneMotionTask.status == 'running',
                    (SceneMotionTask.status == 'queued') & (SceneMotionTask.available_at <= datetime.utcnow()),
                )).order_by(SceneMotionTask.id).first()
                if task is None:
                    return False
                if task.attempts >= 3:
                    task.status, task.finished_at = 'failed', datetime.utcnow()
                    task.error = '씬모션 제작이 반복 중단됐습니다. 다운로드에서 다시 요청해 주세요.'
                    db.commit()
                    return True
                task.status, task.started_at = 'running', datetime.utcnow()
                task.attempts += 1
                task_id = task.id
                db.commit()
            # No request/session connection is held while capturing or uploading.
            error = None
            try:
                self.render(task_id, connection)
            except RenderInterrupted:
                return False  # The next worker recovers this durable claim.
            except Exception as exc:
                logger.exception('Scene task %s failed', task_id)
                error = str(exc)[:500]
            with self.sessions() as db:
                task = db.get(SceneMotionTask, task_id)
                if error:
                    task.status = 'failed' if task.attempts >= 3 else 'queued'
                    task.error = error
                    task.available_at = datetime.utcnow() + timedelta(seconds=15 * task.attempts)
                    if task.status == 'failed':
                        task.finished_at = datetime.utcnow()
                else:
                    task.status, task.error, task.finished_at = 'completed', None, datetime.utcnow()
                    task.scene_data = {}  # Retain the cache index, not every historic scene payload.
                db.commit()
            return True

    def run(self):
        while not self.stop.is_set():
            HEARTBEAT.touch()
            try:
                worked = self.run_one()
            except Exception:
                logger.exception('Scene queue unavailable; retrying')
                worked = False
            if not worked:
                self.stop.wait(2)


def render_job(task_id):
    import boto3
    from botocore.config import Config
    from .highlight_storage import S3Storage
    from .scene_motion_renderer import render_scene_data

    with SessionLocal() as db:
        task = db.get(SceneMotionTask, task_id)
        if task is None or task.status != 'running':
            raise RuntimeError('Scene render claim is no longer valid')
        bucket, key, data = task.bucket, task.object_key, task.scene_data
    storage = S3Storage(bucket=bucket)
    storage._client_obj = boto3.client('s3', region_name=storage.region,
        endpoint_url=storage.endpoint_url,
        config=Config(connect_timeout=5, read_timeout=20, retries={'max_attempts': 2}))
    if storage.exists(key):
        return  # Cached files, including a completed upload before a worker crash.
    with tempfile.TemporaryDirectory(prefix='scene-render-') as directory:
        output = Path(directory) / 'scene.mp4'
        render_scene_data(data, output)
        storage.upload(output, key, content_type='video/mp4')
        if not storage.exists(key):
            raise RuntimeError('Scene upload could not be verified')


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) == 3 and sys.argv[1] == '--job':
        render_job(int(sys.argv[2]))
    else:
        worker = SceneMotionWorker()
        signal.signal(signal.SIGTERM, lambda *_: worker.stop.set())
        signal.signal(signal.SIGINT, lambda *_: worker.stop.set())
        worker.run()
