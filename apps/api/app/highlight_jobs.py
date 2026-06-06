from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import HighlightJob

HIGHLIGHT_RUNTIME_DIR = Path(os.getenv("HIGHLIGHT_RUNTIME_DIR", "/app/runtime/highlight")).resolve()
DELETE_UPLOAD_AFTER_SUCCESS = os.getenv("HIGHLIGHT_DELETE_UPLOAD_AFTER_SUCCESS", "1") not in {"0", "false", "False"}


class NpEncoder(json.JSONEncoder):
    def default(self, o: object) -> object:
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        return super().default(o)


def ensure_highlight_runtime_dirs() -> None:
    (HIGHLIGHT_RUNTIME_DIR / "uploads").mkdir(parents=True, exist_ok=True)
    (HIGHLIGHT_RUNTIME_DIR / "jobs").mkdir(parents=True, exist_ok=True)
    (HIGHLIGHT_RUNTIME_DIR / "exports").mkdir(parents=True, exist_ok=True)


def job_dir(job_id: str) -> Path:
    return HIGHLIGHT_RUNTIME_DIR / "jobs" / job_id


def clips_dir(job_id: str) -> Path:
    return job_dir(job_id) / "clips"


def exports_dir() -> Path:
    path = HIGHLIGHT_RUNTIME_DIR / "exports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def upload_dir() -> Path:
    path = HIGHLIGHT_RUNTIME_DIR / "uploads"
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_clip_path(job_id: str, clip_name: str) -> Path:
    if Path(clip_name).name != clip_name:
        raise ValueError("Invalid clip name")
    return clips_dir(job_id) / clip_name


def update_job(db: Session, job_id: str, **kwargs: object) -> HighlightJob | None:
    job = db.get(HighlightJob, job_id)
    if not job:
        return None
    for key, value in kwargs.items():
        setattr(job, key, value)
    job.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(job)
    return job


def serialize_job(job: HighlightJob) -> dict[str, Any]:
    metadata = job.job_metadata if isinstance(job.job_metadata, dict) else {}
    progress = metadata.get("progress")
    progress_percent = None
    stage = None
    if isinstance(progress, dict):
        progress_percent = progress.get("percent")
        stage = progress.get("detail") or progress.get("phase")
    elif isinstance(progress, (int, float)):
        progress_percent = progress
    return {
        "id": job.id,
        "status": job.status,
        "mode": job.mode,
        "original_filename": job.original_filename,
        "display_name": metadata.get("display_name"),
        "export_path": job.export_path,
        "error_message": job.error_message,
        "job_metadata": metadata,
        "progress": progress_percent,
        "stage": stage,
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat(),
    }


def _json_safe(value: dict[str, Any]) -> dict[str, Any]:
    return json.loads(json.dumps(value, cls=NpEncoder))


def _progress_payload(phase: str, percent: int, detail: str | None = None) -> dict[str, Any]:
    return {
        "phase": phase,
        "percent": max(0, min(int(percent), 100)),
        "detail": detail or "",
        "updated_at": datetime.utcnow().isoformat(),
    }


def _update_progress(db: Session, job: HighlightJob, phase: str, percent: int, detail: str | None = None) -> None:
    metadata = dict(job.job_metadata or {})
    metadata["progress"] = _progress_payload(phase, percent, detail)
    updated = update_job(db, job.id, job_metadata=_json_safe(metadata))
    if updated:
        job.job_metadata = updated.job_metadata


def _delete_upload(video_path: str) -> None:
    if not DELETE_UPLOAD_AFTER_SUCCESS:
        return
    try:
        Path(video_path).unlink(missing_ok=True)
    except Exception:
        pass


def probe_video_dimensions(path: Path) -> tuple[int, int]:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=s=x:p=0",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        width_raw, height_raw = result.stdout.strip().split("x")
        return int(width_raw), int(height_raw)
    except Exception:
        return 0, 0


def make_playback_proxy(src: Path, out: Path, target_h: int = 720) -> bool:
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(src),
                "-vf",
                f"scale=-2:{target_h}",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "28",
                "-an",
                "-movflags",
                "+faststart",
                str(out),
            ],
            check=True,
            capture_output=True,
        )
        return out.exists()
    except Exception:
        return False


def create_player_proxy_for_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(HighlightJob, job_id)
        if not job or job.mode != "player" or not job.upload_path:
            return
        src = Path(job.upload_path)
        if not src.exists():
            metadata = dict(job.job_metadata or {})
            metadata["proxy_status"] = "error"
            update_job(db, job_id, job_metadata=_json_safe(metadata))
            return
        width, height = probe_video_dimensions(src)
        ok = make_playback_proxy(src, job_dir(job_id) / "proxy.mp4")
        job = db.get(HighlightJob, job_id)
        if not job:
            return
        metadata = dict(job.job_metadata or {})
        metadata.update({
            "video_w": width or metadata.get("video_w", 0),
            "video_h": height or metadata.get("video_h", 0),
            "proxy_file": "proxy.mp4" if ok else None,
            "proxy_status": "done" if ok else "error",
        })
        update_job(db, job_id, job_metadata=_json_safe(metadata))
    finally:
        db.close()


def run_analysis_for_job(job_id: str, yolo_model: object, xgb_model: object | None = None) -> None:
    db = SessionLocal()
    try:
        job = db.get(HighlightJob, job_id)
        if not job:
            return
        update_job(
            db,
            job_id,
            status="processing",
            error_message=None,
            job_metadata=_json_safe({
                **(job.job_metadata or {}),
                "progress": _progress_payload("starting", 1, "작업 준비 중"),
            }),
        )

        if yolo_model is None:
            update_job(db, job_id, status="error", error_message="YOLO 모델이 로드되지 않았습니다.")
            return
        if not job.upload_path or not Path(job.upload_path).exists():
            update_job(db, job_id, status="error", error_message="업로드된 영상 파일을 찾을 수 없습니다.")
            return

        metadata = job.job_metadata or {}
        highlight_count = int(metadata.get("highlight_count", 40))
        if job.mode == "player":
            _run_player_detection(db, job, yolo_model)
        elif job.mode == "log_ai":
            _run_log_analysis(db, job, yolo_model, xgb_model, highlight_count)
        else:
            _run_ai_analysis(db, job, yolo_model, xgb_model, highlight_count)
    except Exception as exc:
        update_job(db, job_id, status="error", error_message=str(exc))
    finally:
        db.close()


def _run_player_detection(db: Session, job: HighlightJob, yolo_model: object) -> None:
    import pandas as pd

    from .player_clip_extract import compute_possession_events, run_player_detection

    if not job.upload_path:
        update_job(db, job.id, status="error", error_message="업로드된 영상 파일을 찾을 수 없습니다.")
        return

    src = Path(job.upload_path)
    out_dir = job_dir(job.id)
    out_dir.mkdir(parents=True, exist_ok=True)

    result = run_player_detection(
        str(src),
        str(out_dir),
        yolo_model,
        progress_cb=lambda percent, stage: _update_progress(db, job, "detecting_player", percent, stage),
    )
    if not result.success:
        update_job(db, job.id, status="error", error_message=result.message)
        return

    det_df = pd.read_csv(out_dir / result.detection_file)
    events = compute_possession_events(det_df, result.fps)
    width, height = probe_video_dimensions(src)
    proxy_file = None
    if height > 720:
        _update_progress(db, job, "creating_proxy", 98, "재생 프록시 생성 중")
        if make_playback_proxy(src, out_dir / "proxy.mp4"):
            proxy_file = "proxy.mp4"

    metadata = {
        **(job.job_metadata or {}),
        "mode": "player",
        "fps": result.fps,
        "detection_file": result.detection_file,
        "video_file": src.name,
        "n_frames": result.n_frames,
        "n_player_tracks": result.n_player_tracks,
        "video_w": width,
        "video_h": height,
        "proxy_file": proxy_file,
        "proxy_status": "done" if proxy_file else None,
        "events": events,
        "clips": [],
        "selected": {},
        "message": result.message,
        "progress": _progress_payload("done", 100, "개인클립 탐지 완료"),
    }
    update_job(
        db,
        job.id,
        status="done",
        clips_dir=str(clips_dir(job.id)),
        job_metadata=_json_safe(metadata),
    )


def _run_ai_analysis(
    db: Session,
    job: HighlightJob,
    yolo_model: object,
    xgb_model: object | None,
    highlight_count: int,
) -> None:
    from .highlight_pipeline import CLIP_DURATION_AFTER, CLIP_DURATION_BEFORE, run_highlight_pipeline

    out_dir = str(clips_dir(job.id))
    result = run_highlight_pipeline(
        video_path=str(job.upload_path),
        output_dir=out_dir,
        yolo_model=yolo_model,
        xgb_model=xgb_model,
        highlight_count=highlight_count,
        progress_callback=lambda payload: _update_progress(
            db,
            job,
            str(payload.get("phase") or "processing"),
            int(payload.get("percent") or 0),
            str(payload.get("detail") or ""),
        ),
    )

    if not result.success:
        update_job(db, job.id, status="error", error_message=result.message)
        return

    fps_val = float(result.fps or 30.0)
    clip_files = [Path(p).name for p in (result.clip_paths or [])]
    clip_scores_by_name: dict[str, float] = {}
    clip_features_by_name: dict[str, str] = {}
    clip_feature_stats_by_name: dict[str, dict] = {}
    clip_timestamps: dict[str, dict] = {}

    frames = result.highlight_frames or []
    feats = result.clip_features or []
    feat_stats = result.clip_feature_stats or {}
    scores = result.clip_scores or {}

    for i, name in enumerate(clip_files):
        frame = frames[i] if i < len(frames) else None
        if frame is not None:
            anchor_sec = frame / fps_val
            clip_timestamps[name] = {
                "start": round(max(0.0, anchor_sec - CLIP_DURATION_BEFORE), 1),
                "end": round(anchor_sec + CLIP_DURATION_AFTER, 1),
            }
            clip_scores_by_name[name] = scores.get(frame, 0.0)
            if frame in feat_stats:
                clip_feature_stats_by_name[name] = feat_stats[frame]
        if i < len(feats):
            clip_features_by_name[name] = feats[i]

    metadata = {
        **(job.job_metadata or {}),
        "progress": _progress_payload("done", 100, "하이라이트 추출 완료"),
        "clips": clip_files,
        "selected": {},
        "clip_scores": clip_scores_by_name,
        "clip_features": clip_features_by_name,
        "clip_feature_stats": clip_feature_stats_by_name,
        "clip_timestamps": clip_timestamps,
        "message": result.message,
    }
    _delete_upload(str(job.upload_path))
    update_job(db, job.id, status="done", upload_path=None, clips_dir=out_dir, job_metadata=_json_safe(metadata))


def _run_log_analysis(
    db: Session,
    job: HighlightJob,
    yolo_model: object,
    xgb_model: object | None,
    highlight_count: int,
) -> None:
    from .highlight_pipeline import (
        CLIP_DURATION_AFTER,
        CLIP_DURATION_BEFORE,
        LOG_CLIP_AFTER,
        LOG_CLIP_BEFORE,
        LOG_CLIP_MINUTE_SPAN,
        run_log_pipeline,
    )

    metadata = job.job_metadata or {}
    out_dir = str(clips_dir(job.id))
    result = run_log_pipeline(
        video_path=str(job.upload_path),
        log_data=metadata.get("log_data", []),
        second_half_start_sec=float(metadata.get("second_half_start_sec", 0.0)),
        output_dir=out_dir,
        target_count=highlight_count,
        yolo_model=yolo_model,
        xgb_model=xgb_model,
        progress_callback=lambda payload: _update_progress(
            db,
            job,
            str(payload.get("phase") or "processing"),
            int(payload.get("percent") or 0),
            str(payload.get("detail") or ""),
        ),
    )

    if not result.success:
        update_job(db, job.id, status="error", error_message=result.message)
        return

    fps_val = float(result.fps or 30.0)
    clip_files = [Path(p).name for p in (result.clip_paths or [])]
    clip_timestamps: dict[str, dict] = {}

    for item in result.events or []:
        if item.get("source") == "log":
            name = item["clip"]
            video_sec = float(item.get("video_sec", 0))
            clip_timestamps[name] = {
                "start": round(max(0.0, video_sec - LOG_CLIP_MINUTE_SPAN - LOG_CLIP_BEFORE), 1),
                "end": round(video_sec + LOG_CLIP_AFTER, 1),
            }

    log_clip_names = set(clip_timestamps.keys())
    ai_names = [name for name in clip_files if name not in log_clip_names]
    ai_frames = result.highlight_frames or []
    for i, name in enumerate(ai_names):
        frame = ai_frames[i] if i < len(ai_frames) else None
        if frame is not None:
            anchor_sec = frame / fps_val
            clip_timestamps[name] = {
                "start": round(max(0.0, anchor_sec - CLIP_DURATION_BEFORE), 1),
                "end": round(anchor_sec + CLIP_DURATION_AFTER, 1),
            }

    merged_metadata = {
        **metadata,
        "progress": _progress_payload("done", 100, "하이라이트 추출 완료"),
        "clips": clip_files,
        "selected": {},
        "clip_scores": result.clip_scores,
        "clip_features": result.clip_features,
        "clip_feature_stats": result.clip_feature_stats,
        "clip_timestamps": clip_timestamps,
        "events": result.events,
        "message": result.message,
    }
    _delete_upload(str(job.upload_path))
    update_job(db, job.id, status="done", upload_path=None, clips_dir=out_dir, job_metadata=_json_safe(merged_metadata))


def delete_job_files(job: HighlightJob) -> None:
    path = job_dir(job.id)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    if job.upload_path:
        try:
            Path(job.upload_path).unlink(missing_ok=True)
        except Exception:
            pass
    if job.export_path:
        try:
            Path(job.export_path).unlink(missing_ok=True)
        except Exception:
            pass
