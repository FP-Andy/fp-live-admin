from __future__ import annotations

import logging
import os
import signal
import time
from datetime import datetime
from pathlib import Path

from .db import Base, SessionLocal, engine
from .broadcast_overlay_jobs import run_broadcast_overlay_render
from .highlight_jobs import ensure_highlight_runtime_dirs, run_analysis_for_job
from .highlight_pipeline import load_models
from .models import BroadcastOverlayProject, HighlightJob

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
            # Operator jobs are handled inline by the API (link download +
            # manual ffmpeg clip cutting), not the AI analysis worker.
            .filter(HighlightJob.mode != "operator")
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


def _claim_next_broadcast_overlay() -> str | None:
    """Claim offline recorded-video work before taking another AI analysis."""
    db = SessionLocal()
    try:
        project = (
            db.query(BroadcastOverlayProject)
            .filter(BroadcastOverlayProject.status == "queued")
            .order_by(BroadcastOverlayProject.created_at)
            .with_for_update(skip_locked=True)
            .first()
        )
        if not project:
            return None
        project.status = "rendering"
        project.error_message = None
        project.updated_at = datetime.utcnow()
        db.commit()
        logger.info("Claimed Broadcast overlay project %s", project.id)
        return str(project.id)
    except Exception:
        db.rollback()
        logger.exception("Failed to claim Broadcast overlay project")
        return None
    finally:
        db.close()


def main() -> None:
    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    Base.metadata.create_all(bind=engine)
    ensure_highlight_runtime_dirs()
    # Recorded Broadcast overlays are rendered with FFmpeg only.  Do not make
    # that workflow unavailable merely because the optional AI highlight model
    # volume is not mounted on a worker.  The AI models are loaded lazily when
    # an ordinary highlight-analysis job is actually waiting.
    yolo_model = None
    xgb_model = None
    model_volume_warning_logged = False
    logger.info("Highlight worker ready (Broadcast overlay renderer available)")

    while not _stop:
        overlay_project_id = _claim_next_broadcast_overlay()
        if overlay_project_id:
            run_broadcast_overlay_render(overlay_project_id)
            continue

        if yolo_model is None or xgb_model is None:
            if not Path(YOLO_MODEL_PATH).is_file() or not Path(XGB_MODEL_PATH).is_file():
                if not model_volume_warning_logged:
                    logger.warning(
                        "AI highlight models are not mounted; continuing to process Broadcast overlays"
                    )
                    model_volume_warning_logged = True
                time.sleep(POLL_SECONDS)
                continue
            logger.info("Loading highlight models")
            yolo_model, xgb_model = load_models(YOLO_MODEL_PATH, XGB_MODEL_PATH)
            logger.info("AI highlight models ready")

        job_id = _claim_next_job()
        if not job_id:
            time.sleep(POLL_SECONDS)
            continue
        run_analysis_for_job(job_id, yolo_model, xgb_model)

    logger.info("Highlight worker stopped")


if __name__ == "__main__":
    main()
