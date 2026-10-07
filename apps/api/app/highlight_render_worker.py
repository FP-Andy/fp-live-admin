"""One render subprocess at a time; API restarts do not interrupt this service."""
import logging
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path
from datetime import datetime

from sqlalchemy import text

from .db import SessionLocal, engine
from .highlight_render_queue import ACTIVE, HighlightRenderTask, exclusive_worker, lock_job
from .models import HighlightJob

logger = logging.getLogger(__name__)


class RenderInterrupted(Exception):
    pass


def terminate_group(child):
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    except ProcessLookupError:
        child.wait()


class HighlightRenderWorker:
    def __init__(self, sessions=SessionLocal, db_engine=engine, lock=None, render=None):
        self.sessions = sessions
        self.lock = lock or (lambda: exclusive_worker(db_engine))
        self.render = render or self.run_child
        self.stop = threading.Event()

    def run_child(self, queue_id, connection):
        child = subprocess.Popen([sys.executable, '-m', 'app.highlight_render_worker', '--job', str(queue_id)],
                                 start_new_session=True)
        try:
            while child.poll() is None:
                Path('/tmp/highlight-render-heartbeat').touch()
                if self.stop.wait(1):
                    raise RenderInterrupted('worker shutdown')
                # Check lock ownership through the original connection, never
                # through a fresh/reconnected pool connection.
                connection.execute(text('SELECT 1'))
                connection.commit()
            if child.returncode != 0:
                raise RuntimeError(f'영상 처리 프로세스가 종료됐습니다 ({child.returncode}). 다시 시도해 주세요.')
        finally:
            if child.poll() is None:
                terminate_group(child)

    def run_one(self):
        with self.lock() as connection:
            if not connection or self.stop.is_set():
                return False
            with self.sessions() as db:
                task = db.query(HighlightRenderTask).filter(
                    HighlightRenderTask.status.in_(ACTIVE)).order_by(HighlightRenderTask.id).first()
                if not task:
                    return False
                job = db.get(HighlightJob, task.job_id)
                if not job:
                    task.status, task.error = 'failed', '원본 작업을 찾을 수 없습니다.'
                    task.finished_at = datetime.utcnow()
                    db.commit()
                    return True
                if task.status == 'running' and job.status == 'done':
                    task.status, task.finished_at = 'completed', datetime.utcnow()
                    db.commit()
                    return True
                if task.attempts >= 3:
                    task.status, task.error = 'failed', '반복 중단된 작업입니다. 원본과 설정을 확인한 뒤 다시 요청하세요.'
                    task.finished_at = datetime.utcnow()
                    job.status, job.error_message = 'error', task.error
                    db.commit()
                    return True
                task.status = 'running'
                task.started_at = datetime.utcnow()
                task.attempts += 1
                job.status, job.error_message = 'merging', None
                job.updated_at = datetime.utcnow()
                job.job_metadata = {**(job.job_metadata or {}), 'progress': {
                    'phase': 'merging', 'percent': 0, 'detail': '합치기 시작',
                    'updated_at': datetime.utcnow().isoformat()}}
                queue_id, job_id = task.id, task.job_id
                db.commit()
            error = None
            try:
                self.render(queue_id, connection)
            except RenderInterrupted:
                # Leave the durable claim for the next worker to recover.
                return False
            except Exception as exc:
                logger.exception('Render task %s failed', queue_id)
                error = str(exc)[:500]
            with self.sessions() as db:
                task = db.get(HighlightRenderTask, queue_id)
                job = lock_job(db, job_id)
                if error or job.status != 'done':
                    task.status = 'failed'
                    task.error = error or job.error_message or '합치기가 완료되지 않았습니다. 다시 요청하세요.'
                    job.status, job.error_message = 'error', task.error
                else:
                    task.status = 'completed'
                task.finished_at = datetime.utcnow()
                db.commit()
            return True

    def run(self):
        while not self.stop.is_set():
            Path('/tmp/highlight-render-heartbeat').touch()
            try:
                worked = self.run_one()
            except Exception:
                logger.exception('Highlight render queue unavailable; retrying')
                worked = False
            if not worked:
                self.stop.wait(2)


def render_job(queue_id):
    from .highlight_jobs import (merge_manual_clips_for_job, merge_clips_for_job,
                                 run_fineplay_produce, run_produce_job)
    with SessionLocal() as db:
        task = db.get(HighlightRenderTask, queue_id)
        if not task or task.status != 'running':
            raise RuntimeError('합치기 작업의 실행 권한이 없습니다.')
        kind, job_id = task.kind, task.job_id
    {'manual': merge_manual_clips_for_job, 'operator': merge_clips_for_job,
     'fineplay': run_fineplay_produce, 'produce_s3': run_produce_job}[kind](job_id)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) == 3 and sys.argv[1] == '--job':
        render_job(int(sys.argv[2]))
    else:
        HighlightRenderTask.__table__.create(engine, checkfirst=True)
        worker = HighlightRenderWorker()
        signal.signal(signal.SIGTERM, lambda *_: worker.stop.set())
        signal.signal(signal.SIGINT, lambda *_: worker.stop.set())
        worker.run()
