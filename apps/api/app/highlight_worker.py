from __future__ import annotations

import logging
import os
import signal
import time
from datetime import datetime

from .db import Base, SessionLocal, engine
from .highlight_jobs import ensure_highlight_runtime_dirs, run_analysis_for_job
from .highlight_pipeline import load_models
from .models import HighlightJob

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("highlight_worker")

YOLO_MODEL_PATH = os.getenv("YOLO_MODEL_PATH", "/app/models/best-8.pt")
XGB_MODEL_PATH = os.getenv("XGB_MODEL_PATH", "/app/models/highlight_model.xgb")
POLL_SECONDS = float(os.getenv("HIGHLIGHT_WORKER_POLL_SECONDS", "5"))

_stop = False


def _request_stop(_signum: int, _frame: object) -> None:
    global _stop
    _stop = True


def _claim_next_job() -> str | None:
    db = SessionLocal()
    try:
        job = (
            db.query(HighlightJob)
            .filter(HighlightJob.status == "queued")
            .order_by(HighlightJob.created_at)
            .with_for_update(skip_locked=True)
            .first()
        )
        if not job:
            return None
        job.status = "processing"
        job.error_message = None
        job.updated_at = datetime.utcnow()
        db.commit()
        logger.info("Claimed highlight job %s", job.id)
        return job.id
    except Exception:
        db.rollback()
        logger.exception("Failed to claim highlight job")
        return None
    finally:
        db.close()


def main() -> None:
    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    Base.metadata.create_all(bind=engine)
    ensure_highlight_runtime_dirs()
    logger.info("Loading highlight models")
    yolo_model, xgb_model = load_models(YOLO_MODEL_PATH, XGB_MODEL_PATH)
    logger.info("Highlight worker ready")

    while not _stop:
        job_id = _claim_next_job()
        if not job_id:
            time.sleep(POLL_SECONDS)
            continue
        run_analysis_for_job(job_id, yolo_model, xgb_model)

    logger.info("Highlight worker stopped")


if __name__ == "__main__":
    main()
