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


def cancel(db, job_id):
    """이 잡의 대기·진행 중 전송을 취소한다.

    거절당하거나 서버가 죽어 상태가 'sending' 에 박히면 화면의 전송 버튼이 영영
    잠긴다 — 사람이 손으로 풀 수 있어야 한다. 이미 끝난 것은 건드리지 않는다.

    진행 중인 것을 취소해도 돌고 있는 일 자체는 멈추지 않는다. 다만 그 결과가
    **취소한 상태를 덮어쓰지는 않는다**(run_one 이 취소된 행을 보고 비켜선다).
    """
    job = db.query(HighlightJob).filter_by(id=job_id).populate_existing().with_for_update().one()
    rows = db.query(CompetitionSend).filter(
        CompetitionSend.job_id == job_id,
        CompetitionSend.status.in_(['queued', 'running']),
    ).all()
    for row in rows:
        row.status = 'canceled'
        row.finished_at = datetime.utcnow()
    job.job_metadata = {
        **(job.job_metadata or {}),
        'competition_callback_status': 'canceled: 전송을 취소했습니다 — 다시 보낼 수 있습니다',
    }
    db.commit()
    return len(rows)


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
                if row.status == 'canceled':
                    # 도중에 사람이 취소했다. 결과로 그 상태를 덮어쓰지 않는다 —
                    # 취소해 놓고 화면이 다시 '처리 중' 으로 돌아가면 풀 방법이 없다.
                    row.finished_at = datetime.utcnow()
                    db.commit()
                    return True
                row.status = 'failed' if failed else 'completed'
                row.finished_at = datetime.utcnow()
                if failed:
                    job = db.query(HighlightJob).filter_by(id=job_id).with_for_update().first()
                    if job:
                        job.job_metadata = {**(job.job_metadata or {}), 'competition_callback_status': 'failed: 전송 작업 오류. 다시 시도해 주세요.'}
                db.commit()
            return True
