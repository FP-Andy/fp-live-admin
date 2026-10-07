"""Durable, shared FIFO for CPU highlight renders, independent of HTTP workers."""
from contextlib import contextmanager
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .models import HighlightJob

LOCK_ID = 734210924
ACTIVE = ('queued', 'running')
KINDS = {'manual': 'manual', 'fineplay': 'fineplay', 'produce_s3': 'produce_s3', 'operator': 'operator'}


class HighlightRenderTask(Base):
    __tablename__ = 'highlight_render_queue'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default='queued', index=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    __table_args__ = (Index('uq_highlight_render_active_job', 'job_id', unique=True,
                           postgresql_where=text("status IN ('queued', 'running')"),
                           sqlite_where=text("status IN ('queued', 'running')")),)


def active_task(db, job_id):
    return db.query(HighlightRenderTask).filter(
        HighlightRenderTask.job_id == job_id, HighlightRenderTask.status.in_(ACTIVE)).first()


def describe(db, task):
    ahead = db.query(HighlightRenderTask).filter(
        HighlightRenderTask.status.in_(ACTIVE), HighlightRenderTask.id < task.id).count()
    return {'queue_id': task.id, 'status': task.status, 'position': ahead + 1,
            'waiting_ahead': ahead, 'job_id': task.job_id}


def lock_job(db, job_id):
    return db.query(HighlightJob).filter_by(id=job_id).populate_existing().with_for_update().one()


def ensure_editable(db, job):
    from fastapi import HTTPException
    locked = lock_job(db, job.id)
    if active_task(db, job.id) or locked.status in ('merging', 'processing'):
        raise HTTPException(status_code=409, detail='합치기 대기 또는 진행 중입니다. 완료 후 수정하거나 새 작업을 만들어 주세요.')
    return locked


def attach_queue_status(db, rows):
    tasks = db.query(HighlightRenderTask).filter(HighlightRenderTask.status.in_(ACTIVE)).order_by(HighlightRenderTask.id).all()
    by_job = {task.job_id: {'queue_id': task.id, 'status': task.status, 'position': i + 1,
                           'waiting_ahead': i} for i, task in enumerate(tasks)}
    for row in rows:
        row['render_queue'] = by_job.get(row['id'])
    return rows


def enqueue(db, job_id, kind):
    # SessionLocal disables autoflush. Keep the request's staged render options
    # before populate_existing refreshes the row under its transaction lock.
    db.flush()
    job = lock_job(db, job_id)
    if kind not in KINDS or job.mode != KINDS[kind]:
        raise ValueError('작업 종류가 합치기 요청과 일치하지 않습니다.')
    existing = active_task(db, job_id)
    if existing:
        result = describe(db, existing)
        db.commit()
        return result
    task = HighlightRenderTask(job_id=job_id, kind=kind, status='queued')
    db.add(task)
    job.status = 'render_queued'
    job.error_message = None
    job.updated_at = datetime.utcnow()
    job.job_metadata = {**(job.job_metadata or {}), 'progress': {
        'phase': 'queued', 'percent': 0, 'detail': '합치기 대기 중',
        'updated_at': datetime.utcnow().isoformat()}}
    db.flush()
    result = describe(db, task)
    db.commit()
    return result


@contextmanager
def exclusive_worker(engine):
    # A dedicated connection holds the lock until the child and its encoders
    # exit. The worker probes this connection while rendering and kills its
    # process group on connection loss, before attempting any further claim.
    with engine.connect() as conn:
        acquired = conn.execute(text('SELECT pg_try_advisory_lock(:key)'), {'key': LOCK_ID}).scalar()
        conn.commit()
        try:
            yield conn if acquired else None
        finally:
            if acquired:
                try:
                    conn.execute(text('SELECT pg_advisory_unlock(:key)'), {'key': LOCK_ID})
                    conn.commit()
                except Exception:
                    conn.invalidate()
