"""Durable scene captures. HTTP requests enqueue; only the scene worker renders."""
from contextlib import contextmanager
from datetime import datetime, timedelta
import hashlib
import json
import os

from sqlalchemy import DateTime, Integer, JSON, String, Text, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base

WORKER_LOCK = 734210925
ENQUEUE_LOCK = 734210926
ACTIVE = ('queued', 'running')
MAX_PENDING = int(os.getenv('SCENE_RENDER_MAX_PENDING', '500'))


class SceneMotionTask(Base):
    __tablename__ = 'scene_motion_queue'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    bucket: Mapped[str] = mapped_column(String, nullable=False)
    object_key: Mapped[str] = mapped_column(Text, nullable=False)
    scene_data: Mapped[dict] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default='queued', index=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    available_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


def task_fingerprint(bucket, key):
    return hashlib.sha256(json.dumps([bucket, key]).encode()).hexdigest()


def find_task(db, bucket, key):
    return db.query(SceneMotionTask).populate_existing().filter_by(fingerprint=task_fingerprint(bucket, key)).first()


def enqueue(db, bucket, key, data, *, retry=False, missing=False, limit=MAX_PENDING):
    """Return an existing/new task, or None for backpressure. Never wait for a renderer.

    The caller commits once after enqueueing a clip. The short transaction lock
    bounds admission across API processes; a busy gate returns immediately.
    """
    task = find_task(db, bucket, key)
    now = datetime.utcnow()
    def retry_due(value):
        return value is not None and retry and (
            (missing and value.status == 'completed') or
            (value.status == 'failed' and value.finished_at is not None
             and value.finished_at <= now - timedelta(seconds=60)))
    if task is not None and not retry_due(task):
        return task
    if not bucket or len(json.dumps(data).encode()) > 256 * 1024:
        raise ValueError('Invalid scene render payload')
    if db.get_bind().dialect.name == 'postgresql':
        if not db.scalar(text('SELECT pg_try_advisory_xact_lock(:key)'), {'key': ENQUEUE_LOCK}):
            return None
        # Another request may have inserted the same scene before admission.
        task = find_task(db, bucket, key)
        if task is not None and not retry_due(task):
            return task
    if db.query(SceneMotionTask).filter(SceneMotionTask.status.in_(ACTIVE)).count() >= limit:
        return None
    if task is not None:
        task.status, task.attempts, task.error = 'queued', 0, None
        task.scene_data, task.available_at, task.finished_at = data, now, None
        db.flush()
        return task
    task = SceneMotionTask(fingerprint=task_fingerprint(bucket, key), bucket=bucket,
                           object_key=key, scene_data=data, status='queued', available_at=now)
    try:
        with db.begin_nested():
            db.add(task)
            db.flush()
    except IntegrityError:
        task = find_task(db, bucket, key)
        if task is None:
            raise
    return task


@contextmanager
def exclusive_worker(engine):
    with engine.connect() as conn:
        acquired = conn.scalar(text('SELECT pg_try_advisory_lock(:key)'), {'key': WORKER_LOCK})
        conn.commit()
        try:
            yield conn if acquired else None
        finally:
            if acquired:
                try:
                    conn.execute(text('SELECT pg_advisory_unlock(:key)'), {'key': WORKER_LOCK})
                    conn.commit()
                except Exception:
                    conn.invalidate()
