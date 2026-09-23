"""Durable FIFO for competition exports; one active export across API processes."""
import logging
import threading
from contextlib import contextmanager
from datetime import datetime
from sqlalchemy import Integer, String, DateTime, JSON, text
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import HighlightJob

logger = logging.getLogger(__name__)
LOCK_ID = 734210923


class CompetitionSend(Base):
    __tablename__ = 'competition_send_queue'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default='queued', index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


def enqueue(db, job_id, payload):
    # Lock the existing job even when there is not yet a queue row. This makes
    # simultaneous requests for the same job coalesce without a check/insert race.
    job = db.query(HighlightJob).filter_by(id=job_id).populate_existing().with_for_update().one()
    existing = db.query(CompetitionSend).filter(
        CompetitionSend.job_id == job_id,
        CompetitionSend.status.in_(['queued', 'running']),
    ).first()
    if existing:
        status = 'sending' if existing.status == 'running' else 'queued'
        db.commit()
        return status
    db.add(CompetitionSend(job_id=job_id, payload=payload, status='queued'))
    job.job_metadata = {**(job.job_metadata or {}), 'competition_callback_status': 'queued'}
    db.commit()
    return 'queued'


@contextmanager
def exclusive_worker(engine):
    # Session lock survives commits, but is released on process/connection loss.
    # Never return a locked connection to the pool.
    with engine.connect() as conn:
        acquired = conn.execute(text('SELECT pg_try_advisory_lock(:key)'), {'key': LOCK_ID}).scalar()
        conn.commit()
        try:
            yield bool(acquired)
        finally:
            if acquired:
                try:
                    conn.execute(text('SELECT pg_advisory_unlock(:key)'), {'key': LOCK_ID})
                    conn.commit()
                except Exception:
                    conn.invalidate()
                    raise


class CompetitionSendWorker:
    def __init__(self, session_factory, engine, send, lock=None):
        self.sessions, self.engine, self.send = session_factory, engine, send
        self.lock = lock or (lambda: exclusive_worker(engine))
        self.stop = threading.Event()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.run, name='competition-send-queue', daemon=True)
        self.thread.start()

    def close(self):
        # Do not claim another job during shutdown. A killed active job remains
        # running in the DB and is retried first on restart (same remote match key).
        self.stop.set()

    def run(self):
        while not self.stop.is_set():
            try:
                worked = self.run_one()
            except Exception:
                logger.exception('Competition queue worker failed')
                worked = False
            if not worked:
                self.stop.wait(2)

    def run_one(self):
        with self.lock() as acquired:
            if not acquired or self.stop.is_set():
                return False
            with self.sessions() as db:
                row = db.query(CompetitionSend).filter(
                    CompetitionSend.status.in_(['queued', 'running'])
                ).order_by(CompetitionSend.id).first()
                if row is None:
                    return False
                queue_id, job_id, payload = row.id, row.job_id, dict(row.payload)
                row.status = 'running'
                job = db.query(HighlightJob).filter_by(id=job_id).with_for_update().first()
                if job:
                    job.job_metadata = {**(job.job_metadata or {}), 'competition_callback_status': 'sending'}
                db.commit()
            # Waiting jobs hold no sessions, and the claim transaction is closed
            # before rendering. Only this one callback can render/send at a time.
            failed = False
            try:
                self.send(**payload)
            except Exception:
                failed = True
                logger.exception('Competition export failed for queue item %s', queue_id)
            with self.sessions() as db:
                row = db.get(CompetitionSend, queue_id)
                row.status = 'failed' if failed else 'completed'
                row.finished_at = datetime.utcnow()
                if failed:
                    job = db.query(HighlightJob).filter_by(id=job_id).with_for_update().first()
                    if job:
                        job.job_metadata = {**(job.job_metadata or {}), 'competition_callback_status': 'failed: 전송 작업 오류. 다시 시도해 주세요.'}
                db.commit()
            return True
