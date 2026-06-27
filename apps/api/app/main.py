import asyncio
import csv
from datetime import datetime, timezone
import hashlib
import hmac
import io
import json
import math
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import UUID
from fastapi import BackgroundTasks, Body, Cookie, Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import desc, inspect, text
from sqlalchemy.orm import Session
import os
import httpx
from PIL import Image
from pypdf import PdfReader

from .db import Base, SessionLocal, engine, get_db
from .fcm_cards import TEMPLATE_DIR, build_card_image, build_cards_zip, find_template_path
from .fpa import (
    analyze_card_workbook,
    build_analysis_workbook,
    build_visual_reports,
    build_visual_reports_archive,
    extract_players,
    generate_log_entry,
    import_logs_from_workbook,
    parse_logs_to_dataframe,
)
from .fpa_schemas import FcmAnalyzeWorkbookResponse, FpaExportLogsRequest, FpaGenerateLogRequest, FpaGenerateLogResponse, FpaImportLogsResponse, FpaPlayersResponse, FpaSavedLogsRequest, FpaSavedLogsResponse, FpaVisualizeResponse
from .highlight_jobs import (
    clips_dir,
    create_player_proxy_for_job,
    cut_clips_for_job,
    delete_job_files,
    download_link_for_job,
    merge_clips_for_job,
    ensure_highlight_runtime_dirs,
    exports_dir,
    job_dir,
    probe_video_dimensions,
    safe_clip_path,
    serialize_job,
    update_job,
    upload_dir,
)
from .models import Match, State, PossessionSegment, LaneSegment, Event, DominanceBin, MatchMarker, Outbox, User, WebhookSubscription, AuditLog, FcmSubmission, CompetitionClass, FcmTemplate, FpaSavedLog, HighlightJob
from .schemas import (
    ArchiveMatchRequest,
    AcquireLockRequest,
    AttachIngestRequest,
    AttackLaneEventRequest,
    AttachSrtRequest,
    CompetitionClassCreateRequest,
    CompetitionClassResponse,
    CompetitionClassUpdateRequest,
    CreateMatchRequest,
    IngestProtocol,
    LineupManualPlayerDeleteRequest,
    LineupManualPlayerRequest,
    LoginRequest,
    MatchResultResponse,
    MatchResponse,
    MatchMarkerRequest,
    EventsResetRequest,
    FcmTemplateResponse,
    FcmTemplateUpdateRequest,
    FcmSubmissionResponse,
    FcmSubmissionUpsertRequest,
    PossessionResetRequest,
    ReleaseLockRequest,
    SessionUserResponse,
    StateRequest,
    TimelineEditorListItem,
    TimelineEditorListResponse,
    TimelineEditorUpsertRequest,
    UpdateArchivedMatchRequest,
    WebhookSubscriptionCreateRequest,
    XGEstimateRequest,
    XGEventRequest,
    XGOTEstimateRequest,
    UserRole,
)
from .services import apply_attack_event, apply_possession_segment, apply_xg_event, backfill_attack_scores, enqueue_outbox, latest_outbox, outbox_worker, recompute_dominance
from .xg import estimate_xg as shared_estimate_xg, is_in_penalty_area as shared_is_in_penalty_area, normalize_shot_x as shared_normalize_shot_x

app = FastAPI(title="Live Match Admin API")

origins = [v.strip() for v in os.getenv("CORS_ORIGINS", "*").split(",") if v.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins if origins else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

worker_stop_event = asyncio.Event()
worker_task: asyncio.Task | None = None
SESSION_COOKIE_NAME = "live_admin_session"
SESSION_SECRET = os.getenv("SESSION_SECRET", "dev-live-admin-session-secret")
SESSION_MAX_AGE = int(os.getenv("SESSION_MAX_AGE_SECONDS", str(60 * 60 * 24 * 14)))
PUBLIC_HLS_BASE = os.getenv("PUBLIC_HLS_BASE", "https://console.fineludens.kr").rstrip("/")
GATEWAY_STATUS_TIMEOUT_SECONDS = float(os.getenv("GATEWAY_STATUS_TIMEOUT_SECONDS", "1.0"))
HLS_PROBE_TIMEOUT_SECONDS = float(os.getenv("HLS_PROBE_TIMEOUT_SECONDS", "1.5"))
MEDIA_CONTROL_URL = os.getenv("MEDIA_CONTROL_URL", "").strip()
MEDIA_CONTROL_TOKEN = os.getenv("MEDIA_CONTROL_TOKEN", "").strip()
MEDIA_INSTANCE_ID = os.getenv("MEDIA_INSTANCE_ID", "").strip()
MEDIA_INSTANCE_NAME = os.getenv("MEDIA_INSTANCE_NAME", "live-admin-media").strip() or "live-admin-media"
HIGHLIGHT_WORKER_CONTROL_URL = os.getenv("HIGHLIGHT_WORKER_CONTROL_URL", "").strip()
HIGHLIGHT_WORKER_CONTROL_TOKEN = os.getenv("HIGHLIGHT_WORKER_CONTROL_TOKEN", "").strip()
HIGHLIGHT_WORKER_INSTANCE_ID = os.getenv("HIGHLIGHT_WORKER_INSTANCE_ID", "").strip()
HIGHLIGHT_WORKER_INSTANCE_NAME = os.getenv("HIGHLIGHT_WORKER_INSTANCE_NAME", "fhl-gpu-worker").strip() or "fhl-gpu-worker"
FCM_RUNTIME_DIR = Path(os.getenv("FCM_RUNTIME_DIR", "/app/runtime/fcm")).resolve()
FCM_TEMPLATE_RUNTIME_DIR = FCM_RUNTIME_DIR / "templates"
BROADCAST_RUNTIME_DIR = Path(os.getenv("BROADCAST_RUNTIME_DIR", "/app/runtime/broadcast")).resolve()
BROADCAST_LOGO_DIR = BROADCAST_RUNTIME_DIR / "logos"

DOM_POSSESSION_WEIGHT = float(os.getenv("DOM_POSSESSION_WEIGHT", "0.35"))
DOM_XG_WEIGHT = float(os.getenv("DOM_XG_WEIGHT", "0.65"))
DOM_ATTACK_WEIGHT = float(os.getenv("DOM_ATTACK_WEIGHT", "0.25"))
DOM_XG_SCALE = float(os.getenv("DOM_XG_SCALE", "1.8"))
DOM_GOAL_XG_MULTIPLIER = float(os.getenv("DOM_GOAL_XG_MULTIPLIER", "2.5"))
DOMINANCE_CACHE_TTL_SECONDS = float(os.getenv("DOMINANCE_CACHE_TTL_SECONDS", "3.0"))
_dominance_response_cache: dict[tuple[str, int, bool], tuple[float, dict]] = {}
MATCH_RESPONSE_CACHE_TTL_SECONDS = float(os.getenv("MATCH_RESPONSE_CACHE_TTL_SECONDS", "3.0"))
_match_response_cache: dict[str, tuple[float, object]] = {}
BROADCAST_SNAPSHOT_CACHE_TTL_SECONDS = float(os.getenv("BROADCAST_SNAPSHOT_CACHE_TTL_SECONDS", "3.0"))
_broadcast_snapshot_cache: dict[str, tuple[float, dict]] = {}


def _cache_get(cache: dict, key):
    if MATCH_RESPONSE_CACHE_TTL_SECONDS <= 0:
        return None
    cached = cache.get(key)
    if cached and time.monotonic() - cached[0] <= MATCH_RESPONSE_CACHE_TTL_SECONDS:
        return cached[1]
    return None


def _cache_set(cache: dict, key, value):
    if MATCH_RESPONSE_CACHE_TTL_SECONDS > 0:
        cache[key] = (time.monotonic(), value)
    return value


def _normalize_hls_url(hls_url: str | None) -> str | None:
    if not hls_url:
        return hls_url
    if hls_url.startswith("/hls/"):
        return f"{PUBLIC_HLS_BASE}{hls_url}"

    parsed = urlsplit(hls_url)
    if parsed.path.startswith("/hls/"):
        normalized = f"{PUBLIC_HLS_BASE}{parsed.path}"
        if parsed.query:
            normalized = f"{normalized}?{parsed.query}"
        return normalized
    return hls_url


def _normalize_fcm_team_side(team_side: str) -> str:
    normalized_side = team_side.strip().upper()
    if normalized_side not in {"HOME", "AWAY"}:
        raise HTTPException(status_code=400, detail="team_side must be HOME or AWAY")
    return normalized_side


def _fcm_workbook_path(match_id: UUID, team_side: str) -> Path:
    FCM_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    return FCM_RUNTIME_DIR / f"{match_id}_{team_side.lower()}.xlsx"


def _fcm_shared_workbook_path(match_id: UUID) -> Path:
    FCM_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    return FCM_RUNTIME_DIR / f"{match_id}_shared.xlsx"


def _ensure_runtime_schema() -> None:
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    user_columns = {column["name"] for column in inspector.get_columns("users")}
    match_columns = {column["name"] for column in inspector.get_columns("matches")}
    event_columns = {column["name"] for column in inspector.get_columns("events")}
    dominance_columns = {column["name"] for column in inspector.get_columns("dominance_bins")}
    fcm_submission_columns = {column["name"] for column in inspector.get_columns("fcm_submissions")} if "fcm_submissions" in table_names else set()
    fcm_template_columns = {column["name"] for column in inspector.get_columns("fcm_templates")} if "fcm_templates" in table_names else set()
    highlight_job_columns = {column["name"] for column in inspector.get_columns("highlight_jobs")} if "highlight_jobs" in table_names else set()
    statements: list[str] = []

    if "highlight_jobs" in table_names and "owner_id" not in highlight_job_columns:
        statements.append("ALTER TABLE highlight_jobs ADD COLUMN owner_id VARCHAR")
        statements.append("CREATE INDEX IF NOT EXISTS ix_highlight_jobs_owner_id ON highlight_jobs (owner_id)")

    if "role" not in user_columns:
        statements.append("ALTER TABLE users ADD COLUMN role VARCHAR NOT NULL DEFAULT 'OPERATOR'")
    if "sport" not in match_columns:
        statements.append("ALTER TABLE matches ADD COLUMN sport VARCHAR NOT NULL DEFAULT 'FOOTBALL'")
    if "competition_class" not in match_columns:
        statements.append("ALTER TABLE matches ADD COLUMN competition_class VARCHAR NOT NULL DEFAULT 'K3'")
    if "round_number" not in match_columns:
        statements.append("ALTER TABLE matches ADD COLUMN round_number INTEGER NOT NULL DEFAULT 1")
    if "first_half_minutes" not in match_columns:
        statements.append("ALTER TABLE matches ADD COLUMN first_half_minutes INTEGER NOT NULL DEFAULT 45")
    if "second_half_minutes" not in match_columns:
        statements.append("ALTER TABLE matches ADD COLUMN second_half_minutes INTEGER NOT NULL DEFAULT 45")
    if "archived" not in match_columns:
        statements.append("ALTER TABLE matches ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE")
    if "archived_at" not in match_columns:
        statements.append("ALTER TABLE matches ADD COLUMN archived_at TIMESTAMP NULL")
    if "fcm_submissions" in table_names and "team_side" not in fcm_submission_columns:
        statements.append("ALTER TABLE fcm_submissions ADD COLUMN team_side VARCHAR NOT NULL DEFAULT 'HOME'")
    if "fcm_submissions" in table_names and "player_name" not in fcm_submission_columns:
        statements.append("ALTER TABLE fcm_submissions ADD COLUMN player_name VARCHAR NOT NULL DEFAULT ''")
    if "fcm_templates" in table_names and "competition_class" not in fcm_template_columns:
        statements.append("ALTER TABLE fcm_templates ADD COLUMN competition_class VARCHAR")
    if "is_goal" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN is_goal BOOLEAN NOT NULL DEFAULT FALSE")
    if "shot_x" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN shot_x DOUBLE PRECISION")
    if "shot_y" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN shot_y DOUBLE PRECISION")
    if "xgot" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN xgot DOUBLE PRECISION")
    if "is_on_target" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN is_on_target BOOLEAN NOT NULL DEFAULT FALSE")
    if "goalmouth_x" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN goalmouth_x DOUBLE PRECISION")
    if "goalmouth_y" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN goalmouth_y DOUBLE PRECISION")
    if "is_header" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN is_header BOOLEAN NOT NULL DEFAULT FALSE")
    if "is_weak_foot" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN is_weak_foot BOOLEAN NOT NULL DEFAULT FALSE")
    if "under_pressure" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN under_pressure BOOLEAN NOT NULL DEFAULT FALSE")
    if "one_on_one" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN one_on_one BOOLEAN NOT NULL DEFAULT FALSE")
    if "shot_pace_band" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN shot_pace_band VARCHAR")
    if "player_name" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN player_name VARCHAR")
    if "player_number" not in event_columns:
        statements.append("ALTER TABLE events ADD COLUMN player_number VARCHAR")
    if "home_attack_score" not in dominance_columns:
        statements.append("ALTER TABLE dominance_bins ADD COLUMN home_attack_score DOUBLE PRECISION NOT NULL DEFAULT 0")
    if "away_attack_score" not in dominance_columns:
        statements.append("ALTER TABLE dominance_bins ADD COLUMN away_attack_score DOUBLE PRECISION NOT NULL DEFAULT 0")

    unique_match_constraint_names: list[str] = []
    unique_match_index_names: list[str] = []
    if "fcm_submissions" in table_names:
        for constraint in inspector.get_unique_constraints("fcm_submissions"):
            cols = constraint.get("column_names") or []
            if cols == ["match_id"] and constraint.get("name"):
                unique_match_constraint_names.append(constraint["name"])
        for index in inspector.get_indexes("fcm_submissions"):
            cols = index.get("column_names") or []
            if index.get("unique") and cols == ["match_id"] and index.get("name"):
                unique_match_index_names.append(index["name"])

    if not statements and not unique_match_constraint_names and not unique_match_index_names:
        return

    with engine.begin() as conn:
        for statement in statements:
            conn.execute(text(statement))
        for constraint_name in unique_match_constraint_names:
            conn.execute(text(f'ALTER TABLE fcm_submissions DROP CONSTRAINT IF EXISTS "{constraint_name}"'))
        for index_name in unique_match_index_names:
            conn.execute(text(f'DROP INDEX IF EXISTS "{index_name}"'))


def _default_half_minutes_for_class(code: str | None) -> tuple[int, int]:
    normalized = _normalize_competition_class(code)
    if "SUFA" in normalized:
        return 20, 20
    return 45, 45


def _seed_competition_classes(db: Session) -> None:
    defaults = [
        ("K3", "K3", 45, 45),
        ("WK", "WK", 45, 45),
        ("CUSTOM", "CUSTOM", 45, 45),
        ("SUFA-S", "SUFA-S", 20, 20),
        ("SUFA-A", "SUFA-A", 20, 20),
        ("SUFA-B", "SUFA-B", 20, 20),
        ("SUFA-L", "SUFA-L", 20, 20),
    ]
    existing = {row.code for row in db.query(CompetitionClass).all()}
    for code, name, first_half_minutes, second_half_minutes in defaults:
        if code in existing:
            continue
        db.add(
            CompetitionClass(
                code=code,
                name=name,
                first_half_minutes=first_half_minutes,
                second_half_minutes=second_half_minutes,
            )
        )
    db.commit()


def _seed_existing_fcm_templates(db: Session) -> None:
    if not TEMPLATE_DIR.exists():
        return

    existing_paths = {row.image_path for row in db.query(FcmTemplate.image_path).all()}
    existing_names = {row.name for row in db.query(FcmTemplate.name).all()}
    candidates = sorted(TEMPLATE_DIR.glob("*.png"))

    for index, path in enumerate(candidates, start=1):
        name = f"{path.stem} 기본 템플릿"
        path_text = str(path)
        if path_text in existing_paths or name in existing_names:
            continue
        db.add(
            FcmTemplate(
                name=name,
                match_regex=re.escape(path.stem),
                image_path=path_text,
                priority=100 + index,
                active=True,
            )
        )
    db.commit()


def _serialize_competition_class(row: CompetitionClass) -> dict:
    return {
        "code": row.code,
        "name": row.name,
        "first_half_minutes": int(row.first_half_minutes or 45),
        "second_half_minutes": int(row.second_half_minutes or row.first_half_minutes or 45),
        "created_at": row.created_at.isoformat(),
    }


def _gateway_start_stream(
    match_id: UUID,
    ingest_url: str | None,
    ingest_protocol: IngestProtocol | None = None,
) -> dict:
    gateway_base = os.getenv("GATEWAY_API_BASE", "http://host.docker.internal:8090").rstrip("/")
    if not gateway_base:
        raise HTTPException(status_code=500, detail="GATEWAY_API_BASE not configured")

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(
                f"{gateway_base}/matches/start",
                json={
                    "match_id": str(match_id),
                    "source_url": ingest_url,
                    "ingest_protocol": ingest_protocol,
                    # Backward compatibility with older gateway request fields.
                    "srt_url": ingest_url,
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"gateway start failed: {ex}") from ex

    hls_url = data.get("hls_url")
    if not hls_url:
        raise HTTPException(status_code=502, detail="gateway response missing hls_url")
    return data


def _gateway_rtmp_info(match_id: UUID) -> dict:
    gateway_base = os.getenv("GATEWAY_API_BASE", "http://host.docker.internal:8090").rstrip("/")
    if not gateway_base:
        raise HTTPException(status_code=500, detail="GATEWAY_API_BASE not configured")

    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(f"{gateway_base}/matches/{match_id}/rtmp-info")
            resp.raise_for_status()
            data = resp.json()
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"gateway rtmp info failed: {ex}") from ex

    if not data.get("server_url") or not data.get("stream_key"):
        raise HTTPException(status_code=502, detail="gateway response missing RTMP info")
    return data


def _resolve_ingest_fields(
    ingest_url: str | None,
    srt_url: str | None,
    ingest_protocol: IngestProtocol | None,
) -> tuple[str | None, IngestProtocol | None]:
    chosen_url = (ingest_url or srt_url or "").strip() or None
    if ingest_protocol:
        return chosen_url, ingest_protocol
    if chosen_url and chosen_url.lower().startswith("rtmp://"):
        return chosen_url, "RTMP"
    if chosen_url:
        return chosen_url, "SRT"
    return None, None


def _gateway_stop_stream(match_id: UUID) -> None:
    gateway_base = os.getenv("GATEWAY_API_BASE", "http://host.docker.internal:8090").rstrip("/")
    if not gateway_base:
        return

    try:
        with httpx.Client(timeout=5.0) as client:
            client.post(f"{gateway_base}/matches/{match_id}/stop")
    except Exception:
        # Best-effort stop to avoid blocking delete path.
        return


def _gateway_clear_stream(match_id: UUID) -> None:
    gateway_base = os.getenv("GATEWAY_API_BASE", "http://host.docker.internal:8090").rstrip("/")
    if not gateway_base:
        raise HTTPException(status_code=500, detail="GATEWAY_API_BASE not configured")

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(f"{gateway_base}/matches/{match_id}/clear")
            resp.raise_for_status()
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"gateway clear failed: {ex}") from ex


def _gateway_status() -> dict:
    gateway_base = os.getenv("GATEWAY_API_BASE", "http://host.docker.internal:8090").rstrip("/")
    if not gateway_base:
        raise HTTPException(status_code=500, detail="GATEWAY_API_BASE not configured")

    try:
        with httpx.Client(timeout=GATEWAY_STATUS_TIMEOUT_SECONDS) as client:
            resp = client.get(f"{gateway_base}/matches/status")
            resp.raise_for_status()
            data = resp.json()
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"gateway status failed: {ex}") from ex

    lines = data.get("lines") or []
    running_match_ids: list[str] = []
    for line in lines:
        if not isinstance(line, str):
            continue
        match = line.split(" ", 1)[0].strip()
        if match and match != "no":
            running_match_ids.append(match)

    return {
        "ok": True,
        "lines": lines,
        "running_match_ids": running_match_ids,
    }


def _media_control_request(action: str, *, confirmed_live_action: bool = False) -> dict:
    if not MEDIA_CONTROL_URL:
        raise HTTPException(status_code=503, detail="MEDIA_CONTROL_URL not configured")

    headers: dict[str, str] = {}
    if MEDIA_CONTROL_TOKEN:
        headers["Authorization"] = f"Bearer {MEDIA_CONTROL_TOKEN}"

    payload = {
        "action": action,
        "instance_id": MEDIA_INSTANCE_ID or None,
        "instance_name": MEDIA_INSTANCE_NAME,
        "confirmed_live_action": confirmed_live_action,
    }

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(MEDIA_CONTROL_URL, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"media control failed: {ex}") from ex

    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="media control returned invalid response")
    return data


def _media_control_status() -> dict:
    try:
        data = _media_control_request("status")
    except HTTPException as ex:
        return {
            "configured": bool(MEDIA_CONTROL_URL),
            "ok": False,
            "state": "unknown",
            "detail": ex.detail,
            "instance_id": MEDIA_INSTANCE_ID or None,
            "instance_name": MEDIA_INSTANCE_NAME,
        }

    return {
        "configured": bool(MEDIA_CONTROL_URL),
        "ok": bool(data.get("ok", True)),
        "state": data.get("state") or "unknown",
        "detail": data.get("detail"),
        "instance_id": data.get("instance_id") or MEDIA_INSTANCE_ID or None,
        "instance_name": data.get("instance_name") or MEDIA_INSTANCE_NAME,
        "public_ip": data.get("public_ip"),
        "private_ip": data.get("private_ip"),
        "provider": data.get("provider") or "aws",
    }


def _highlight_worker_control_request(action: str, *, confirmed_live_action: bool = False) -> dict:
    if not HIGHLIGHT_WORKER_CONTROL_URL:
        raise HTTPException(status_code=503, detail="HIGHLIGHT_WORKER_CONTROL_URL not configured")

    headers: dict[str, str] = {}
    if HIGHLIGHT_WORKER_CONTROL_TOKEN:
        headers["Authorization"] = f"Bearer {HIGHLIGHT_WORKER_CONTROL_TOKEN}"

    payload = {
        "action": action,
        "instance_id": HIGHLIGHT_WORKER_INSTANCE_ID or None,
        "instance_name": HIGHLIGHT_WORKER_INSTANCE_NAME,
        "confirmed_live_action": confirmed_live_action,
    }

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(HIGHLIGHT_WORKER_CONTROL_URL, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"highlight worker control failed: {ex}") from ex

    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="highlight worker control returned invalid response")
    return data


def _highlight_worker_control_status() -> dict:
    try:
        data = _highlight_worker_control_request("status")
    except HTTPException as ex:
        return {
            "configured": bool(HIGHLIGHT_WORKER_CONTROL_URL),
            "ok": False,
            "state": "unknown",
            "detail": ex.detail,
            "instance_id": HIGHLIGHT_WORKER_INSTANCE_ID or None,
            "instance_name": HIGHLIGHT_WORKER_INSTANCE_NAME,
        }

    return {
        "configured": bool(HIGHLIGHT_WORKER_CONTROL_URL),
        "ok": bool(data.get("ok", True)),
        "state": data.get("state") or "unknown",
        "detail": data.get("detail"),
        "instance_id": data.get("instance_id") or HIGHLIGHT_WORKER_INSTANCE_ID or None,
        "instance_name": data.get("instance_name") or HIGHLIGHT_WORKER_INSTANCE_NAME,
        "public_ip": data.get("public_ip"),
        "private_ip": data.get("private_ip"),
        "provider": data.get("provider") or "aws",
    }


def _probe_hls_url(hls_url: str | None) -> dict:
    normalized_url = _normalize_hls_url(hls_url)
    if not normalized_url:
        return {
            "ok": False,
            "status_code": None,
            "detail": "No HLS URL configured",
            "checked_at": datetime.utcnow().isoformat(),
        }

    try:
        with httpx.Client(timeout=HLS_PROBE_TIMEOUT_SECONDS, follow_redirects=True) as client:
            response = client.get(normalized_url)
            ok = response.status_code == 200
            return {
                "ok": ok,
                "status_code": response.status_code,
                "detail": "HLS playlist reachable" if ok else f"HLS returned {response.status_code}",
                "checked_at": datetime.utcnow().isoformat(),
            }
    except Exception as ex:
        return {
            "ok": False,
            "status_code": None,
            "detail": str(ex),
            "checked_at": datetime.utcnow().isoformat(),
        }


@app.on_event("startup")
async def startup() -> None:
    global worker_task
    Base.metadata.create_all(bind=engine)
    _ensure_runtime_schema()
    ensure_highlight_runtime_dirs()
    db = SessionLocal()
    try:
        _seed_competition_classes(db)
        _seed_existing_fcm_templates(db)
    finally:
        db.close()
    worker_task = asyncio.create_task(outbox_worker(worker_stop_event))


@app.on_event("shutdown")
async def shutdown() -> None:
    worker_stop_event.set()
    if worker_task:
        await worker_task


def _require_write_lock(match_obj: Match, user_id: str | None) -> None:
    if _is_superuser(user_id):
        return
    if match_obj.operator_id and match_obj.operator_id != user_id:
        raise HTTPException(status_code=403, detail="Operator lock held by another user")


def _require_match_not_archived(match_obj: Match) -> None:
    if match_obj.archived:
        raise HTTPException(status_code=409, detail="Archived matches are read-only")


def _require_archived_editor_access(match_obj: Match, user: User) -> None:
    if not _is_superuser(user):
        raise HTTPException(status_code=403, detail="Superadmin only")
    if not match_obj.archived:
        raise HTTPException(status_code=409, detail="Event editor is available for archived matches only")


def _slugify_user_id(name: str) -> str:
    normalized = "".join(ch.lower() if ch.isalnum() else "-" for ch in name.strip())
    compact = "-".join(part for part in normalized.split("-") if part)
    return compact[:40] or f"user-{uuid.uuid4().hex[:8]}"


def _sign_session_value(user_id: str) -> str:
    signature = hmac.new(SESSION_SECRET.encode("utf-8"), user_id.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{user_id}.{signature}"


def _verify_session_value(raw_value: str | None) -> str | None:
    if not raw_value or "." not in raw_value:
        return None
    user_id, signature = raw_value.rsplit(".", 1)
    expected = hmac.new(SESSION_SECRET.encode("utf-8"), user_id.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    return user_id


def _set_session_cookie(response: Response, user_id: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=_sign_session_value(user_id),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=False,
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")


def _get_session_user(
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    db: Session = Depends(get_db),
) -> User | None:
    user_id = _verify_session_value(session_cookie)
    if not user_id:
        return None
    return db.get(User, user_id)


def _require_session_user(user: User | None = Depends(_get_session_user)) -> User:
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def _require_superuser(user: User = Depends(_require_session_user)) -> User:
    if not _is_superuser(user):
        raise HTTPException(status_code=403, detail="Superadmin only")
    return user


def _resolve_user_id(explicit_user_id: str | None, session_user: User | None) -> str | None:
    return explicit_user_id or (session_user.id if session_user else None)


def _is_superuser(user: User | str | None) -> bool:
    if isinstance(user, User):
        return (user.role or "OPERATOR") == "SUPERADMIN"
    return False


def _sha256_hex(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _matches_configured_key(raw_value: str, plain_env: str, hash_env: str) -> bool:
    plain = os.getenv(plain_env, "").strip()
    hashed = os.getenv(hash_env, "").strip().lower()
    if plain and hmac.compare_digest(raw_value, plain):
        return True
    if hashed and hmac.compare_digest(_sha256_hex(raw_value), hashed):
        return True
    return False


def _resolve_login_role(access_key: str) -> UserRole:
    key = access_key.strip()
    if not key:
        raise HTTPException(status_code=401, detail="Access key required")
    if _matches_configured_key(key, "SUPERADMIN_ACCESS_KEY", "SUPERADMIN_ACCESS_KEY_HASH"):
        return "SUPERADMIN"
    if _matches_configured_key(key, "OPERATOR_ACCESS_KEY", "OPERATOR_ACCESS_KEY_HASH"):
        return "OPERATOR"
    raise HTTPException(status_code=401, detail="Invalid access key")


def _normalize_competition_class(value: str | None) -> str:
    normalized = (value or "K3").strip().upper()
    return normalized or "K3"


MATCH_NAME_PATTERN = re.compile(r"^\[(?P<class>[A-Z0-9-]+) \| (?P<round>\d+)R\] (?P<home>.+) vs (?P<away>.+)$")


def _is_in_penalty_area(x: float, y: float) -> bool:
    return shared_is_in_penalty_area(x, y)


def _normalize_shot_x(
    team: str,
    attack_lr: str,
    start_x: float,
) -> float:
    return shared_normalize_shot_x(team, attack_lr, start_x)


def _estimate_xg(
    team: str,
    attack_lr: str,
    start_x: float,
    start_y: float,
    is_header: bool,
    is_weak_foot: bool,
) -> dict:
    return shared_estimate_xg(team, attack_lr, start_x, start_y, is_header, is_weak_foot)


def _estimate_xgot(
    xg: float,
    *,
    is_on_target: bool,
    goalmouth_x: float | None,
    goalmouth_y: float | None,
    is_goal: bool,
    is_header: bool,
    is_weak_foot: bool,
    under_pressure: bool,
    one_on_one: bool,
    shot_pace_band: str,
) -> dict:
    clipped_xg = max(0.0, min(1.0, xg))
    if not is_on_target or goalmouth_x is None or goalmouth_y is None:
        return {
            "xgot": 0.0,
            "corner_factor": 0.0,
            "placement_factor": 0.0,
            "height_factor": 0.0,
            "pace_factor": 0.0,
            "delta": round(-clipped_xg, 3),
            "label": "off-target",
        }

    gx = max(0.0, min(1.0, goalmouth_x))
    gy = max(0.0, min(1.0, goalmouth_y))
    lateral_offset = abs(gx - 0.5) / 0.5
    height_factor = gy
    corner_factor = min(1.0, math.sqrt((lateral_offset ** 2 + height_factor ** 2) / 2.0))
    placement_factor = 0.65 * lateral_offset + 0.35 * height_factor

    # Speed should not boost keeper-zone shots uniformly.
    # Weight speed by a fan-shaped distribution radiating from the center-bottom
    # of the goalmouth so upper corners benefit more than central low shots.
    radial_distance = min(1.0, math.sqrt((lateral_offset ** 2 + height_factor ** 2) / 2.0))
    fan_weight = min(1.0, 0.55 * height_factor + 0.25 * lateral_offset + 0.20 * radial_distance)
    pace_lookup = {"LOW": -0.03, "MID": 0.0, "HIGH": 0.05}
    pace_factor = pace_lookup.get(shot_pace_band, 0.0) * fan_weight

    score = (
        clipped_xg * 0.58
        + corner_factor * 0.24
        + placement_factor * 0.14
        + pace_factor
        + (0.05 if one_on_one else 0.0)
        - (0.04 if under_pressure else 0.0)
        - (0.03 if is_header else 0.0)
        - (0.02 if is_weak_foot else 0.0)
    )
    if is_goal:
        score += 0.03

    xgot = max(0.0, min(1.0, score))
    label = "central"
    if corner_factor >= 0.78:
        label = "top-corner threat"
    elif placement_factor >= 0.6:
        label = "well-placed"
    elif gy <= 0.25 and lateral_offset <= 0.2:
        label = "keeper-zone"

    return {
        "xgot": round(xgot, 3),
        "corner_factor": round(corner_factor, 3),
        "placement_factor": round(placement_factor, 3),
        "height_factor": round(height_factor, 3),
        "fan_weight": round(fan_weight, 3),
        "pace_factor": round(pace_factor, 3),
        "delta": round(xgot - clipped_xg, 3),
        "label": label,
    }


def _normalize_sport(value: str | None) -> str:
    normalized = (value or "FOOTBALL").strip().upper()
    if normalized not in {"FOOTBALL", "BASKETBALL"}:
        raise HTTPException(status_code=400, detail="sport must be FOOTBALL or BASKETBALL")
    return normalized


def _serialize_match(row: Match, include_sport: bool = True) -> dict:
    default_first_half, default_second_half = _default_half_minutes_for_class(row.competition_class)
    payload = {
        "id": row.id,
        "name": row.name,
        "competition_class": _normalize_competition_class(row.competition_class),
        "round_number": int(row.round_number or 1),
        "first_half_minutes": int(row.first_half_minutes or default_first_half),
        "second_half_minutes": int(row.second_half_minutes or default_second_half),
        "archived": bool(row.archived),
        "archived_at": row.archived_at.isoformat() if row.archived_at else None,
        "created_at": row.created_at.isoformat(),
        "hls_url": _normalize_hls_url(row.hls_url),
        "metadata": row.metadata_json,
        "operator_id": row.operator_id,
    }
    if include_sport:
        payload["sport"] = _normalize_sport(getattr(row, "sport", None))
    return payload


def _default_broadcast_state(match_obj: Match) -> dict:
    now = datetime.utcnow().isoformat()
    return {
        "match_id": str(match_obj.id),
        "sport": _normalize_sport(getattr(match_obj, "sport", None)),
        "scoreboard_visible": True,
        "active_graphic": None,
        "possession_visible": False,
        "selected_xg_event_id": None,
        "event_graphic": None,
        "fullscreen_graphic": None,
        "fullscreen_image_urls": {},
        "theme_id": "fineplay_dark",
        "home_label": "Home",
        "away_label": "Away",
        "home_color": "#ff7900",
        "away_color": "#3d22f3",
        "home_logo_url": "",
        "away_logo_url": "",
        "home_score": None,
        "away_score": None,
        "clock_ms": 0,
        "clock_running": False,
        "clock_started_at": None,
        "sequence": 0,
        "updated_at": now,
    }


def _broadcast_state(match_obj: Match) -> dict:
    metadata = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
    state = metadata.get("broadcast") if isinstance(metadata.get("broadcast"), dict) else {}
    base = _default_broadcast_state(match_obj)
    base.update({k: v for k, v in state.items() if k in base or k in {"event_payload"}})
    base["match_id"] = str(match_obj.id)
    base["sport"] = _normalize_sport(getattr(match_obj, "sport", None))
    base["scoreboard_visible"] = bool(base.get("scoreboard_visible"))
    base["possession_visible"] = bool(base.get("possession_visible"))
    if base.get("active_graphic") not in {None, "ATTACK_DIRECTION_HOME", "ATTACK_DIRECTION_AWAY", "XG"}:
        base["active_graphic"] = None
    if not isinstance(base.get("fullscreen_image_urls"), dict):
        base["fullscreen_image_urls"] = {}
    base["sequence"] = int(base.get("sequence") or 0)
    base["clock_ms"] = max(0, int(base.get("clock_ms") or 0))
    base["clock_running"] = bool(base.get("clock_running") or False)
    for key, fallback in (("home_color", "#ff7900"), ("away_color", "#3d22f3")):
        value = str(base.get(key) or fallback).strip()
        base[key] = value if re.fullmatch(r"#[0-9A-Fa-f]{6}", value) else fallback
    for key, fallback in (("home_label", "Home"), ("away_label", "Away")):
        value = str(base.get(key) or fallback).strip()
        base[key] = value[:20] if value else fallback
    for key in ("home_logo_url", "away_logo_url"):
        base[key] = str(base.get(key) or "").strip()[:500]
    for key in ("home_score", "away_score"):
        raw_score = base.get(key)
        base[key] = None if raw_score is None else max(0, int(raw_score or 0))
    return base


def _broadcast_clock_ms(state: dict, now: datetime | None = None) -> int:
    base_ms = max(0, int(state.get("clock_ms") or 0))
    if not state.get("clock_running"):
        return base_ms
    raw_started_at = state.get("clock_started_at")
    if not raw_started_at:
        return base_ms
    try:
        started_at = datetime.fromisoformat(str(raw_started_at))
    except ValueError:
        return base_ms
    current = now or datetime.utcnow()
    return max(0, base_ms + int((current - started_at).total_seconds() * 1000))


def _broadcast_logo_path(filename: str) -> Path:
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", filename)
    path = (BROADCAST_LOGO_DIR / safe_name).resolve()
    if BROADCAST_LOGO_DIR.resolve() not in path.parents:
        raise HTTPException(status_code=400, detail="Invalid logo path")
    return path


def _team_names_from_match(match_obj: Match) -> dict:
    metadata = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
    return {
        "HOME": metadata.get("home_team") or "HOME",
        "AWAY": metadata.get("away_team") or "AWAY",
    }


def _football_score_from_events(match_id: UUID, db: Session) -> dict:
    rows = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "XG", Event.is_goal.is_(True))
        .all()
    )
    return {
        "HOME": sum(1 for row in rows if row.team == "HOME"),
        "AWAY": sum(1 for row in rows if row.team == "AWAY"),
    }


def _build_broadcast_snapshot(match_obj: Match, db: Session) -> dict:
    state = _broadcast_state(match_obj)
    teams = _team_names_from_match(match_obj)
    latest_state = _latest_state(match_obj.id, db)
    score = _football_score_from_events(match_obj.id, db)
    home_score = score["HOME"] if state.get("home_score") is None else int(state.get("home_score") or 0)
    away_score = score["AWAY"] if state.get("away_score") is None else int(state.get("away_score") or 0)
    result = _build_partner_match_result(match_obj.id, db) if state["sport"] == "FOOTBALL" else {}
    coder_clock_ms = _broadcast_clock_ms(state)
    return {
        "match": {
            "id": str(match_obj.id),
            "name": match_obj.name,
            "sport": state["sport"],
            "home": {"name": teams["HOME"], "score": home_score},
            "away": {"name": teams["AWAY"], "score": away_score},
            "clock": _fmt_clock_ms(coder_clock_ms),
            "clock_ms": coder_clock_ms,
            "running": bool(state.get("clock_running")),
            "fla_clock": result.get("aggregate_clock") or (_fmt_clock_ms(latest_state.clock_ms) if latest_state else "00:00"),
            "fla_clock_ms": result.get("aggregate_clock_ms") or (latest_state.clock_ms if latest_state else 0),
        },
        "broadcast_state": state,
        "analysis": {
            "possession": result.get("possession"),
            "attack_direction": result.get("attack_direction") or [],
            "xg": result.get("xg") or [],
            "match_dominance": result.get("match_dominance"),
        },
        "updated_at": datetime.utcnow().isoformat(),
    }


def _build_scoreboard_broadcast_snapshot(match_obj: Match, db: Session) -> dict:
    state = _broadcast_state(match_obj)
    teams = _team_names_from_match(match_obj)
    latest_state = _latest_state(match_obj.id, db)
    score = _football_score_from_events(match_obj.id, db)
    home_score = score["HOME"] if state.get("home_score") is None else int(state.get("home_score") or 0)
    away_score = score["AWAY"] if state.get("away_score") is None else int(state.get("away_score") or 0)
    coder_clock_ms = _broadcast_clock_ms(state)
    return {
        "match": {
            "id": str(match_obj.id),
            "name": match_obj.name,
            "sport": state["sport"],
            "home": {"name": teams["HOME"], "score": home_score},
            "away": {"name": teams["AWAY"], "score": away_score},
            "clock": _fmt_clock_ms(coder_clock_ms),
            "clock_ms": coder_clock_ms,
            "running": bool(state.get("clock_running")),
            "fla_clock": _fmt_clock_ms(latest_state.clock_ms) if latest_state else "00:00",
            "fla_clock_ms": latest_state.clock_ms if latest_state else 0,
        },
        "broadcast_state": state,
        "analysis": {},
        "updated_at": datetime.utcnow().isoformat(),
    }


def _require_football_match_for_partner(match_id: UUID, db: Session) -> Match:
    row = db.get(Match, match_id)
    if not row or _normalize_sport(getattr(row, "sport", None)) != "FOOTBALL":
        raise HTTPException(status_code=404, detail="Match not found")
    return row


def _require_basketball_match_for_partner(match_id: UUID, db: Session) -> Match:
    row = db.get(Match, match_id)
    if not row or _normalize_sport(getattr(row, "sport", None)) != "BASKETBALL":
        raise HTTPException(status_code=404, detail="Match not found")
    return row


def _serialize_fcm_submission(row: FcmSubmission) -> dict:
    return {
        "id": row.id,
        "match_id": row.match_id,
        "competition_class": _normalize_competition_class(row.competition_class),
        "round_number": int(row.round_number or 1),
        "team_side": row.team_side,
        "team_name": row.team_name or "",
        "player_id": row.player_id,
        "player_name": row.player_name or "",
        "selected_stats": list(row.selected_stats or []),
        "submitted_by": row.submitted_by,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _serialize_fpa_saved_log(row: FpaSavedLog | None, match_id: UUID) -> dict:
    if not row:
        return {
            "match_id": str(match_id),
            "logs": [],
            "rows": [],
            "teamid_h": "",
            "teamid_a": "",
            "updated_at": None,
        }
    return {
        "match_id": str(row.match_id),
        "logs": list(row.logs or []),
        "rows": list(row.rows or []),
        "teamid_h": row.teamid_h or "",
        "teamid_a": row.teamid_a or "",
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _build_fpa_workbook_from_saved_log(row: FpaSavedLog) -> bytes:
    logs = list(row.logs or [])
    if not logs:
        raise HTTPException(status_code=404, detail="No saved FPA logs for this match")
    df = parse_logs_to_dataframe(logs, str(row.match_id), row.teamid_h or "", row.teamid_a or "")
    return build_analysis_workbook(df)


def _serialize_fcm_template(row: FcmTemplate) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "competition_class": _normalize_competition_class(row.competition_class) if row.competition_class else None,
        "match_regex": row.match_regex,
        "image_url": f"/api/fcm/templates/{row.id}/image",
        "priority": int(row.priority or 100),
        "active": bool(row.active),
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _validate_fcm_template_competition_class(db: Session, value: str | None) -> str:
    raw_value = (value or "").strip()
    if not raw_value:
        raise HTTPException(status_code=400, detail="Competition class is required")
    normalized = _normalize_competition_class(raw_value)
    if not db.get(CompetitionClass, normalized):
        raise HTTPException(status_code=400, detail="Competition class does not exist")
    return normalized


def _validate_fcm_template_regex(value: str | None) -> str:
    clean_regex = (value or "").strip()
    if not clean_regex:
        raise HTTPException(status_code=400, detail="Template regex is required")
    try:
        re.compile(clean_regex)
    except re.error as ex:
        raise HTTPException(status_code=400, detail=f"Invalid regex: {ex}") from ex
    return clean_regex


def _find_matching_template_path(rows: list[FcmTemplate], team_name: str) -> Path | None:
    for row in rows:
        try:
            if re.search(row.match_regex, team_name or "", flags=re.IGNORECASE):
                path = Path(row.image_path)
                if path.exists():
                    return path
        except re.error:
            continue
    return None


def _find_registered_template_path(db: Session, competition_class: str | None, team_name: str) -> Path | None:
    normalized_class = _normalize_competition_class(competition_class)
    class_rows = (
        db.query(FcmTemplate)
        .filter(FcmTemplate.active == True)  # noqa: E712
        .filter(FcmTemplate.competition_class == normalized_class)
        .order_by(FcmTemplate.priority.asc(), FcmTemplate.created_at.asc())
        .all()
    )
    matched = _find_matching_template_path(class_rows, team_name)
    if matched:
        return matched

    legacy_rows = (
        db.query(FcmTemplate)
        .filter(FcmTemplate.active == True)  # noqa: E712
        .filter(FcmTemplate.competition_class.is_(None))
        .order_by(FcmTemplate.priority.asc(), FcmTemplate.created_at.asc())
        .all()
    )
    return _find_matching_template_path(legacy_rows, team_name)


def _build_fcm_card_payload(db: Session, row: FcmSubmission, league: str, round_number: int) -> tuple[str, bytes]:
    template_path = _find_registered_template_path(db, row.competition_class, row.team_name or "") or find_template_path(row.team_name or "")
    if not template_path:
        raise ValueError(f"{row.team_name}: 배경 템플릿 없음")

    workbook_path = _fcm_workbook_path(row.match_id, row.team_side)
    shared_workbook_path = _fcm_shared_workbook_path(row.match_id)
    if workbook_path.exists():
        workbook_bytes = workbook_path.read_bytes()
    elif shared_workbook_path.exists():
        workbook_bytes = shared_workbook_path.read_bytes()
    else:
        workbook_bytes = None

    card_bytes = build_card_image(
        background_path=template_path,
        player_id=row.player_id,
        player_name=row.player_name or row.player_id,
        selected_stats=list(row.selected_stats or []),
        workbook_bytes=workbook_bytes,
    )
    filename = f"{league}-{round_number}R-{row.team_name}-{row.player_id}-{row.player_name}.png"
    return filename, card_bytes


def _attachment_header(filename: str, fallback: str = "download") -> str:
    encoded = quote(filename)
    safe_fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", fallback).strip("_") or "download"
    return f"attachment; filename=\"{safe_fallback}\"; filename*=UTF-8''{encoded}"


def _audit(
    db: Session,
    action: str,
    target_type: str,
    *,
    actor: User | None = None,
    target_id: str | None = None,
    match_id: UUID | str | None = None,
    severity: str = "INFO",
    details: dict | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_id=actor.id if actor else None,
            actor_name=actor.name if actor else None,
            actor_role=actor.role if actor else None,
            action=action,
            target_type=target_type,
            target_id=target_id,
            match_id=str(match_id) if match_id else None,
            severity=severity,
            details=details or {},
        )
    )


def _serialize_timeline_item(item: Event | MatchMarker) -> TimelineEditorListItem:
    if isinstance(item, Event):
        return TimelineEditorListItem(
            item_id=str(item.id),
            kind="EVENT",
            type=item.type,
            clock_ms=item.clock_ms,
            team=item.team,
            lane=item.lane,
            xg=item.xg,
            xgot=item.xgot,
            player_name=item.player_name,
            player_number=item.player_number,
            is_goal=bool(item.is_goal),
            is_on_target=bool(item.is_on_target),
            shot_x=item.shot_x,
            shot_y=item.shot_y,
            goalmouth_x=item.goalmouth_x,
            goalmouth_y=item.goalmouth_y,
            is_header=bool(item.is_header),
            is_weak_foot=bool(item.is_weak_foot),
            under_pressure=bool(item.under_pressure),
            one_on_one=bool(item.one_on_one),
            shot_pace_band=item.shot_pace_band,
            created_at=item.created_at.isoformat(),
        )
    return TimelineEditorListItem(
        item_id=str(item.id),
        kind="MARKER",
        type=item.marker_type,
        clock_ms=item.clock_ms,
        created_at=item.created_at.isoformat(),
    )


def _rebuild_match_projections(match_id: UUID, db: Session) -> None:
    db.query(DominanceBin).filter(DominanceBin.match_id == match_id).delete()
    db.flush()

    possession_rows = (
        db.query(PossessionSegment)
        .filter(PossessionSegment.match_id == match_id)
        .order_by(PossessionSegment.start_ms.asc(), PossessionSegment.created_at.asc(), PossessionSegment.id.asc())
        .all()
    )
    for seg in possession_rows:
        if seg.end_ms is None:
            continue
        apply_possession_segment(db, match_id, seg.team, seg.start_ms, seg.end_ms)

    xg_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "XG")
        .order_by(Event.clock_ms.asc(), Event.created_at.asc(), Event.id.asc())
        .all()
    )
    goal_boost = float(os.getenv("DOM_GOAL_XG_MULTIPLIER", "2.5"))
    for event in xg_rows:
        dominance_xg = (event.xg or 0.0) * goal_boost if event.is_goal else (event.xg or 0.0)
        apply_xg_event(db, match_id, event.team, event.clock_ms, dominance_xg)

    backfill_attack_scores(db, match_id)


def _apply_editor_item_updates(
    *,
    event: Event | None,
    marker: MatchMarker | None,
    body: TimelineEditorUpsertRequest,
) -> dict | None:
    if body.kind == "EVENT" and body.type == "ATTACK_LANE":
        if body.team is None or body.lane is None:
            raise HTTPException(status_code=400, detail="ATTACK_LANE requires team and lane")
        assert event is not None
        event.type = "ATTACK_LANE"
        event.clock_ms = body.clock_ms
        event.team = body.team
        event.lane = body.lane
        event.xg = None
        event.xgot = None
        event.player_name = None
        event.player_number = None
        event.is_goal = False
        event.is_on_target = False
        event.shot_x = None
        event.shot_y = None
        event.goalmouth_x = None
        event.goalmouth_y = None
        event.is_header = False
        event.is_weak_foot = False
        event.under_pressure = False
        event.one_on_one = False
        event.shot_pace_band = None
        return None

    if body.kind == "EVENT" and body.type == "XG":
        if body.team is None or body.xg is None:
            raise HTTPException(status_code=400, detail="XG event requires team and xg")
        assert event is not None
        xgot_meta = _estimate_xgot(
            body.xg,
            is_on_target=body.is_on_target,
            goalmouth_x=body.goalmouth_x,
            goalmouth_y=body.goalmouth_y,
            is_goal=body.is_goal,
            is_header=body.is_header,
            is_weak_foot=body.is_weak_foot,
            under_pressure=body.under_pressure,
            one_on_one=body.one_on_one,
            shot_pace_band=body.shot_pace_band,
        )
        event.type = "XG"
        event.clock_ms = body.clock_ms
        event.team = body.team
        event.lane = None
        event.xg = body.xg
        event.xgot = xgot_meta["xgot"]
        event.player_name = (body.player_name or "").strip() or None
        event.player_number = (body.player_number or "").strip() or None
        event.is_goal = body.is_goal
        event.is_on_target = body.is_on_target
        event.shot_x = body.shot_x
        event.shot_y = body.shot_y
        event.goalmouth_x = body.goalmouth_x
        event.goalmouth_y = body.goalmouth_y
        event.is_header = body.is_header
        event.is_weak_foot = body.is_weak_foot
        event.under_pressure = body.under_pressure
        event.one_on_one = body.one_on_one
        event.shot_pace_band = body.shot_pace_band
        return xgot_meta

    if body.kind == "MARKER" and body.type == "HALFTIME_START":
        assert marker is not None
        marker.marker_type = "HALFTIME_START"
        marker.clock_ms = body.clock_ms
        return None

    raise HTTPException(status_code=400, detail="Unsupported timeline item type")


def _match_is_live(match_id: UUID, db: Session) -> bool:
    last_state = _latest_state(match_id, db)
    return bool(last_state and last_state.running)


def _guard_live_dangerous_action(
    match_obj: Match,
    db: Session,
    *,
    confirm_live_action: bool,
    action_label: str,
) -> None:
    if confirm_live_action:
        return
    if _match_is_live(match_obj.id, db):
        raise HTTPException(
            status_code=409,
            detail=f"{action_label} blocked while match clock is running. Retry with explicit live-action confirmation.",
        )


def _enqueue_webhook_fanout(db: Session, kind: str, ref_id: UUID, payload: dict) -> None:
    default_target = os.getenv("WEBHOOK_STATE_URL") if kind == "STATE" else os.getenv("WEBHOOK_EVENT_URL")
    targets: set[str] = set()
    if default_target:
        targets.add(default_target)

    subs = db.query(WebhookSubscription).filter(WebhookSubscription.active.is_(True)).all()
    for sub in subs:
        events = sub.events or []
        if kind in events:
            targets.add(sub.callback_url)

    for target in targets:
        enqueue_outbox(db, kind, ref_id, target, payload)


def _serialize_webhook_subscription(row: WebhookSubscription) -> dict:
    return {
        "id": str(row.id),
        "callback_url": row.callback_url,
        "events": row.events or [],
        "active": row.active,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _basketball_fla_state(match_obj: Match) -> dict:
    metadata = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
    state = metadata.get("basketball_fla") if isinstance(metadata.get("basketball_fla"), dict) else {}
    return state


def _basketball_events(match_obj: Match) -> list[dict]:
    events = _basketball_fla_state(match_obj).get("events")
    return events if isinstance(events, list) else []


def _basketball_lineups(match_obj: Match) -> dict:
    state_lineups = _basketball_fla_state(match_obj).get("lineups")
    if isinstance(state_lineups, dict):
        return {
            "HOME": state_lineups.get("HOME") if isinstance(state_lineups.get("HOME"), list) else [],
            "AWAY": state_lineups.get("AWAY") if isinstance(state_lineups.get("AWAY"), list) else [],
        }
    metadata = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
    teams = metadata.get("lineups", {}).get("teams", {}) if isinstance(metadata.get("lineups"), dict) else {}
    return {
        "HOME": teams.get("HOME") if isinstance(teams.get("HOME"), list) else [],
        "AWAY": teams.get("AWAY") if isinstance(teams.get("AWAY"), list) else [],
    }


def _basketball_timer(match_obj: Match) -> dict:
    state_timer = _basketball_fla_state(match_obj).get("timer")
    metadata = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
    period_count = int(metadata.get("period_count") or 4)
    period_minutes = int(metadata.get("period_minutes") or 10)
    if isinstance(state_timer, dict):
        return {
            "period": int(state_timer.get("period") or 1),
            "clock": str(state_timer.get("clock") or f"{period_minutes:02d}:00"),
            "running": bool(state_timer.get("running") or False),
            "period_count": period_count,
            "period_minutes": period_minutes,
        }
    return {
        "period": 1,
        "clock": f"{period_minutes:02d}:00",
        "running": False,
        "period_count": period_count,
        "period_minutes": period_minutes,
    }


def _basketball_score(events: list[dict]) -> dict:
    if not events:
        return {"home": 0, "away": 0}
    last = events[-1] if isinstance(events[-1], dict) else {}
    return {"home": int(last.get("homeScoreAfter") or 0), "away": int(last.get("awayScoreAfter") or 0)}


def _basketball_rebound_stats(events: list[dict]) -> dict:
    stats = {
        "HOME": {"ar": 0, "dr": 0, "ra": 0},
        "AWAY": {"ar": 0, "dr": 0, "ra": 0},
    }
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "REBOUND":
            continue
        team = event.get("team")
        rebound_type = event.get("reboundType")
        allowed_team = event.get("reboundAllowedTeam")
        if team in stats and rebound_type == "AR":
            stats[team]["ar"] += 1
        if team in stats and rebound_type == "DR":
            stats[team]["dr"] += 1
        if allowed_team in stats:
            stats[allowed_team]["ra"] += 1
    return stats


def _basketball_event_created_at(event: dict) -> str | None:
    raw = event.get("timestamp")
    try:
        return datetime.utcfromtimestamp(float(raw) / 1000.0).isoformat()
    except (TypeError, ValueError, OverflowError):
        return None


def _serialize_basketball_event(match_id: UUID, event: dict, sequence: int) -> dict:
    if not isinstance(event, dict):
        event = {}
    event_id = str(event.get("id") or "")
    event_type = str(event.get("type") or "")
    return {
        "sequence": sequence,
        "event_id": event_id,
        "match_id": str(match_id),
        "sport": "BASKETBALL",
        "type": event_type,
        "team": event.get("team"),
        "player_number": event.get("playerNumber"),
        "period": event.get("period"),
        "clock": event.get("clock"),
        "timestamp": event.get("timestamp"),
        "created_at": _basketball_event_created_at(event),
        "zone_id": event.get("zoneId"),
        "shot_result": event.get("shotResult"),
        "points": event.get("points"),
        "rebound_type": event.get("reboundType"),
        "rebound_allowed_team": event.get("reboundAllowedTeam"),
        "x": event.get("x"),
        "y": event.get("y"),
        "home_score_after": int(event.get("homeScoreAfter") or 0),
        "away_score_after": int(event.get("awayScoreAfter") or 0),
        "margin_after": int(event.get("marginAfter") or 0),
    }


def _build_basketball_state(match_obj: Match) -> dict:
    metadata = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
    events = _basketball_events(match_obj)
    score = _basketball_score(events)
    last_event = _serialize_basketball_event(match_obj.id, events[-1], len(events)) if events else None
    return {
        "match_id": str(match_obj.id),
        "sport": "BASKETBALL",
        "name": match_obj.name,
        "home": {"name": metadata.get("home_team") or "HOME", "score": score["home"]},
        "away": {"name": metadata.get("away_team") or "AWAY", "score": score["away"]},
        "timer": _basketball_timer(match_obj),
        "lineups": _basketball_lineups(match_obj),
        "stats": {"rebounds": _basketball_rebound_stats(events)},
        "event_count": len(events),
        "last_event": last_event,
        "updated_at": _basketball_fla_state(match_obj).get("updated_at"),
    }


def _build_basketball_margin_flow(match_obj: Match) -> dict:
    events = _basketball_events(match_obj)
    points = []
    for sequence, event in enumerate(events, start=1):
        if not isinstance(event, dict) or event.get("type") != "SHOT" or event.get("shotResult") != "MADE":
            continue
        points.append(
            {
                "sequence": sequence,
                "event_id": str(event.get("id") or ""),
                "team": event.get("team"),
                "period": event.get("period"),
                "clock": event.get("clock"),
                "points": event.get("points"),
                "home_score_after": int(event.get("homeScoreAfter") or 0),
                "away_score_after": int(event.get("awayScoreAfter") or 0),
                "margin_after": int(event.get("marginAfter") or 0),
                "created_at": _basketball_event_created_at(event),
            }
        )
    return {"match_id": str(match_obj.id), "points": points}


def _build_dominance_annotations(
    rows: list[DominanceBin],
    *,
    goal_rows: list[Event],
    marker_rows: list[MatchMarker],
    bin_seconds: int,
) -> dict[int, dict]:
    bin_size_ms = bin_seconds * 1000
    annotations_by_k: dict[int, dict] = {}

    for event in goal_rows:
        k = event.clock_ms // bin_size_ms
        entry = annotations_by_k.setdefault(k, {"goal_summary": {"home": 0, "away": 0, "total": 0}, "markers": []})
        if event.team == "HOME":
            entry["goal_summary"]["home"] += 1
        elif event.team == "AWAY":
            entry["goal_summary"]["away"] += 1
        entry["goal_summary"]["total"] += 1

    for marker in marker_rows:
        k = marker.clock_ms // bin_size_ms
        entry = annotations_by_k.setdefault(k, {"goal_summary": {"home": 0, "away": 0, "total": 0}, "markers": []})
        if marker.marker_type == "HALFTIME_START" and "HT" not in entry["markers"]:
            entry["markers"].append("HT")

    cleaned: dict[int, dict] = {}
    valid_keys = {row.k for row in rows}
    for k, entry in annotations_by_k.items():
        if k not in valid_keys:
            continue
        payload: dict = {}
        if entry["goal_summary"]["total"] > 0:
            payload["goal_summary"] = entry["goal_summary"]
        if entry["markers"]:
            payload["markers"] = entry["markers"]
        if payload:
            cleaned[k] = payload
    return cleaned


def _latest_state(match_id: UUID, db: Session) -> State | None:
    return (
        db.query(State)
        .filter(State.match_id == match_id)
        .order_by(desc(State.created_at))
        .first()
    )


def _build_match_summary(match_id: UUID, db: Session) -> dict:
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")

    last_state = _latest_state(match_id, db)
    current_clock = last_state.clock_ms if last_state else 0

    poss_rows = db.query(PossessionSegment).filter(PossessionSegment.match_id == match_id).all()
    home_ms, away_ms = _accumulate_possession_ms(poss_rows, current_clock)

    poss_total = home_ms + away_ms
    home_pct = (home_ms / poss_total * 100.0) if poss_total else 0.0
    away_pct = (away_ms / poss_total * 100.0) if poss_total else 0.0

    ev_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id)
        .order_by(desc(Event.created_at))
        .limit(50)
        .all()
    )
    lane_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "ATTACK_LANE")
        .order_by(Event.clock_ms.asc(), Event.created_at.asc(), Event.id.asc())
        .all()
    )

    def lane_calc(team: str):
        left = center = right = 0
        team_lane_events = [e for e in lane_rows if e.team == team]
        for ev in team_lane_events:
            if ev.lane == "LEFT":
                left += 1
            elif ev.lane == "CENTER":
                center += 1
            elif ev.lane == "RIGHT":
                right += 1

        total = left + center + right
        return {
            "left_count": left,
            "center_count": center,
            "right_count": right,
            "left_pct": (left / total * 100.0) if total else 0.0,
            "center_pct": (center / total * 100.0) if total else 0.0,
            "right_pct": (right / total * 100.0) if total else 0.0,
            "total_count": total,
            "current_lane": team_lane_events[-1].lane if team_lane_events else None,
        }

    return {
        "match": {
            "id": str(match_obj.id),
            "name": match_obj.name,
            "hls_url": _normalize_hls_url(match_obj.hls_url),
            "operator_id": match_obj.operator_id,
        },
        "state": {
            "clock_ms": current_clock,
            "running": last_state.running if last_state else False,
            "possession_team": last_state.possession_team if last_state else "NONE",
            "selected_team": last_state.selected_team if last_state else "HOME",
            "attack_lr": last_state.attack_lr if last_state else "L2R",
        },
        "possession": {
            "home_ms": home_ms,
            "away_ms": away_ms,
            "home_pct": home_pct,
            "away_pct": away_pct,
        },
        "lanes": {
            "home": lane_calc("HOME"),
            "away": lane_calc("AWAY"),
        },
        "events": [
            {
                "id": str(e.id),
                "type": e.type,
                "clock_ms": e.clock_ms,
                "team": e.team,
                "lane": e.lane,
                "xg": e.xg,
                "xgot": e.xgot,
                **_event_player_payload(e),
                "is_goal": e.is_goal,
                "is_on_target": e.is_on_target,
                "shot_x": e.shot_x,
                "shot_y": e.shot_y,
                "goalmouth_x": e.goalmouth_x,
                "goalmouth_y": e.goalmouth_y,
                "is_header": e.is_header,
                "is_weak_foot": e.is_weak_foot,
                "under_pressure": e.under_pressure,
                "one_on_one": e.one_on_one,
                "shot_pace_band": e.shot_pace_band,
                "created_at": e.created_at.isoformat(),
            }
            for e in ev_rows
        ],
    }


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _compute_dominance_value(
    *,
    home_poss_ms: int,
    away_poss_ms: int,
    home_xg: float,
    away_xg: float,
    home_attack_score: float,
    away_attack_score: float,
) -> float:
    poss_total = home_poss_ms + away_poss_ms
    poss_balance = 0.0 if poss_total == 0 else (home_poss_ms - away_poss_ms) / poss_total
    xg_balance = _clamp((home_xg - away_xg) * DOM_XG_SCALE, -1.0, 1.0)
    attack_total = home_attack_score + away_attack_score
    attack_balance = 0.0 if attack_total == 0 else (home_attack_score - away_attack_score) / attack_total
    weight_sum = DOM_POSSESSION_WEIGHT + DOM_XG_WEIGHT + DOM_ATTACK_WEIGHT
    if weight_sum <= 0:
        poss_w = 0.35
        xg_w = 0.65
        attack_w = 0.0
    else:
        poss_w = DOM_POSSESSION_WEIGHT / weight_sum
        xg_w = DOM_XG_WEIGHT / weight_sum
        attack_w = DOM_ATTACK_WEIGHT / weight_sum
    return _clamp(
        poss_w * poss_balance + xg_w * xg_balance + attack_w * attack_balance,
        -1.0,
        1.0,
    )


def _build_split_halves_dominance(match_id: UUID, bin_seconds: int, db: Session) -> dict:
    if bin_seconds != 180:
        raise HTTPException(status_code=400, detail="Only 180-second bins are supported in MVP")

    bin_size_ms = bin_seconds * 1000
    last_state = _latest_state(match_id, db)
    current_clock_ms = last_state.clock_ms if last_state else 0

    possession_rows = (
        db.query(PossessionSegment)
        .filter(PossessionSegment.match_id == match_id)
        .order_by(PossessionSegment.start_ms.asc(), PossessionSegment.created_at.asc(), PossessionSegment.id.asc())
        .all()
    )
    xg_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "XG")
        .order_by(Event.clock_ms.asc(), Event.created_at.asc(), Event.id.asc())
        .all()
    )
    attack_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "ATTACK_LANE")
        .order_by(Event.clock_ms.asc(), Event.created_at.asc(), Event.id.asc())
        .all()
    )
    marker_rows = (
        db.query(MatchMarker)
        .filter(MatchMarker.match_id == match_id)
        .order_by(MatchMarker.clock_ms.asc(), MatchMarker.created_at.asc(), MatchMarker.id.asc())
        .all()
    )

    max_clock_ms = max(
        [
            current_clock_ms,
            *[seg.end_ms or current_clock_ms for seg in possession_rows],
            *[seg.start_ms for seg in possession_rows],
            *[row.clock_ms for row in xg_rows],
            *[row.clock_ms for row in attack_rows],
            *[row.clock_ms for row in marker_rows],
        ],
        default=0,
    )

    halftime_marker = next((marker for marker in marker_rows if marker.marker_type == "HALFTIME_START"), None)
    halftime_start_ms = halftime_marker.clock_ms if halftime_marker else None

    periods: list[dict] = []
    first_half_end_ms = halftime_start_ms if halftime_start_ms is not None else max_clock_ms
    periods.append({"period": 1, "start_ms": 0, "end_ms": max(0, first_half_end_ms)})
    if halftime_start_ms is not None and max_clock_ms > halftime_start_ms:
        periods.append({"period": 2, "start_ms": halftime_start_ms, "end_ms": max_clock_ms})

    bins: list[dict] = []
    half_gap_ms = bin_size_ms
    chart_cursor_ms = 0
    ht_chart_ms: int | None = None
    half_payloads: list[dict] = []

    for index, period in enumerate(periods):
        period_start_ms = period["start_ms"]
        period_end_ms = period["end_ms"]
        period_duration_ms = max(0, period_end_ms - period_start_ms)
        half_payloads.append({"period": period["period"], "duration_ms": period_duration_ms})
        if period_duration_ms <= 0:
            if index == 0 and len(periods) > 1:
                ht_chart_ms = chart_cursor_ms + half_gap_ms // 2
                chart_cursor_ms += half_gap_ms
            continue

        rel_start_ms = 0
        while rel_start_ms < period_duration_ms:
            rel_end_ms = min(rel_start_ms + bin_size_ms, period_duration_ms)
            abs_start_ms = period_start_ms + rel_start_ms
            abs_end_ms = period_start_ms + rel_end_ms

            home_poss_ms = 0
            away_poss_ms = 0
            for seg in possession_rows:
                seg_end_ms = seg.end_ms if seg.end_ms is not None else current_clock_ms
                overlap = max(0, min(abs_end_ms, seg_end_ms) - max(abs_start_ms, seg.start_ms))
                if overlap <= 0:
                    continue
                if seg.team == "HOME":
                    home_poss_ms += overlap
                elif seg.team == "AWAY":
                    away_poss_ms += overlap

            home_xg = 0.0
            away_xg = 0.0
            for event in xg_rows:
                if abs_start_ms <= event.clock_ms < abs_end_ms:
                    dominance_xg = (event.xg or 0.0) * DOM_GOAL_XG_MULTIPLIER if event.is_goal else (event.xg or 0.0)
                    if event.team == "HOME":
                        home_xg += dominance_xg
                    elif event.team == "AWAY":
                        away_xg += dominance_xg

            home_attack_score = 0.0
            away_attack_score = 0.0
            for event in attack_rows:
                if abs_start_ms <= event.clock_ms < abs_end_ms:
                    if event.team == "HOME":
                        home_attack_score += 1.0
                    elif event.team == "AWAY":
                        away_attack_score += 1.0

            annotations: dict = {}
            home_goals = 0
            away_goals = 0
            for event in xg_rows:
                if event.is_goal and abs_start_ms <= event.clock_ms < abs_end_ms:
                    if event.team == "HOME":
                        home_goals += 1
                    elif event.team == "AWAY":
                        away_goals += 1
            if home_goals or away_goals:
                annotations["goal_summary"] = {
                    "home": home_goals,
                    "away": away_goals,
                    "total": home_goals + away_goals,
                }

            markers: list[str] = []
            for marker in marker_rows:
                if abs_start_ms <= marker.clock_ms < abs_end_ms and marker.marker_type == "HALFTIME_START":
                    markers.append("HT")
            if markers:
                annotations["markers"] = markers

            chart_start_ms = chart_cursor_ms + rel_start_ms
            chart_end_ms = chart_cursor_ms + rel_end_ms
            payload = {
                "k": len(bins),
                "period": period["period"],
                "start_ms": abs_start_ms,
                "end_ms": abs_end_ms,
                "display_start_ms": rel_start_ms,
                "display_end_ms": rel_end_ms,
                "chart_start_ms": chart_start_ms,
                "chart_end_ms": chart_end_ms,
                "chart_midpoint_ms": chart_start_ms + ((chart_end_ms - chart_start_ms) // 2),
                "home_poss_ms": home_poss_ms,
                "away_poss_ms": away_poss_ms,
                "home_xg": home_xg,
                "away_xg": away_xg,
                "home_attack_score": home_attack_score,
                "away_attack_score": away_attack_score,
                "dominance": _compute_dominance_value(
                    home_poss_ms=home_poss_ms,
                    away_poss_ms=away_poss_ms,
                    home_xg=home_xg,
                    away_xg=away_xg,
                    home_attack_score=home_attack_score,
                    away_attack_score=away_attack_score,
                ),
            }
            if annotations:
                payload["annotations"] = annotations
            bins.append(payload)
            rel_start_ms = rel_end_ms

        chart_cursor_ms += period_duration_ms
        if index == 0 and len(periods) > 1:
            ht_chart_ms = chart_cursor_ms + half_gap_ms // 2
            chart_cursor_ms += half_gap_ms

    result = {
        "bin_seconds": bin_seconds,
        "split_halves": True,
        "half_gap_ms": half_gap_ms if len(periods) > 1 else 0,
        "halves": half_payloads,
        "bins": bins,
    }
    if ht_chart_ms is not None:
        result["ht_chart_ms"] = ht_chart_ms
    return result


def _build_dominance(match_id: UUID, bin_seconds: int, db: Session, *, split_halves: bool = False) -> dict:
    if split_halves:
        return _build_split_halves_dominance(match_id, bin_seconds, db)
    if bin_seconds != 180:
        raise HTTPException(status_code=400, detail="Only 180-second bins are supported in MVP")
    attack_event_count = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "ATTACK_LANE")
        .count()
    )
    rows = (
        db.query(DominanceBin)
        .filter(DominanceBin.match_id == match_id)
        .order_by(DominanceBin.k)
        .all()
    )
    if attack_event_count > 0 and sum(r.home_attack_score + r.away_attack_score for r in rows) == 0:
        backfill_attack_scores(db, match_id)
        db.commit()
        rows = (
            db.query(DominanceBin)
            .filter(DominanceBin.match_id == match_id)
            .order_by(DominanceBin.k)
            .all()
        )
    goal_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "XG", Event.is_goal.is_(True))
        .order_by(Event.clock_ms.asc(), Event.created_at.asc(), Event.id.asc())
        .all()
    )
    marker_rows = (
        db.query(MatchMarker)
        .filter(MatchMarker.match_id == match_id)
        .order_by(MatchMarker.clock_ms.asc(), MatchMarker.created_at.asc(), MatchMarker.id.asc())
        .all()
    )
    annotations_by_k = _build_dominance_annotations(
        rows,
        goal_rows=goal_rows,
        marker_rows=marker_rows,
        bin_seconds=bin_seconds,
    )
    return {
        "bin_seconds": bin_seconds,
        "bins": [
            {
                "k": r.k,
                "start_ms": r.start_ms,
                "end_ms": r.end_ms,
                "home_poss_ms": r.home_poss_ms,
                "away_poss_ms": r.away_poss_ms,
                "home_xg": r.home_xg,
                "away_xg": r.away_xg,
                "home_attack_score": r.home_attack_score,
                "away_attack_score": r.away_attack_score,
                "dominance": r.dominance,
                **({"annotations": annotations_by_k[r.k]} if r.k in annotations_by_k else {}),
            }
            for r in rows
        ],
    }


def _build_partner_match_result(match_id: UUID, db: Session) -> dict:
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")

    last_state = _latest_state(match_id, db)
    aggregate_clock_ms = last_state.clock_ms if last_state else 0

    poss_rows = (
        db.query(PossessionSegment)
        .filter(PossessionSegment.match_id == match_id)
        .order_by(PossessionSegment.start_ms.asc(), PossessionSegment.created_at.asc())
        .all()
    )
    home_ms = 0
    away_ms = 0
    for seg in poss_rows:
        end_ms = seg.end_ms if seg.end_ms is not None else aggregate_clock_ms
        dur = max(0, end_ms - seg.start_ms)
        if seg.team == "HOME":
            home_ms += dur
        elif seg.team == "AWAY":
            away_ms += dur
    poss_total = home_ms + away_ms

    lane_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "ATTACK_LANE")
        .order_by(Event.clock_ms.asc(), Event.created_at.asc())
        .all()
    )

    def _lane_payload(team: str) -> dict:
        match_aggregate_clock_ms = _normalize_match_clock_ms(aggregate_clock_ms, _clock_normalization_context(match_id, db))
        team_rows = [r for r in lane_rows if r.team == team]
        left = sum(1 for r in team_rows if r.lane == "LEFT")
        center = sum(1 for r in team_rows if r.lane == "CENTER")
        right = sum(1 for r in team_rows if r.lane == "RIGHT")
        total = left + center + right
        current_lane = team_rows[-1].lane if team_rows else None
        return {
            "match_name": match_obj.name,
            "match_id": str(match_obj.id),
            "aggregate_clock_ms": match_aggregate_clock_ms,
            "aggregate_clock": _fmt_clock_ms(match_aggregate_clock_ms),
            "raw_aggregate_clock_ms": aggregate_clock_ms,
            "raw_aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
            "team": team,
            "direction": current_lane,
            "direction_ratio": {
                "left_pct": (left / total * 100.0) if total else 0.0,
                "center_pct": (center / total * 100.0) if total else 0.0,
                "right_pct": (right / total * 100.0) if total else 0.0,
                "total_count": total,
            },
        }

    xg_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "XG")
        .order_by(Event.clock_ms.asc(), Event.created_at.asc())
        .all()
    )

    dom_rows = (
        db.query(DominanceBin)
        .filter(DominanceBin.match_id == match_id)
        .order_by(DominanceBin.k.asc())
        .all()
    )
    marker_rows = (
        db.query(MatchMarker)
        .filter(MatchMarker.match_id == match_id)
        .order_by(MatchMarker.clock_ms.asc(), MatchMarker.created_at.asc(), MatchMarker.id.asc())
        .all()
    )
    goal_rows = [r for r in xg_rows if r.is_goal]
    annotations_by_k = _build_dominance_annotations(
        dom_rows,
        goal_rows=goal_rows,
        marker_rows=marker_rows,
        bin_seconds=180,
    )
    clock_context = _clock_normalization_context(match_id, db)
    match_aggregate_clock_ms = _normalize_match_clock_ms(aggregate_clock_ms, clock_context)

    return {
        "match_name": match_obj.name,
        "match_id": str(match_obj.id),
        "aggregate_clock_ms": match_aggregate_clock_ms,
        "aggregate_clock": _fmt_clock_ms(match_aggregate_clock_ms),
        "raw_aggregate_clock_ms": aggregate_clock_ms,
        "raw_aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
        "possession": {
            "match_name": match_obj.name,
            "match_id": str(match_obj.id),
            "aggregate_clock_ms": match_aggregate_clock_ms,
            "aggregate_clock": _fmt_clock_ms(match_aggregate_clock_ms),
            "raw_aggregate_clock_ms": aggregate_clock_ms,
            "raw_aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
            "home_pct": (home_ms / poss_total * 100.0) if poss_total else 0.0,
            "away_pct": (away_ms / poss_total * 100.0) if poss_total else 0.0,
        },
        "attack_direction": [
            _lane_payload("HOME"),
            _lane_payload("AWAY"),
        ],
        "xg": [
            {
                "match_name": match_obj.name,
                "match_id": str(match_obj.id),
                "aggregate_clock_ms": match_aggregate_clock_ms,
                "aggregate_clock": _fmt_clock_ms(match_aggregate_clock_ms),
                "raw_aggregate_clock_ms": aggregate_clock_ms,
                "raw_aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
                "event_clock_ms": _normalize_match_clock_ms(r.clock_ms, clock_context),
                "event_clock": _fmt_clock_ms(_normalize_match_clock_ms(r.clock_ms, clock_context)),
                "raw_event_clock_ms": r.clock_ms,
                "raw_event_clock": _fmt_clock_ms(r.clock_ms),
                "team": r.team,
                "xg": r.xg,
                "xgot": r.xgot,
                **_event_player_payload(r),
                "is_goal": r.is_goal,
                "is_on_target": r.is_on_target,
                "shot_x": r.shot_x,
                "shot_y": r.shot_y,
                "goalmouth_x": r.goalmouth_x,
                "goalmouth_y": r.goalmouth_y,
                "is_header": r.is_header,
                "is_weak_foot": r.is_weak_foot,
                "under_pressure": r.under_pressure,
                "one_on_one": r.one_on_one,
                "shot_pace_band": r.shot_pace_band,
                "event_id": str(r.id),
                "created_at": r.created_at.isoformat(),
            }
            for r in xg_rows
        ],
        "match_dominance": {
            "match_name": match_obj.name,
            "match_id": str(match_obj.id),
            "aggregate_clock_ms": match_aggregate_clock_ms,
            "aggregate_clock": _fmt_clock_ms(match_aggregate_clock_ms),
            "raw_aggregate_clock_ms": aggregate_clock_ms,
            "raw_aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
            "bin_seconds": 180,
            "items": [
                {
                    "base_time_ms": r.start_ms,
                    "base_time": _fmt_clock_ms(r.start_ms),
                    "dominance": r.dominance,
                    **({"annotations": annotations_by_k[r.k]} if r.k in annotations_by_k else {}),
                }
                for r in dom_rows
            ],
        },
    }


def _parse_iso_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(raw)
    except ValueError as ex:
        raise HTTPException(status_code=400, detail="Invalid 'since' ISO datetime") from ex


def _as_naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _fmt_clock_ms(ms: int) -> str:
    s = max(0, ms // 1000)
    hh = s // 3600
    mm = (s % 3600) // 60
    ss = s % 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


def _clock_normalization_context(match_id: UUID, db: Session) -> dict:
    match_obj = db.get(Match, match_id)
    base_first_half = int(match_obj.first_half_minutes if match_obj else 45) * 60_000
    base_second_half = int(match_obj.second_half_minutes if match_obj else 45) * 60_000
    marker = (
        db.query(MatchMarker)
        .filter(MatchMarker.match_id == match_id, MatchMarker.marker_type == "HALFTIME_START")
        .order_by(MatchMarker.clock_ms.asc(), MatchMarker.created_at.asc(), MatchMarker.id.asc())
        .first()
    )
    return {
        "first_half_ms": base_first_half,
        "second_half_ms": base_second_half,
        "halftime_start_ms": marker.clock_ms if marker else None,
    }


def _normalize_match_clock_ms(clock_ms: int, context: dict) -> int:
    raw_ms = max(0, int(clock_ms or 0))
    first_half_ms = int(context.get("first_half_ms") or 45 * 60_000)
    second_half_ms = int(context.get("second_half_ms") or 45 * 60_000)
    halftime_start_ms = context.get("halftime_start_ms")
    if halftime_start_ms is not None and raw_ms >= int(halftime_start_ms):
        normalized = first_half_ms + max(0, raw_ms - int(halftime_start_ms))
    else:
        normalized = raw_ms
    return min(normalized, first_half_ms + second_half_ms)


def _event_player_payload(event: Event) -> dict:
    player_number = (event.player_number or "").strip()
    player_name = (event.player_name or "").strip()
    return {
        "team_side": "H" if event.team == "HOME" else "A" if event.team == "AWAY" else event.team,
        "player_number": player_number or None,
        "player_name": player_name or None,
    }


def _parse_lineup_pdf(file_bytes: bytes, *, first_team_side: str = "HOME") -> dict:
    try:
        reader = PdfReader(io.BytesIO(file_bytes))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as ex:
        raise HTTPException(status_code=400, detail=f"Could not read lineup PDF: {ex}") from ex

    sections = re.split(r"선발출전선수\(총경기시간:\d+분\)", text)
    if len(sections) < 3:
        raise HTTPException(status_code=400, detail="Could not find two lineup sections in PDF")

    def normalize_player_line(line: str) -> dict | None:
        line = re.sub(r"\s*\(주장\)\s*", " ", line).strip()
        match = re.match(r"^(?P<number>\d{1,3})\s+(?P<position>GK|DF|MF|FW)\s+(?P<name>[가-힣A-Za-z.'· -]+?)(?:\s+\d.*)?$", line)
        if not match:
            return None
        number = match.group("number").strip()
        raw_name = match.group("name").strip()
        name = raw_name.strip()
        if not name:
            return None
        return {
            "number": number,
            "position": match.group("position"),
            "name": name,
            "label": f"No.{number} {name}",
        }

    def parse_starters(section: str) -> list[dict]:
        players_by_number: dict[str, dict] = {}
        in_player_table = False
        collected = False
        for raw_line in section.splitlines():
            line = re.sub(r"\s+", " ", raw_line).strip()
            if not line:
                continue
            if line.replace(" ", "").startswith("배번포지션선수이름"):
                in_player_table = True
                continue
            if not in_player_table:
                continue
            player = normalize_player_line(line)
            if player:
                players_by_number[player["number"]] = player
                collected = True
            elif collected:
                break
        return sorted(players_by_number.values(), key=lambda item: int(item["number"]))

    candidate_header_pattern = r"후보선수\s+배번\s*포지션\s*선수이름\s*득점\s*도움\s*경고\s*퇴장\s*PSO"

    def parse_candidate_blocks(full_text: str) -> list[list[dict]]:
        blocks: list[list[dict]] = []
        for match in re.finditer(rf"{candidate_header_pattern}(?P<body>.*?)(?:교체선수|자책골|지도자/임원|$)", full_text, re.S):
            players_by_number: dict[str, dict] = {}
            for raw_line in match.group("body").splitlines():
                line = re.sub(r"\s+", " ", raw_line).strip()
                player = normalize_player_line(line)
                if player:
                    players_by_number[player["number"]] = player
            blocks.append(sorted(players_by_number.values(), key=lambda item: int(item["number"])))
        return blocks[:2]

    def parse_continuation_blocks(full_text: str) -> list[list[dict]]:
        blocks: list[list[dict]] = []
        for match in re.finditer(candidate_header_pattern, full_text):
            players: list[dict] = []
            for raw_line in reversed(full_text[: match.start()].splitlines()):
                line = re.sub(r"\s+", " ", raw_line).strip()
                player = normalize_player_line(line)
                if player:
                    players.append(player)
                    continue
                if players:
                    break
            blocks.append(list(reversed(players)))
        return blocks[:2]

    first_side = first_team_side.strip().upper()
    if first_side not in {"HOME", "AWAY"}:
        first_side = "HOME"
    second_side = "AWAY" if first_side == "HOME" else "HOME"
    candidate_blocks = parse_candidate_blocks(text)
    continuation_blocks = parse_continuation_blocks(text)
    lineups = {
        first_side: parse_starters(sections[1]) + (continuation_blocks[0] if len(continuation_blocks) > 0 else []) + (candidate_blocks[0] if len(candidate_blocks) > 0 else []),
        second_side: parse_starters(sections[2]) + (continuation_blocks[1] if len(continuation_blocks) > 1 else []) + (candidate_blocks[1] if len(candidate_blocks) > 1 else []),
    }
    for side, players in lineups.items():
        deduped = {player["number"]: player for player in players}
        lineups[side] = sorted(deduped.values(), key=lambda item: int(item["number"]))
    return {
        "source": "match_record_pdf",
        "first_team_side": first_side,
        "teams": {
            "HOME": lineups.get("HOME", []),
            "AWAY": lineups.get("AWAY", []),
        },
    }


def _empty_lineup(source: str = "manual") -> dict:
    return {
        "source": source,
        "teams": {
            "HOME": [],
            "AWAY": [],
        },
    }


def _normalize_lineup_player(number: str, name: str, position: str | None = None) -> dict:
    normalized_number = re.sub(r"\D", "", number or "")
    normalized_name = re.sub(r"\s+", " ", name or "").strip()
    normalized_position = (position or "").strip().upper()
    if not normalized_number:
        raise HTTPException(status_code=400, detail="Player number is required")
    if int(normalized_number) < 0:
        raise HTTPException(status_code=400, detail="Invalid player number")
    if not normalized_name:
        raise HTTPException(status_code=400, detail="Player name is required")
    if normalized_position not in {"GK", "DF", "MF", "FW"}:
        normalized_position = ""
    player = {
        "number": normalized_number,
        "name": normalized_name,
        "label": f"No.{normalized_number} {normalized_name}",
    }
    if normalized_position:
        player["position"] = normalized_position
    return player


def _lineup_sort_key(player: dict) -> tuple[int, str]:
    number = re.sub(r"\D", "", str(player.get("number") or ""))
    return (int(number) if number else 999, str(player.get("name") or ""))


def _upsert_manual_lineup_player(match_obj: Match, body: LineupManualPlayerRequest) -> dict:
    metadata = dict(match_obj.metadata_json or {})
    lineup = dict(metadata.get("lineups") or _empty_lineup())
    teams = dict(lineup.get("teams") or {})
    for side in ("HOME", "AWAY"):
        teams[side] = list(teams.get(side) or [])

    player = _normalize_lineup_player(body.number, body.name, body.position)
    side_players = [item for item in teams[body.side] if str(item.get("number") or "") != player["number"]]
    side_players.append(player)
    teams[body.side] = sorted(side_players, key=_lineup_sort_key)
    lineup["teams"] = teams
    if lineup.get("source") not in {"match_record_pdf", "manual", "manual_or_pdf"}:
        lineup["source"] = "manual"
    elif lineup.get("source") == "match_record_pdf":
        lineup["source"] = "manual_or_pdf"
    metadata["lineups"] = lineup
    metadata["lineup_manual_updated_at"] = datetime.utcnow().isoformat()
    match_obj.metadata_json = metadata
    return lineup


def _delete_manual_lineup_player(match_obj: Match, body: LineupManualPlayerDeleteRequest) -> dict:
    metadata = dict(match_obj.metadata_json or {})
    lineup = dict(metadata.get("lineups") or _empty_lineup())
    teams = dict(lineup.get("teams") or {})
    for side in ("HOME", "AWAY"):
        teams[side] = list(teams.get(side) or [])

    normalized_number = re.sub(r"\D", "", body.number or "")
    if not normalized_number:
        raise HTTPException(status_code=400, detail="Player number is required")
    teams[body.side] = [item for item in teams[body.side] if str(item.get("number") or "") != normalized_number]
    lineup["teams"] = teams
    metadata["lineups"] = lineup
    metadata["lineup_manual_updated_at"] = datetime.utcnow().isoformat()
    match_obj.metadata_json = metadata
    return lineup


def _swap_lineup_sides(match_obj: Match) -> dict:
    metadata = dict(match_obj.metadata_json or {})
    lineup = dict(metadata.get("lineups") or _empty_lineup())
    teams = dict(lineup.get("teams") or {})
    home_players = list(teams.get("HOME") or [])
    away_players = list(teams.get("AWAY") or [])
    if not home_players and not away_players:
        raise HTTPException(status_code=400, detail="No lineup players to swap")

    teams["HOME"] = sorted(away_players, key=_lineup_sort_key)
    teams["AWAY"] = sorted(home_players, key=_lineup_sort_key)
    lineup["teams"] = teams
    first_side = str(lineup.get("first_team_side") or "").upper()
    if first_side in {"HOME", "AWAY"}:
        lineup["first_team_side"] = "AWAY" if first_side == "HOME" else "HOME"
    metadata["lineups"] = lineup
    metadata["lineup_manual_updated_at"] = datetime.utcnow().isoformat()
    match_obj.metadata_json = metadata
    return lineup


def _accumulate_possession_ms(poss_rows: list[PossessionSegment], current_clock_ms: int) -> tuple[int, int]:
    home_ms = 0
    away_ms = 0
    ordered_rows = sorted(poss_rows, key=lambda seg: (seg.start_ms, seg.created_at, seg.id))

    for idx, seg in enumerate(ordered_rows):
        end_ms = seg.end_ms if seg.end_ms is not None else current_clock_ms
        if idx + 1 < len(ordered_rows):
            end_ms = min(end_ms, ordered_rows[idx + 1].start_ms)
        dur = max(0, end_ms - seg.start_ms)
        if seg.team == "HOME":
            home_ms += dur
        elif seg.team == "AWAY":
            away_ms += dur

    return home_ms, away_ms


def _normalize_stale_open_possession_segments(match_id: UUID, db: Session) -> None:
    poss_rows = (
        db.query(PossessionSegment)
        .filter(PossessionSegment.match_id == match_id)
        .order_by(PossessionSegment.start_ms.asc(), PossessionSegment.created_at.asc(), PossessionSegment.id.asc())
        .all()
    )

    for idx, seg in enumerate(poss_rows[:-1]):
        if seg.end_ms is not None:
            continue
        next_start_ms = poss_rows[idx + 1].start_ms
        if next_start_ms < seg.start_ms:
            continue
        seg.end_ms = next_start_ms
        apply_possession_segment(db, match_id, seg.team, seg.start_ms, seg.end_ms)


def _csv_safe(value: object | None) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:.6f}".rstrip("0").rstrip(".")
    return str(value)


def _build_match_export_csv(match_id: UUID, db: Session) -> tuple[str, str]:
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")

    last_state = _latest_state(match_id, db)
    current_clock_ms = last_state.clock_ms if last_state else 0
    exported_at = datetime.utcnow().isoformat()

    event_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id)
        .order_by(Event.clock_ms.asc(), Event.created_at.asc(), Event.id.asc())
        .all()
    )
    possession_rows = (
        db.query(PossessionSegment)
        .filter(PossessionSegment.match_id == match_id)
        .order_by(PossessionSegment.start_ms.asc(), PossessionSegment.created_at.asc(), PossessionSegment.id.asc())
        .all()
    )
    dominance_rows = (
        db.query(DominanceBin)
        .filter(DominanceBin.match_id == match_id)
        .order_by(DominanceBin.k.asc())
        .all()
    )

    headers = [
        "record_type",
        "match_id",
        "match_name",
        "exported_at",
        "match_created_at",
        "operator_id",
        "current_clock_ms",
        "current_clock_label",
        "event_id",
        "event_type",
        "event_created_at",
        "event_clock_ms",
        "event_clock_label",
        "team",
        "team_side",
        "player_number",
        "player_name",
        "lane",
        "xg",
        "xgot",
        "is_goal",
        "is_on_target",
        "shot_x",
        "shot_y",
        "goalmouth_x",
        "goalmouth_y",
        "is_header",
        "is_weak_foot",
        "under_pressure",
        "one_on_one",
        "shot_pace_band",
        "segment_id",
        "segment_start_ms",
        "segment_start_label",
        "segment_end_ms",
        "segment_end_label",
        "segment_duration_ms",
        "bin_k",
        "bin_start_ms",
        "bin_start_label",
        "bin_end_ms",
        "bin_end_label",
        "home_poss_ms",
        "away_poss_ms",
        "home_xg",
        "away_xg",
        "dominance",
    ]

    base_row = {
        "match_id": str(match_obj.id),
        "match_name": match_obj.name,
        "exported_at": exported_at,
        "match_created_at": match_obj.created_at.isoformat(),
        "operator_id": match_obj.operator_id or "",
        "current_clock_ms": current_clock_ms,
        "current_clock_label": _fmt_clock_ms(current_clock_ms),
    }

    records: list[dict[str, object | None]] = [
        {
            **base_row,
            "record_type": "MATCH_META",
        }
    ]

    for event in event_rows:
        records.append(
            {
                **base_row,
                "record_type": "XG_EVENT" if event.type == "XG" else "ATTACK_LANE_EVENT",
                "event_id": str(event.id),
                "event_type": event.type,
                "event_created_at": event.created_at.isoformat(),
                "event_clock_ms": event.clock_ms,
                "event_clock_label": _fmt_clock_ms(event.clock_ms),
                "team": event.team,
                "lane": event.lane,
                "xg": event.xg,
                "xgot": event.xgot,
                "team_side": "H" if event.team == "HOME" else "A" if event.team == "AWAY" else event.team,
                "player_number": event.player_number or "",
                "player_name": event.player_name or "",
                "is_goal": event.is_goal,
                "is_on_target": event.is_on_target,
                "shot_x": event.shot_x,
                "shot_y": event.shot_y,
                "goalmouth_x": event.goalmouth_x,
                "goalmouth_y": event.goalmouth_y,
                "is_header": event.is_header,
                "is_weak_foot": event.is_weak_foot,
                "under_pressure": event.under_pressure,
                "one_on_one": event.one_on_one,
                "shot_pace_band": event.shot_pace_band,
            }
        )

    for segment in possession_rows:
        segment_end_ms = segment.end_ms if segment.end_ms is not None else current_clock_ms
        records.append(
            {
                **base_row,
                "record_type": "POSSESSION_SEGMENT",
                "segment_id": str(segment.id),
                "team": segment.team,
                "segment_start_ms": segment.start_ms,
                "segment_start_label": _fmt_clock_ms(segment.start_ms),
                "segment_end_ms": segment_end_ms,
                "segment_end_label": _fmt_clock_ms(segment_end_ms),
                "segment_duration_ms": max(0, segment_end_ms - segment.start_ms),
            }
        )

    for bin_row in dominance_rows:
        records.append(
            {
                **base_row,
                "record_type": "DOMINANCE_BIN",
                "bin_k": bin_row.k,
                "bin_start_ms": bin_row.start_ms,
                "bin_start_label": _fmt_clock_ms(bin_row.start_ms),
                "bin_end_ms": bin_row.end_ms,
                "bin_end_label": _fmt_clock_ms(bin_row.end_ms),
                "home_poss_ms": bin_row.home_poss_ms,
                "away_poss_ms": bin_row.away_poss_ms,
                "home_xg": bin_row.home_xg,
                "away_xg": bin_row.away_xg,
                "dominance": bin_row.dominance,
            }
        )

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=headers, extrasaction="ignore")
    writer.writeheader()
    for record in records:
        writer.writerow({key: _csv_safe(record.get(key)) for key in headers})

    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"match_export_{match_obj.id}_{timestamp}.csv"
    return output.getvalue(), filename


def _require_partner_auth(x_api_key: str | None = Header(default=None, alias="X-API-Key")) -> None:
    required = os.getenv("PARTNER_API_KEY", "").strip()
    if not required:
        return
    if x_api_key != required:
        raise HTTPException(status_code=401, detail="Invalid API key")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "time": datetime.utcnow().isoformat()}


@app.post("/api/session/login", response_model=SessionUserResponse)
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user_name = body.name.strip()
    user_id = _slugify_user_id(user_name)
    role = _resolve_login_role(body.access_key)

    existing = db.get(User, user_id)
    if existing:
        existing.name = user_name
        existing.role = role
        user = existing
    else:
        user = User(id=user_id, name=user_name, role=role)
        db.add(user)

    db.commit()
    db.refresh(user)
    _set_session_cookie(response, user.id)
    _audit(db, "SESSION_LOGIN", "session", actor=user, target_id=user.id, severity="INFO")
    db.commit()
    return {"id": user.id, "name": user.name, "role": user.role}


@app.post("/api/session/logout")
def logout(response: Response):
    _clear_session_cookie(response)
    return {"ok": True}


@app.get("/api/session/me", response_model=SessionUserResponse)
def current_session(user: User = Depends(_require_session_user)):
    return {"id": user.id, "name": user.name, "role": user.role}


@app.post("/api/xg/estimate")
def estimate_xg(body: XGEstimateRequest):
    return _estimate_xg(
        body.team,
        body.attack_lr,
        body.start_x,
        body.start_y,
        body.is_header,
        body.is_weak_foot,
    )


@app.post("/api/xgot/estimate")
def estimate_xgot(body: XGOTEstimateRequest):
    return _estimate_xgot(
        body.xg,
        is_on_target=body.is_on_target,
        goalmouth_x=body.goalmouth_x,
        goalmouth_y=body.goalmouth_y,
        is_goal=body.is_goal,
        is_header=body.is_header,
        is_weak_foot=body.is_weak_foot,
        under_pressure=body.under_pressure,
        one_on_one=body.one_on_one,
        shot_pace_band=body.shot_pace_band,
    )


@app.post("/api/fpa/logs/generate", response_model=FpaGenerateLogResponse)
def generate_fpa_log(body: FpaGenerateLogRequest):
    try:
        return generate_log_entry(
            stat_input=body.stat_input,
            dots=[dot.model_dump() for dot in body.dots],
            half=body.half,
            team=body.team,
            direction=body.direction,
            timeline=body.timeline,
        )
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex


@app.post("/api/fpa/analyze/export")
def export_fpa_logs(body: FpaExportLogsRequest):
    if not body.logs:
        raise HTTPException(status_code=400, detail="No logs to process")
    try:
        df = parse_logs_to_dataframe(body.logs, body.match_id, body.teamid_h, body.teamid_a)
        workbook = build_analysis_workbook(df)
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex)) from ex

    headers = {"Content-Disposition": 'attachment; filename="fpa_live_analyzed_data.xlsx"'}
    return Response(
        content=workbook,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/fpa/analyze/upload")
async def analyze_fpa_file(file: UploadFile = File(...)):
    try:
        workbook = build_analysis_workbook(await file.read())
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex)) from ex

    filename = (file.filename or "uploaded").rsplit(".", 1)[0]
    headers = {"Content-Disposition": f'attachment; filename="{filename}_analyzed.xlsx"'}
    return Response(
        content=workbook,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/fpa/players/extract", response_model=FpaPlayersResponse)
async def extract_fpa_players(file: UploadFile = File(...)):
    try:
        return {"players": extract_players(await file.read())}
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex)) from ex


@app.post("/api/fpa/logs/import", response_model=FpaImportLogsResponse)
async def import_fpa_logs(file: UploadFile = File(...)):
    try:
        return import_logs_from_workbook(await file.read())
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex


@app.get("/api/fpa/matches/{match_id}/logs", response_model=FpaSavedLogsResponse)
def get_fpa_saved_logs(match_id: UUID, db: Session = Depends(get_db), _user: User = Depends(_require_session_user)):
    if not db.get(Match, match_id):
        raise HTTPException(status_code=404, detail="Match not found")
    return _serialize_fpa_saved_log(db.get(FpaSavedLog, match_id), match_id)


@app.put("/api/fpa/matches/{match_id}/logs", response_model=FpaSavedLogsResponse)
def save_fpa_logs(
    match_id: UUID,
    body: FpaSavedLogsRequest,
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    if not db.get(Match, match_id):
        raise HTTPException(status_code=404, detail="Match not found")
    row = db.get(FpaSavedLog, match_id)
    if not row:
        row = FpaSavedLog(match_id=match_id)
        db.add(row)
    row.logs = list(body.logs or [])
    row.rows = list(body.rows or [])
    row.teamid_h = body.teamid_h.strip()
    row.teamid_a = body.teamid_a.strip()
    row.saved_by = user.id
    row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return _serialize_fpa_saved_log(row, match_id)


@app.get("/api/fpa/matches/{match_id}/logs/export.xlsx")
def export_fpa_saved_logs(match_id: UUID, db: Session = Depends(get_db), _user: User = Depends(_require_session_user)):
    row = db.get(FpaSavedLog, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="No saved FPA logs for this match")
    workbook = _build_fpa_workbook_from_saved_log(row)
    headers = {"Content-Disposition": _attachment_header(f"fpa_{match_id}_analyzed.xlsx", "fpa_analyzed.xlsx")}
    return Response(
        content=workbook,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.get("/api/data-hub/matches")
def list_data_hub_matches(sport: str | None = Query(default=None), db: Session = Depends(get_db), _user: User = Depends(_require_session_user)):
    query = db.query(Match)
    if sport:
        query = query.filter(Match.sport == _normalize_sport(sport))
    matches = query.order_by(desc(Match.created_at)).all()
    fpa_ids = {str(row.match_id) for row in db.query(FpaSavedLog).all() if row.logs}
    return [
        {
            **_serialize_match(match),
            "has_fla_data": True,
            "has_fpa_logs": str(match.id) in fpa_ids,
        }
        for match in matches
    ]


@app.post("/api/fcm/analyze", response_model=FcmAnalyzeWorkbookResponse)
async def analyze_fcm_workbook(
    file: UploadFile = File(...),
    match_id: UUID | None = Form(default=None),
    team_side: str | None = Form(default=None),
):
    try:
        file_bytes = await file.read()
        if match_id:
            _fcm_shared_workbook_path(match_id).write_bytes(file_bytes)
            if team_side:
                workbook_path = _fcm_workbook_path(match_id, _normalize_fcm_team_side(team_side))
                workbook_path.write_bytes(file_bytes)
        return analyze_card_workbook(file_bytes)
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex)) from ex


@app.post("/api/fcm/matches/{match_id}/analyze-fpa-logs", response_model=FcmAnalyzeWorkbookResponse)
def analyze_fcm_from_saved_fpa_logs(match_id: UUID, db: Session = Depends(get_db), _user: User = Depends(_require_session_user)):
    row = db.get(FpaSavedLog, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="No saved FPA logs for this match")
    try:
        workbook = _build_fpa_workbook_from_saved_log(row)
        _fcm_shared_workbook_path(match_id).write_bytes(workbook)
        return analyze_card_workbook(workbook)
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex)) from ex



@app.get("/api/fcm/submissions", response_model=list[FcmSubmissionResponse])
def list_fcm_submissions(db: Session = Depends(get_db), _user: User = Depends(_require_session_user)):
    rows = db.query(FcmSubmission).order_by(desc(FcmSubmission.updated_at)).all()
    return [_serialize_fcm_submission(row) for row in rows]


@app.get("/api/fcm/templates", response_model=list[FcmTemplateResponse])
def list_fcm_templates(db: Session = Depends(get_db), _user: User = Depends(_require_session_user)):
    rows = db.query(FcmTemplate).order_by(FcmTemplate.priority.asc(), FcmTemplate.created_at.asc()).all()
    return [_serialize_fcm_template(row) for row in rows]


@app.post("/api/fcm/templates", response_model=FcmTemplateResponse)
async def create_fcm_template(
    name: str = Form(...),
    competition_class: str = Form(...),
    match_regex: str = Form(...),
    priority: int = Form(default=100),
    active: bool = Form(default=True),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _user: User = Depends(_require_session_user),
):
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Template name is required")
    clean_class = _validate_fcm_template_competition_class(db, competition_class)
    clean_regex = _validate_fcm_template_regex(match_regex)

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg"}:
        raise HTTPException(status_code=400, detail="Template image must be PNG or JPG")

    FCM_TEMPLATE_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    template_id = uuid.uuid4()
    image_path = FCM_TEMPLATE_RUNTIME_DIR / f"{template_id}{suffix}"
    image_bytes = await file.read()
    try:
        Image.open(io.BytesIO(image_bytes)).verify()
    except Exception as ex:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid image") from ex
    image_path.write_bytes(image_bytes)

    row = FcmTemplate(
        id=template_id,
        name=clean_name,
        competition_class=clean_class,
        match_regex=clean_regex,
        image_path=str(image_path),
        priority=max(1, priority),
        active=active,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize_fcm_template(row)


@app.put("/api/fcm/templates/{template_id}", response_model=FcmTemplateResponse)
def update_fcm_template(
    template_id: UUID,
    body: FcmTemplateUpdateRequest,
    db: Session = Depends(get_db),
    _user: User = Depends(_require_session_user),
):
    row = db.get(FcmTemplate, template_id)
    if not row:
        raise HTTPException(status_code=404, detail="Template not found")

    clean_name = body.name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Template name is required")

    row.name = clean_name
    row.competition_class = _validate_fcm_template_competition_class(db, body.competition_class)
    row.match_regex = _validate_fcm_template_regex(body.match_regex)
    row.priority = max(1, int(body.priority or 1))
    row.active = bool(body.active)
    row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return _serialize_fcm_template(row)


@app.get("/api/fcm/templates/{template_id}/image")
def get_fcm_template_image(template_id: UUID, db: Session = Depends(get_db), _user: User = Depends(_require_session_user)):
    row = db.get(FcmTemplate, template_id)
    if not row:
        raise HTTPException(status_code=404, detail="Template not found")
    path = Path(row.image_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Template image not found")
    media_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return Response(content=path.read_bytes(), media_type=media_type)


@app.get("/api/fcm/generate")
def generate_fcm_cards(
    league: str = Query(...),
    round: int = Query(..., ge=1, le=99),
    match_id: UUID | None = Query(default=None),
    team_side: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: User = Depends(_require_session_user),
):
    normalized_league = _normalize_competition_class(league)
    query = db.query(FcmSubmission).filter(
        FcmSubmission.competition_class == normalized_league,
        FcmSubmission.round_number == round,
    )
    if match_id:
        query = query.filter(FcmSubmission.match_id == match_id)
    normalized_side = None
    if team_side:
        normalized_side = _normalize_fcm_team_side(team_side)
        query = query.filter(FcmSubmission.team_side == normalized_side)

    rows = query.order_by(FcmSubmission.match_id.asc(), FcmSubmission.team_side.asc(), desc(FcmSubmission.updated_at)).all()

    if match_id and normalized_side:
        row = rows[0] if rows else None
        if not row:
            raise HTTPException(status_code=404, detail="FCM submission not found")
        try:
            filename, card_bytes = _build_fcm_card_payload(db, row, normalized_league, round)
        except ValueError as ex:
            raise HTTPException(status_code=409, detail=str(ex)) from ex
        except Exception as ex:
            raise HTTPException(status_code=500, detail=str(ex)) from ex
        return Response(
            content=card_bytes,
            media_type="image/png",
            headers={"Content-Disposition": _attachment_header(filename, "fcm_card.png")},
        )

    latest_rows: dict[tuple[UUID, str], FcmSubmission] = {}
    for row in rows:
        key = (row.match_id, row.team_side)
        if key not in latest_rows:
            latest_rows[key] = row

    generated_cards: list[tuple[str, bytes]] = []
    skipped: list[str] = []

    for row in latest_rows.values():
        try:
            generated_cards.append(_build_fcm_card_payload(db, row, normalized_league, round))
        except Exception as ex:
            skipped.append(f"{row.team_name}: {ex}")

    if not generated_cards:
        detail = "생성 가능한 카드가 없습니다."
        if skipped:
            detail = f"{detail} {' / '.join(skipped[:3])}"
        raise HTTPException(status_code=409, detail=detail)

    zip_bytes = build_cards_zip(generated_cards)
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": _attachment_header(
                f"{normalized_league}-{round}R_cards.zip",
                f"{normalized_league}-{round}R_cards.zip",
            )
        },
    )


@app.get("/api/fcm/matches/{match_id}/submissions", response_model=list[FcmSubmissionResponse])
def get_fcm_submissions(match_id: UUID, db: Session = Depends(get_db), _user: User = Depends(_require_session_user)):
    rows = (
        db.query(FcmSubmission)
        .filter(FcmSubmission.match_id == match_id)
        .order_by(FcmSubmission.team_side.asc(), desc(FcmSubmission.updated_at))
        .all()
    )
    return [_serialize_fcm_submission(row) for row in rows]


@app.get("/api/fcm/matches/{match_id}/submission", response_model=FcmSubmissionResponse)
def get_fcm_submission(
    match_id: UUID,
    team_side: str = Query(default="HOME"),
    db: Session = Depends(get_db),
    _user: User = Depends(_require_session_user),
):
    normalized_side = team_side.strip().upper()
    if normalized_side not in {"HOME", "AWAY"}:
        raise HTTPException(status_code=400, detail="team_side must be HOME or AWAY")
    row = (
        db.query(FcmSubmission)
        .filter(FcmSubmission.match_id == match_id, FcmSubmission.team_side == normalized_side)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="FCM submission not found")
    return _serialize_fcm_submission(row)


@app.post("/api/fcm/matches/{match_id}/submission", response_model=FcmSubmissionResponse)
def upsert_fcm_submission(
    match_id: UUID,
    body: FcmSubmissionUpsertRequest,
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    match_row = db.get(Match, match_id)
    if not match_row:
        raise HTTPException(status_code=404, detail="Match not found")
    if not match_row.archived:
        raise HTTPException(status_code=409, detail="FCM submissions are available for archived matches only")

    selected_stats = [item.strip() for item in body.selected_stats if item and item.strip()]
    if not selected_stats:
        raise HTTPException(status_code=400, detail="At least one stat must be selected")
    if len(selected_stats) > 5:
        raise HTTPException(status_code=400, detail="You can submit at most 5 stats")

    normalized_side = _normalize_fcm_team_side(body.team_side)

    row = (
        db.query(FcmSubmission)
        .filter(FcmSubmission.match_id == match_id, FcmSubmission.team_side == normalized_side)
        .first()
    )
    if not row:
        row = FcmSubmission(
            match_id=match_id,
            competition_class=_normalize_competition_class(match_row.competition_class),
            round_number=int(match_row.round_number or 1),
            team_side=normalized_side,
        )
        db.add(row)

    metadata = match_row.metadata_json or {}
    row.competition_class = _normalize_competition_class(match_row.competition_class)
    row.round_number = int(match_row.round_number or 1)
    row.team_side = normalized_side
    row.team_name = body.team_name.strip() or ""
    row.player_id = body.player_id.strip()
    row.player_name = body.player_name.strip()
    row.selected_stats = selected_stats
    row.submitted_by = user.id
    row.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(row)

    _audit(
        db,
        "FCM_SUBMISSION_UPSERT",
        "FCM_SUBMISSION",
        actor=user,
        target_id=str(row.id),
        match_id=str(match_id),
        details={
            "competition_class": row.competition_class,
            "round_number": row.round_number,
            "team_side": row.team_side,
            "team_name": row.team_name,
            "player_id": row.player_id,
            "player_name": row.player_name,
            "selected_stats": selected_stats,
            "home_team": metadata.get("home_team"),
            "away_team": metadata.get("away_team"),
        },
    )
    db.commit()
    return _serialize_fcm_submission(row)


@app.post("/api/fpa/analyze/visualize", response_model=FpaVisualizeResponse)
async def visualize_fpa_file(file: UploadFile = File(...), player_id: str = Form(...), report_title: str = Form(default="FPA Visual Reports")):
    try:
        return build_visual_reports(await file.read(), player_id, report_title=report_title)
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex)) from ex


@app.post("/api/fpa/analyze/visualize/archive")
async def download_fpa_visual_archive(file: UploadFile = File(...), report_title: str = Form(default="FPA Visual Reports")):
    try:
        archive_bytes = build_visual_reports_archive(await file.read(), report_title=report_title)
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex)) from ex

    raw_title = (report_title or "").strip()
    fallback_stem = (file.filename or "fpa").rsplit(".", 1)[0]
    base_stem = raw_title if raw_title else fallback_stem
    safe_ascii_stem = re.sub(r"[^A-Za-z0-9_-]+", "_", base_stem)
    safe_ascii_stem = safe_ascii_stem.strip("_") or "fpa"
    utf8_stem = base_stem
    encoded_utf8 = quote(f"{utf8_stem}_visual_reports.zip")
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{safe_ascii_stem}_visual_reports.zip"; '
            f"filename*=UTF-8''{encoded_utf8}"
        )
    }
    return Response(content=archive_bytes, media_type="application/zip", headers=headers)


@app.get("/api/competition-classes", response_model=list[CompetitionClassResponse])
def list_competition_classes(db: Session = Depends(get_db)):
    rows = db.query(CompetitionClass).order_by(CompetitionClass.code.asc()).all()
    return [_serialize_competition_class(row) for row in rows]


@app.get("/api/basketball/court.svg")
def basketball_court_svg(
    court_type: str = Query(default="nba", pattern="^(nba|wnba|ncaa|fiba)$"),
    orientation: str = Query(default="vu", pattern="^(v|h|hl|hr|vu|vd)$"),
):
    try:
        import matplotlib

        matplotlib.use("Agg")
        from matplotlib import pyplot as plt
        from mplbasketball import Court
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"mplbasketball unavailable: {ex}") from ex

    court = Court(court_type=court_type, origin="top-left", units="ft")
    fig, ax = court.draw(
        orientation=orientation,
        showaxis=False,
        court_color="#d6a24f",
        paint_color="none",
        line_color="white",
        line_width=0.22,
        pad=0,
    )
    fig.patch.set_alpha(0)
    ax.set_facecolor("none")
    output = io.StringIO()
    fig.savefig(output, format="svg", bbox_inches="tight", pad_inches=0, transparent=True)
    plt.close(fig)
    svg = output.getvalue()
    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/api/matches/{match_id}/basketball-state")
def get_basketball_state(
    match_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(_require_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    metadata = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
    state = metadata.get("basketball_fla") if isinstance(metadata.get("basketball_fla"), dict) else {}
    return {
        "events": state.get("events") if isinstance(state.get("events"), list) else [],
        "lineups": state.get("lineups") if isinstance(state.get("lineups"), dict) else None,
        "timer": state.get("timer") if isinstance(state.get("timer"), dict) else None,
        "updated_at": state.get("updated_at"),
    }


@app.put("/api/matches/{match_id}/basketball-state")
def put_basketball_state(
    match_id: UUID,
    body: dict[str, Any] = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(match_obj)
    _require_write_lock(match_obj, user.id)

    events = body.get("events")
    lineups = body.get("lineups")
    timer = body.get("timer")
    if not isinstance(events, list):
        raise HTTPException(status_code=400, detail="events must be a list")
    if lineups is not None and not isinstance(lineups, dict):
        raise HTTPException(status_code=400, detail="lineups must be an object")
    if timer is not None and not isinstance(timer, dict):
        raise HTTPException(status_code=400, detail="timer must be an object")

    metadata = dict(match_obj.metadata_json or {})
    previous_state = metadata.get("basketball_fla") if isinstance(metadata.get("basketball_fla"), dict) else {}
    previous_event_ids = {
        str(event.get("id"))
        for event in previous_state.get("events", [])
        if isinstance(event, dict) and event.get("id")
    }
    metadata["basketball_fla"] = {
        **previous_state,
        "events": events,
        "lineups": lineups,
        "timer": timer,
        "updated_at": datetime.utcnow().isoformat(),
    }
    match_obj.metadata_json = metadata
    has_new_events = False
    for sequence, event in enumerate(events, start=1):
        if not isinstance(event, dict) or not event.get("id") or str(event.get("id")) in previous_event_ids:
            continue
        has_new_events = True
        try:
            ref_id = UUID(str(event.get("id")))
        except ValueError:
            ref_id = uuid.uuid4()
        _enqueue_webhook_fanout(db, "BASKETBALL_EVENT", ref_id, _serialize_basketball_event(match_obj.id, event, sequence))
    if has_new_events:
        _enqueue_webhook_fanout(db, "BASKETBALL_STATE", match_obj.id, _build_basketball_state(match_obj))
    db.commit()
    return {"ok": True, "match_id": str(match_obj.id), "event_count": len(events), "updated_at": metadata["basketball_fla"]["updated_at"]}


@app.post("/api/competition-classes", response_model=CompetitionClassResponse)
def create_competition_class(body: CompetitionClassCreateRequest, db: Session = Depends(get_db)):
    code = _normalize_competition_class(body.code)
    name = body.name.strip()
    if not re.fullmatch(r"[A-Z0-9-]+", code):
        raise HTTPException(status_code=400, detail="Competition class code can use A-Z, 0-9, and '-' only")

    existing = db.get(CompetitionClass, code)
    if existing:
        raise HTTPException(status_code=409, detail="Competition class already exists")

    row = CompetitionClass(
        code=code,
        name=name,
        first_half_minutes=body.first_half_minutes,
        second_half_minutes=body.second_half_minutes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize_competition_class(row)


@app.put("/api/competition-classes/{code}", response_model=CompetitionClassResponse)
def update_competition_class(code: str, body: CompetitionClassUpdateRequest, db: Session = Depends(get_db)):
    normalized_code = _normalize_competition_class(code)
    row = db.get(CompetitionClass, normalized_code)
    if not row:
        raise HTTPException(status_code=404, detail="Competition class not found")

    row.name = body.name.strip()
    row.first_half_minutes = body.first_half_minutes
    row.second_half_minutes = body.second_half_minutes
    db.commit()
    db.refresh(row)
    return _serialize_competition_class(row)


@app.post("/api/matches", response_model=MatchResponse)
def create_match(body: CreateMatchRequest, db: Session = Depends(get_db), user: User | None = Depends(_get_session_user)):
    sport = _normalize_sport(body.sport)
    normalized_class = _normalize_competition_class(body.competition_class)
    competition = db.get(CompetitionClass, normalized_class)
    if sport == "FOOTBALL" and not competition:
        raise HTTPException(status_code=400, detail="Unknown competition class")

    name_match = MATCH_NAME_PATTERN.match(body.name.strip())
    if name_match:
        if name_match.group("class") != normalized_class:
            raise HTTPException(status_code=400, detail="Competition class does not match match name format")
        if int(name_match.group("round")) != body.round_number:
            raise HTTPException(status_code=400, detail="Round number does not match match name format")
        home_team = name_match.group("home").strip()
        away_team = name_match.group("away").strip()
    elif sport == "BASKETBALL":
        raw_teams = body.name.strip().split(" vs ")
        if len(raw_teams) != 2 or not raw_teams[0].strip() or not raw_teams[1].strip():
            raise HTTPException(status_code=400, detail="Basketball match name must include 'HOME vs AWAY'")
        home_team = raw_teams[0].strip()
        away_team = raw_teams[1].strip()
    else:
        raise HTTPException(status_code=400, detail="Match name must follow '[CLASS | 1R] HOME vs AWAY' format")

    first_half_minutes = competition.first_half_minutes if competition else int((body.metadata or {}).get("period_minutes", 10))
    second_half_minutes = competition.second_half_minutes if competition else int((body.metadata or {}).get("period_minutes", 10))
    metadata = dict(body.metadata or {})
    metadata["sport"] = sport
    metadata["stream_mode"] = body.stream_mode
    metadata["home_team"] = home_team
    metadata["away_team"] = away_team
    metadata["first_half_minutes"] = first_half_minutes
    metadata["second_half_minutes"] = second_half_minutes
    row = Match(
        id=uuid.uuid4(),
        name=body.name,
        sport=sport,
        competition_class=normalized_class,
        round_number=body.round_number,
        first_half_minutes=first_half_minutes,
        second_half_minutes=second_half_minutes,
        hls_url=body.hls_url,
        metadata_json=metadata,
        operator_id=user.id if user and body.assign_operator else None,
    )

    ingest_url, ingest_protocol = _resolve_ingest_fields(body.ingest_url, body.srt_url, body.ingest_protocol)
    if ingest_protocol:
        metadata["ingest_protocol"] = ingest_protocol
    if ingest_url:
        metadata["ingest_url"] = ingest_url

    if sport == "FOOTBALL" and body.stream_mode == "STREAM" and (ingest_url or ingest_protocol == "RTMP"):
        try:
            start_data = _gateway_start_stream(row.id, ingest_url, ingest_protocol)
            row.hls_url = _normalize_hls_url(start_data["hls_url"])
            metadata["ingest_protocol"] = start_data.get("ingest_protocol") or ingest_protocol
            metadata["ingest_url"] = start_data.get("source_url") or ingest_url
            if start_data.get("rtmp"):
                metadata["rtmp"] = start_data["rtmp"]
            metadata.pop("stream_attach_error", None)
        except HTTPException as ex:
            # Match creation must not fail even when gateway attachment fails.
            # Operator can retry via the match page Attach RTMP/SRT controls.
            metadata["stream_attach_error"] = str(ex.detail)

    row.metadata_json = metadata
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize_match(row)


@app.post("/api/matches/{match_id}/stream/srt")
def attach_srt_stream(match_id: UUID, body: AttachSrtRequest, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)
    if (row.metadata_json or {}).get("stream_mode") == "MANUAL":
        raise HTTPException(status_code=409, detail="Manual matches do not use streaming")

    start_data = _gateway_start_stream(match_id, body.srt_url, "SRT")
    metadata = dict(row.metadata_json or {})
    metadata["ingest_protocol"] = "SRT"
    metadata["ingest_url"] = body.srt_url
    row.metadata_json = metadata
    row.hls_url = _normalize_hls_url(start_data["hls_url"])
    db.commit()
    db.refresh(row)
    return {
        "ok": True,
        "match_id": str(row.id),
        "ingest_url": body.srt_url,
        "ingest_protocol": "SRT",
        "hls_url": _normalize_hls_url(row.hls_url),
    }


@app.post("/api/matches/{match_id}/stream")
def attach_ingest_stream(match_id: UUID, body: AttachIngestRequest, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)
    if (row.metadata_json or {}).get("stream_mode") == "MANUAL":
        raise HTTPException(status_code=409, detail="Manual matches do not use streaming")

    ingest_url, ingest_protocol = _resolve_ingest_fields(body.ingest_url, body.srt_url, body.ingest_protocol)
    if not ingest_url and ingest_protocol != "RTMP":
        raise HTTPException(status_code=400, detail="ingest_url is required unless ingest_protocol is RTMP")

    start_data = _gateway_start_stream(match_id, ingest_url, ingest_protocol)
    metadata = dict(row.metadata_json or {})
    metadata["ingest_protocol"] = start_data.get("ingest_protocol") or ingest_protocol
    metadata["ingest_url"] = start_data.get("source_url") or ingest_url
    if start_data.get("rtmp"):
        metadata["rtmp"] = start_data["rtmp"]
    row.metadata_json = metadata
    row.hls_url = _normalize_hls_url(start_data["hls_url"])
    db.commit()
    db.refresh(row)
    return {
        "ok": True,
        "match_id": str(row.id),
        "ingest_protocol": metadata.get("ingest_protocol"),
        "ingest_url": metadata.get("ingest_url"),
        "hls_url": _normalize_hls_url(row.hls_url),
        "rtmp": metadata.get("rtmp"),
    }


@app.post("/api/matches/{match_id}/stream/clear")
def clear_match_stream(match_id: UUID, db: Session = Depends(get_db), user: User | None = Depends(_get_session_user)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)
    if (row.metadata_json or {}).get("stream_mode") == "MANUAL":
        raise HTTPException(status_code=409, detail="Manual matches do not use streaming")
    _gateway_clear_stream(match_id)
    _audit(db, "STREAM_CLEAR", "match", actor=user, target_id=str(row.id), match_id=row.id, severity="WARN")
    db.commit()
    return {"ok": True, "match_id": str(row.id)}


@app.post("/api/matches/{match_id}/stream/stop")
def stop_match_stream(match_id: UUID, db: Session = Depends(get_db), user: User | None = Depends(_get_session_user)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)
    if (row.metadata_json or {}).get("stream_mode") == "MANUAL":
        raise HTTPException(status_code=409, detail="Manual matches do not use streaming")

    gateway_base = os.getenv("GATEWAY_API_BASE", "http://host.docker.internal:8090").rstrip("/")
    if not gateway_base:
        raise HTTPException(status_code=500, detail="GATEWAY_API_BASE not configured")

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(f"{gateway_base}/matches/{match_id}/stop")
            resp.raise_for_status()
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"gateway stop failed: {ex}") from ex

    _audit(db, "STREAM_STOP", "match", actor=user, target_id=str(row.id), match_id=row.id, severity="WARN")
    db.commit()
    return {"ok": True, "match_id": str(row.id)}


@app.post("/api/matches/{match_id}/possession/reset")
def reset_match_possession(
    match_id: UUID,
    body: PossessionResetRequest,
    confirm_live_action: bool = Query(default=False),
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)
    _guard_live_dangerous_action(row, db, confirm_live_action=confirm_live_action, action_label="Possession reset")
    resolved_user_id = _resolve_user_id(body.user_id, session_user)
    _require_write_lock(row, resolved_user_id)

    db.query(PossessionSegment).filter(PossessionSegment.match_id == match_id).delete(synchronize_session=False)

    bins = db.query(DominanceBin).filter(DominanceBin.match_id == match_id).all()
    for b in bins:
        b.home_poss_ms = 0
        b.away_poss_ms = 0
        recompute_dominance(b)

    db.commit()
    _audit(
        db,
        "POSSESSION_RESET",
        "match",
        actor=session_user,
        target_id=str(row.id),
        match_id=row.id,
        severity="WARN",
        details={"confirmed_live_action": confirm_live_action, "requested_by": resolved_user_id},
    )
    db.commit()
    return {"ok": True, "match_id": str(row.id)}


@app.post("/api/matches/{match_id}/events/reset")
def reset_match_events(
    match_id: UUID,
    body: EventsResetRequest,
    confirm_live_action: bool = Query(default=False),
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)
    _guard_live_dangerous_action(row, db, confirm_live_action=confirm_live_action, action_label="Event reset")
    resolved_user_id = _resolve_user_id(body.user_id, session_user)
    _require_write_lock(row, resolved_user_id)

    event_count = db.query(Event).filter(Event.match_id == match_id).delete(synchronize_session=False)
    db.query(LaneSegment).filter(LaneSegment.match_id == match_id).delete(synchronize_session=False)

    bins = db.query(DominanceBin).filter(DominanceBin.match_id == match_id).all()
    for b in bins:
        b.home_xg = 0.0
        b.away_xg = 0.0
        b.home_attack_score = 0.0
        b.away_attack_score = 0.0
        recompute_dominance(b)

    db.commit()
    _audit(
        db,
        "EVENTS_RESET",
        "match",
        actor=session_user,
        target_id=str(row.id),
        match_id=row.id,
        severity="WARN",
        details={"confirmed_live_action": confirm_live_action, "deleted_events": event_count, "requested_by": resolved_user_id},
    )
    db.commit()
    return {"ok": True, "match_id": str(row.id), "deleted_events": event_count}


@app.get("/api/matches/{match_id}/stream/rtmp-info")
def get_rtmp_info(match_id: UUID, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    return _gateway_rtmp_info(match_id)


@app.get("/api/matches")
def list_matches(sport: str | None = Query(default=None), db: Session = Depends(get_db)):
    cache_key = ("list_matches", _normalize_sport(sport) if sport else "")
    cached = _cache_get(_match_response_cache, cache_key)
    if cached is not None:
        return cached
    query = db.query(Match)
    if sport:
        query = query.filter(Match.sport == _normalize_sport(sport))
    rows = query.order_by(desc(Match.created_at)).all()
    return _cache_set(_match_response_cache, cache_key, [_serialize_match(r) for r in rows])


@app.get("/api/broadcast/matches/{match_id}/state")
def get_broadcast_state(match_id: UUID, db: Session = Depends(get_db)):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    return _broadcast_state(match_obj)


@app.post("/api/broadcast/matches/{match_id}/state")
def put_broadcast_state(match_id: UUID, body: dict = Body(default_factory=dict), db: Session = Depends(get_db)):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    metadata = dict(match_obj.metadata_json or {})
    previous = _broadcast_state(match_obj)
    allowed_graphics = {None, "ATTACK_DIRECTION_HOME", "ATTACK_DIRECTION_AWAY", "XG"}
    allowed_events = {None, "GOAL", "YELLOW_CARD", "RED_CARD", "SUBSTITUTION"}
    allowed_fullscreen = {None, "LINEUP", "HALFTIME", "FULLTIME", "MATCH_DOMINANCE"}
    next_state = {
        **previous,
        "scoreboard_visible": bool(body.get("scoreboard_visible", previous["scoreboard_visible"])),
        "possession_visible": bool(body.get("possession_visible", previous.get("possession_visible"))),
        "active_graphic": body.get("active_graphic", previous.get("active_graphic")),
        "selected_xg_event_id": body.get("selected_xg_event_id", previous.get("selected_xg_event_id")),
        "event_graphic": body.get("event_graphic", previous.get("event_graphic")),
        "fullscreen_graphic": body.get("fullscreen_graphic", previous.get("fullscreen_graphic")),
        "fullscreen_image_urls": previous.get("fullscreen_image_urls") if isinstance(previous.get("fullscreen_image_urls"), dict) else {},
        "theme_id": str(body.get("theme_id", previous.get("theme_id") or "fineplay_dark")),
        "home_label": str(body.get("home_label", previous.get("home_label") or "Home")).strip()[:20] or "Home",
        "away_label": str(body.get("away_label", previous.get("away_label") or "Away")).strip()[:20] or "Away",
        "home_color": str(body.get("home_color", previous.get("home_color") or "#ff7900")).strip(),
        "away_color": str(body.get("away_color", previous.get("away_color") or "#3d22f3")).strip(),
        "home_logo_url": str(body.get("home_logo_url", previous.get("home_logo_url") or "")).strip()[:500],
        "away_logo_url": str(body.get("away_logo_url", previous.get("away_logo_url") or "")).strip()[:500],
        "home_score": body.get("home_score", previous.get("home_score")),
        "away_score": body.get("away_score", previous.get("away_score")),
        "event_payload": body.get("event_payload", previous.get("event_payload")),
        "sequence": int(previous.get("sequence") or 0) + 1,
        "updated_at": datetime.utcnow().isoformat(),
    }
    clock_action = body.get("clock_action")
    if clock_action:
        current_clock_ms = _broadcast_clock_ms(previous)
        if clock_action == "start":
            next_state["clock_ms"] = current_clock_ms
            next_state["clock_running"] = True
            next_state["clock_started_at"] = datetime.utcnow().isoformat()
        elif clock_action == "pause":
            next_state["clock_ms"] = current_clock_ms
            next_state["clock_running"] = False
            next_state["clock_started_at"] = None
        elif clock_action == "reset":
            next_state["clock_ms"] = 0
            next_state["clock_running"] = False
            next_state["clock_started_at"] = None
        else:
            raise HTTPException(status_code=400, detail="Unsupported clock_action")
    if "clock_ms" in body:
        next_state["clock_ms"] = max(0, int(body.get("clock_ms") or 0))
        next_state["clock_started_at"] = datetime.utcnow().isoformat() if next_state.get("clock_running") else None
    if next_state["active_graphic"] not in allowed_graphics:
        raise HTTPException(status_code=400, detail="Unsupported active_graphic")
    if next_state["event_graphic"] not in allowed_events:
        raise HTTPException(status_code=400, detail="Unsupported event_graphic")
    if next_state["fullscreen_graphic"] not in allowed_fullscreen:
        raise HTTPException(status_code=400, detail="Unsupported fullscreen_graphic")
    for key in ("home_color", "away_color"):
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", str(next_state.get(key) or "")):
            raise HTTPException(status_code=400, detail=f"Unsupported {key}")
    for key in ("home_score", "away_score"):
        if next_state.get(key) is not None:
            next_state[key] = max(0, int(next_state.get(key) or 0))
    metadata["broadcast"] = next_state
    match_obj.metadata_json = metadata
    db.commit()
    _broadcast_snapshot_cache.pop(str(match_id), None)
    return next_state


@app.post("/api/broadcast/matches/{match_id}/logo")
async def upload_broadcast_logo(
    match_id: UUID,
    team: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    team_key = team.upper()
    if team_key not in {"HOME", "AWAY"}:
        raise HTTPException(status_code=400, detail="Unsupported team")
    original_suffix = Path(file.filename or "").suffix.lower()
    suffix = original_suffix if original_suffix in {".png", ".jpg", ".jpeg", ".webp"} else ".png"
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty logo file")
    if len(payload) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Logo file is too large")
    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.verify()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Unsupported logo image") from exc

    BROADCAST_LOGO_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{match_id}_{team_key.lower()}_{uuid.uuid4().hex[:8]}{suffix}"
    path = _broadcast_logo_path(filename)
    path.write_bytes(payload)

    metadata = dict(match_obj.metadata_json or {})
    previous = _broadcast_state(match_obj)
    next_state = {
        **previous,
        f"{team_key.lower()}_logo_url": f"/api/broadcast/assets/logos/{filename}",
        "sequence": int(previous.get("sequence") or 0) + 1,
        "updated_at": datetime.utcnow().isoformat(),
    }
    metadata["broadcast"] = next_state
    match_obj.metadata_json = metadata
    db.commit()
    _broadcast_snapshot_cache.pop(str(match_id), None)
    return next_state


@app.post("/api/broadcast/matches/{match_id}/fullscreen-image")
async def upload_broadcast_fullscreen_image(
    match_id: UUID,
    scene: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    scene_key = scene.upper()
    if scene_key not in {"LINEUP", "HALFTIME", "FULLTIME", "MATCH_DOMINANCE"}:
        raise HTTPException(status_code=400, detail="Unsupported fullscreen scene")
    original_suffix = Path(file.filename or "").suffix.lower()
    suffix = original_suffix if original_suffix in {".png", ".jpg", ".jpeg", ".webp"} else ".png"
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty fullscreen image")
    if len(payload) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Fullscreen image is too large")
    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.verify()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Unsupported fullscreen image") from exc

    BROADCAST_LOGO_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{match_id}_fullscreen_{scene_key.lower()}_{uuid.uuid4().hex[:8]}{suffix}"
    path = _broadcast_logo_path(filename)
    path.write_bytes(payload)

    metadata = dict(match_obj.metadata_json or {})
    previous = _broadcast_state(match_obj)
    fullscreen_image_urls = dict(previous.get("fullscreen_image_urls") or {})
    fullscreen_image_urls[scene_key] = f"/api/broadcast/assets/logos/{filename}"
    next_state = {
        **previous,
        "fullscreen_image_urls": fullscreen_image_urls,
        "sequence": int(previous.get("sequence") or 0) + 1,
        "updated_at": datetime.utcnow().isoformat(),
    }
    metadata["broadcast"] = next_state
    match_obj.metadata_json = metadata
    db.commit()
    _broadcast_snapshot_cache.pop(str(match_id), None)
    return next_state


@app.get("/api/broadcast/assets/logos/{filename}")
def get_broadcast_logo(filename: str):
    path = _broadcast_logo_path(filename)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Logo not found")
    return FileResponse(str(path))


@app.get("/api/broadcast/matches/{match_id}/snapshot")
def get_broadcast_snapshot(match_id: UUID, view: str | None = Query(default=None), db: Session = Depends(get_db)):
    if view == "scoreboard":
        match_obj = db.get(Match, match_id)
        if not match_obj:
            raise HTTPException(status_code=404, detail="Match not found")
        return _build_scoreboard_broadcast_snapshot(match_obj, db)
    now = time.monotonic()
    cache_key = str(match_id)
    cached = _broadcast_snapshot_cache.get(cache_key)
    if cached and now - cached[0] < BROADCAST_SNAPSHOT_CACHE_TTL_SECONDS:
        return cached[1]
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    snapshot = _build_broadcast_snapshot(match_obj, db)
    _broadcast_snapshot_cache[cache_key] = (now, snapshot)
    return snapshot


@app.post("/api/matches/{match_id}/archive")
def archive_match(
    match_id: UUID,
    body: ArchiveMatchRequest,
    confirm_live_action: bool = Query(default=False),
    db: Session = Depends(get_db),
    user: User | None = Depends(_get_session_user),
):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")

    if body.archived:
        _guard_live_dangerous_action(row, db, confirm_live_action=confirm_live_action, action_label="Archive")
        if body.stop_stream:
            _gateway_stop_stream(match_id)
        row.archived = True
        row.archived_at = datetime.utcnow()
        row.operator_id = None
    else:
        row.archived = False
        row.archived_at = None

    db.commit()
    db.refresh(row)
    _audit(
        db,
        "MATCH_ARCHIVE" if body.archived else "MATCH_RESTORE",
        "match",
        actor=user,
        target_id=str(row.id),
        match_id=row.id,
        severity="WARN" if body.archived else "INFO",
        details={"confirmed_live_action": confirm_live_action, "stop_stream": body.stop_stream},
    )
    db.commit()
    return _serialize_match(row)


@app.get("/api/admin/streams/status")
def get_admin_stream_status():
    return _gateway_status()


@app.get("/api/admin/system")
def get_admin_system(db: Session = Depends(get_db), _user: User = Depends(_require_superuser)):
    try:
        gateway_status = _gateway_status()
    except HTTPException:
        gateway_status = {"ok": False, "lines": [], "running_match_ids": []}
    media_server = _media_control_status()
    highlight_worker = _highlight_worker_control_status()
    active_highlight_jobs = (
        db.query(HighlightJob)
        .filter(HighlightJob.status.in_(["queued", "processing"]))
        .count()
    )

    matches = db.query(Match).all()
    active_matches = [row for row in matches if not row.archived]
    streaming_matches = [row for row in active_matches if (row.metadata_json or {}).get("stream_mode") != "MANUAL"]
    manual_matches = [row for row in active_matches if (row.metadata_json or {}).get("stream_mode") == "MANUAL"]
    live_matches = [row for row in active_matches if _match_is_live(row.id, db)]

    alerts: list[dict] = []
    if not gateway_status.get("ok"):
        alerts.append({"severity": "HIGH", "title": "Gateway offline", "message": "Media page에서 gateway 상태와 HLS probe를 먼저 확인하세요."})
    if gateway_status.get("running_match_ids") and not streaming_matches:
        alerts.append({"severity": "MEDIUM", "title": "Orphan stream risk", "message": "실행 중 스트림은 있는데 활성 STREAM 매치 목록이 비어 있습니다."})
    if manual_matches and not streaming_matches:
        alerts.append({"severity": "INFO", "title": "Manual-only day candidate", "message": "현재 MANUAL 매치만 남아 있으면 media 서버 종료 검토가 가능합니다."})

    recent_audits = (
        db.query(AuditLog)
        .order_by(desc(AuditLog.created_at))
        .limit(12)
        .all()
    )

    return {
        "ok": True,
        "time": datetime.utcnow().isoformat(),
        "streams_enabled": bool(os.getenv("GATEWAY_API_BASE", "").strip()),
        "gateway_base": os.getenv("GATEWAY_API_BASE", "").strip() or None,
        "public_hls_base": PUBLIC_HLS_BASE,
        "media_server": media_server,
        "highlight_worker": {
            **highlight_worker,
            "active_jobs": active_highlight_jobs,
        },
        "health": {
            "gateway_ok": bool(gateway_status.get("ok")),
            "running_streams": len(gateway_status.get("running_match_ids") or []),
            "active_matches": len(active_matches),
            "live_matches": len(live_matches),
            "streaming_matches": len(streaming_matches),
            "manual_matches": len(manual_matches),
            "active_highlight_jobs": active_highlight_jobs,
        },
        "alerts": alerts,
        "recent_audits": [
            {
                "id": str(item.id),
                "actor_id": item.actor_id,
                "actor_name": item.actor_name,
                "actor_role": item.actor_role,
                "action": item.action,
                "target_type": item.target_type,
                "target_id": item.target_id,
                "match_id": item.match_id,
                "severity": item.severity,
                "details": item.details or {},
                "created_at": item.created_at.isoformat(),
            }
            for item in recent_audits
        ],
    }


@app.get("/api/admin/ec2/media-status")
def get_media_server_status(_user: User = Depends(_require_superuser)):
    return {
        "ok": True,
        "media_server": _media_control_status(),
    }


@app.post("/api/admin/ec2/media-start")
def start_media_server(db: Session = Depends(get_db), user: User = Depends(_require_superuser)):
    data = _media_control_request("start")
    _audit(
        db,
        "MEDIA_EC2_START",
        "system",
        actor=user,
        target_id=MEDIA_INSTANCE_ID or MEDIA_INSTANCE_NAME,
        severity="WARN",
        details=data,
    )
    db.commit()
    return {
        "ok": True,
        "media_server": _media_control_status(),
        "result": data,
    }


@app.post("/api/admin/ec2/media-stop")
def stop_media_server(confirm_live_action: bool = Query(default=False), db: Session = Depends(get_db), user: User = Depends(_require_superuser)):
    try:
        gateway_status = _gateway_status()
    except HTTPException:
        gateway_status = {"ok": False, "lines": [], "running_match_ids": []}

    active_matches = db.query(Match).all()
    streaming_matches = [
        row for row in active_matches
        if (not row.archived) and (row.metadata_json or {}).get("stream_mode") != "MANUAL"
    ]
    running_streams = gateway_status.get("running_match_ids") or []

    if (running_streams or streaming_matches) and not confirm_live_action:
        raise HTTPException(
            status_code=409,
            detail="Media server stop blocked while running streams or active STREAM matches exist. Retry with explicit live-action confirmation.",
        )

    data = _media_control_request("stop", confirmed_live_action=confirm_live_action)
    _audit(
        db,
        "MEDIA_EC2_STOP",
        "system",
        actor=user,
        target_id=MEDIA_INSTANCE_ID or MEDIA_INSTANCE_NAME,
        severity="WARN",
        details={
            **data,
            "confirmed_live_action": confirm_live_action,
            "running_streams": len(running_streams),
            "streaming_matches": len(streaming_matches),
        },
    )
    db.commit()
    return {
        "ok": True,
        "media_server": _media_control_status(),
        "result": data,
    }


@app.get("/api/admin/ec2/highlight-worker-status")
def get_highlight_worker_status(db: Session = Depends(get_db), _user: User = Depends(_require_superuser)):
    active_jobs = (
        db.query(HighlightJob)
        .filter(HighlightJob.status.in_(["queued", "processing"]))
        .count()
    )
    return {
        "ok": True,
        "highlight_worker": {
            **_highlight_worker_control_status(),
            "active_jobs": active_jobs,
        },
    }


@app.post("/api/admin/ec2/highlight-worker-start")
def start_highlight_worker(db: Session = Depends(get_db), user: User = Depends(_require_superuser)):
    data = _highlight_worker_control_request("start")
    _audit(
        db,
        "HIGHLIGHT_WORKER_EC2_START",
        "system",
        actor=user,
        target_id=HIGHLIGHT_WORKER_INSTANCE_ID or HIGHLIGHT_WORKER_INSTANCE_NAME,
        severity="WARN",
        details=data,
    )
    db.commit()
    return {
        "ok": True,
        "highlight_worker": _highlight_worker_control_status(),
        "result": data,
    }


@app.post("/api/admin/ec2/highlight-worker-stop")
def stop_highlight_worker(confirm_live_action: bool = Query(default=False), db: Session = Depends(get_db), user: User = Depends(_require_superuser)):
    active_jobs = (
        db.query(HighlightJob)
        .filter(HighlightJob.status.in_(["queued", "processing"]))
        .count()
    )
    if active_jobs and not confirm_live_action:
        raise HTTPException(
            status_code=409,
            detail=f"Highlight worker stop blocked while {active_jobs} queued or processing jobs exist. Retry with explicit confirmation.",
        )

    data = _highlight_worker_control_request("stop", confirmed_live_action=confirm_live_action)
    _audit(
        db,
        "HIGHLIGHT_WORKER_EC2_STOP",
        "system",
        actor=user,
        target_id=HIGHLIGHT_WORKER_INSTANCE_ID or HIGHLIGHT_WORKER_INSTANCE_NAME,
        severity="WARN",
        details={
            **data,
            "confirmed_live_action": confirm_live_action,
            "active_highlight_jobs": active_jobs,
        },
    )
    db.commit()
    return {
        "ok": True,
        "highlight_worker": _highlight_worker_control_status(),
        "result": data,
    }


@app.get("/api/admin/media")
def get_admin_media(db: Session = Depends(get_db), _user: User = Depends(_require_superuser)):
    rows = db.query(Match).order_by(desc(Match.created_at)).all()
    try:
        stream_status = _gateway_status()
    except HTTPException:
        stream_status = {
            "ok": False,
            "lines": [],
            "running_match_ids": [],
        }

    matches_payload: list[dict] = []
    for row in rows:
        serialized = _serialize_match(row)
        metadata = dict(serialized.get("metadata") or {})
        if not row.archived and metadata.get("stream_mode") != "MANUAL":
            metadata["hls_probe"] = _probe_hls_url(row.hls_url)
        serialized["metadata"] = metadata
        matches_payload.append(serialized)

    return {
        "ok": True,
        "time": datetime.utcnow().isoformat(),
        "gateway": {
            "configured": bool(os.getenv("GATEWAY_API_BASE", "").strip()),
            "base": os.getenv("GATEWAY_API_BASE", "").strip() or None,
            "status_ok": bool(stream_status.get("ok")),
            "lines": stream_status.get("lines") or [],
            "running_match_ids": stream_status.get("running_match_ids") or [],
        },
        "matches": matches_payload,
    }


@app.post("/api/admin/media/stop-all")
def stop_all_media_streams(confirm_live_action: bool = Query(default=False), db: Session = Depends(get_db), user: User = Depends(_require_superuser)):
    try:
        stream_status = _gateway_status()
    except HTTPException as ex:
        raise HTTPException(status_code=502, detail=f"gateway status failed: {ex.detail}") from ex

    if (stream_status.get("running_match_ids") or []) and not confirm_live_action:
        raise HTTPException(status_code=409, detail="Stop All Streams blocked while live streams exist. Retry with explicit live-action confirmation.")

    stopped_match_ids: list[str] = []
    for raw_match_id in stream_status.get("running_match_ids") or []:
        try:
            match_id = UUID(raw_match_id)
        except Exception:
            continue
        _gateway_stop_stream(match_id)
        stopped_match_ids.append(str(match_id))

    _audit(
        db,
        "STREAM_STOP_ALL",
        "system",
        actor=user,
        target_id="gateway",
        severity="WARN",
        details={"count": len(stopped_match_ids), "confirmed_live_action": confirm_live_action},
    )
    db.commit()
    return {
        "ok": True,
        "stopped_match_ids": stopped_match_ids,
        "count": len(stopped_match_ids),
    }


@app.post("/api/admin/media/{match_id}/reattach")
def reattach_media_stream(match_id: UUID, db: Session = Depends(get_db), _user: User = Depends(_require_superuser)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)

    metadata = dict(row.metadata_json or {})
    if metadata.get("stream_mode") == "MANUAL":
        raise HTTPException(status_code=409, detail="Manual matches do not use streaming")

    ingest_protocol = metadata.get("ingest_protocol")
    ingest_url = metadata.get("ingest_url")
    if not ingest_protocol:
        raise HTTPException(status_code=400, detail="No ingest protocol stored for this match")
    if ingest_protocol != "RTMP" and not ingest_url:
        raise HTTPException(status_code=400, detail="No ingest URL stored for this match")

    # Re-attach must force a fresh ffmpeg process because the gateway start
    # script intentionally reuses an existing match PID when one is already running.
    _gateway_stop_stream(row.id)
    start_data = _gateway_start_stream(row.id, ingest_url, ingest_protocol)
    metadata["ingest_protocol"] = start_data.get("ingest_protocol") or ingest_protocol
    metadata["ingest_url"] = start_data.get("source_url") or ingest_url
    if start_data.get("rtmp"):
        metadata["rtmp"] = start_data["rtmp"]
    metadata.pop("stream_attach_error", None)
    row.metadata_json = metadata
    row.hls_url = _normalize_hls_url(start_data.get("hls_url"))
    db.commit()
    db.refresh(row)
    _audit(db, "STREAM_REATTACH", "match", actor=_user, target_id=str(row.id), match_id=row.id, severity="WARN")
    db.commit()

    return {
        "ok": True,
        "match": _serialize_match(row),
    }


@app.post("/api/admin/media/seed-demo")
def seed_demo_media_matches(db: Session = Depends(get_db), user: User = Depends(_require_superuser)):
    demo_matches = [
        {
            "name": "Demo Stream | RTMP 정상 예시",
            "competition_class": "K3",
            "round_number": 1,
            "metadata": {
                "stream_mode": "STREAM",
                "ingest_protocol": "RTMP",
                "rtmp": {
                    "server_url": "rtmp://rtmp.yourdomain.com/live",
                    "stream_key": "demo-rtmp-ok",
                    "push_url": "rtmp://rtmp.yourdomain.com/live/demo-rtmp-ok",
                },
            },
            "hls_url": f"{PUBLIC_HLS_BASE}/hls/demo-rtmp-ok/stream.m3u8",
        },
        {
            "name": "Demo Stream | HLS 200 실패 예시",
            "competition_class": "K3",
            "round_number": 1,
            "metadata": {
                "stream_mode": "STREAM",
                "ingest_protocol": "SRT",
                "ingest_url": "srt://demo-source",
                "stream_attach_error": "최근 attach 이후 HLS 200 OK가 안 뜬 상황 예시",
            },
            "hls_url": f"{PUBLIC_HLS_BASE}/hls/demo-hls-fail/stream.m3u8",
        },
        {
            "name": "Demo Manual | 현장 수동 운영",
            "competition_class": "K3",
            "round_number": 1,
            "metadata": {
                "stream_mode": "MANUAL",
                "demo_media": True,
            },
            "hls_url": None,
        },
    ]

    created_ids: list[str] = []
    for item in demo_matches:
        existing = db.query(Match).filter(Match.name == item["name"]).first()
        if existing:
            continue
        row = Match(
            id=uuid.uuid4(),
            name=item["name"],
            competition_class=item["competition_class"],
            round_number=item["round_number"],
            hls_url=item["hls_url"],
            metadata_json=item["metadata"],
            operator_id=user.id,
        )
        db.add(row)
        created_ids.append(str(row.id))

    db.commit()
    _audit(db, "DEMO_MATCHES_SEEDED", "system", actor=user, target_id="demo-media", severity="INFO", details={"count": len(created_ids)})
    db.commit()
    return {
        "ok": True,
        "created_ids": created_ids,
        "count": len(created_ids),
    }


@app.get("/api/matches/{match_id}")
def get_match(match_id: UUID, db: Session = Depends(get_db)):
    cache_key = ("get_match", str(match_id))
    cached = _cache_get(_match_response_cache, cache_key)
    if cached is not None:
        return cached
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    return _cache_set(_match_response_cache, cache_key, _serialize_match(row))


@app.post("/api/matches/{match_id}/lineup/pdf")
async def upload_match_lineup_pdf(
    match_id: UUID,
    file: UploadFile = File(...),
    first_team_side: str = Form(default="HOME"),
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(match_obj)
    _require_write_lock(match_obj, _resolve_user_id(None, session_user))
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Lineup upload must be a PDF")

    lineup = _parse_lineup_pdf(await file.read(), first_team_side=first_team_side)
    metadata = dict(match_obj.metadata_json or {})
    metadata["lineups"] = lineup
    metadata["lineup_pdf_filename"] = file.filename or ""
    metadata["lineup_pdf_uploaded_at"] = datetime.utcnow().isoformat()
    match_obj.metadata_json = metadata
    db.commit()
    db.refresh(match_obj)
    return {
        "ok": True,
        "lineups": lineup,
        "match": _serialize_match(match_obj),
    }


@app.post("/api/matches/{match_id}/lineup/manual/player")
def upsert_match_lineup_manual_player(
    match_id: UUID,
    body: LineupManualPlayerRequest,
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(match_obj)
    _require_write_lock(match_obj, _resolve_user_id(None, session_user))

    lineup = _upsert_manual_lineup_player(match_obj, body)
    db.commit()
    db.refresh(match_obj)
    return {
        "ok": True,
        "lineups": lineup,
        "match": _serialize_match(match_obj),
    }


@app.post("/api/matches/{match_id}/lineup/manual/player/delete")
def delete_match_lineup_manual_player(
    match_id: UUID,
    body: LineupManualPlayerDeleteRequest,
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(match_obj)
    _require_write_lock(match_obj, _resolve_user_id(None, session_user))

    lineup = _delete_manual_lineup_player(match_obj, body)
    db.commit()
    db.refresh(match_obj)
    return {
        "ok": True,
        "lineups": lineup,
        "match": _serialize_match(match_obj),
    }


@app.post("/api/matches/{match_id}/lineup/swap")
def swap_match_lineup_sides(
    match_id: UUID,
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(match_obj)
    _require_write_lock(match_obj, _resolve_user_id(None, session_user))

    lineup = _swap_lineup_sides(match_obj)
    db.commit()
    db.refresh(match_obj)
    return {
        "ok": True,
        "lineups": lineup,
        "match": _serialize_match(match_obj),
    }


@app.get("/api/matches/{match_id}/result", response_model=MatchResultResponse)
def get_match_result(match_id: UUID, db: Session = Depends(get_db)):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")

    last_state = _latest_state(match_id, db)

    clock_ms = last_state.clock_ms if last_state else 0

    if last_state is None:
        status = "SCHEDULED"
    elif last_state.running:
        status = "LIVE"
    elif clock_ms > 0:
        status = "FINISHED"
    else:
        status = "SCHEDULED"

    poss_rows = (
        db.query(PossessionSegment)
        .filter(PossessionSegment.match_id == match_id)
        .all()
    )
    home_ms, away_ms = _accumulate_possession_ms(poss_rows, clock_ms)

    poss_total = home_ms + away_ms
    home_pct = round(home_ms / poss_total * 100.0, 1) if poss_total else 0.0
    away_pct = round(away_ms / poss_total * 100.0, 1) if poss_total else 0.0

    xg_events = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "XG")
        .all()
    )
    home_xg = round(sum(e.xg for e in xg_events if e.team == "HOME" and e.xg), 2)
    away_xg = round(sum(e.xg for e in xg_events if e.team == "AWAY" and e.xg), 2)

    return MatchResultResponse(
        matchId=str(match_obj.id),
        name=match_obj.name,
        status=status,
        clockMs=clock_ms,
        possession={"homePct": home_pct, "awayPct": away_pct},
        xg={"home": home_xg, "away": away_xg},
        playedAt=match_obj.created_at.isoformat(),
    )


@app.delete("/api/matches/{match_id}")
def delete_match(
    match_id: UUID,
    stop_stream: bool = True,
    confirm_live_action: bool = Query(default=False),
    db: Session = Depends(get_db),
    user: User | None = Depends(_get_session_user),
):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)
    _guard_live_dangerous_action(row, db, confirm_live_action=confirm_live_action, action_label="Delete")

    if stop_stream:
        _gateway_stop_stream(match_id)

    db.query(FcmSubmission).filter(FcmSubmission.match_id == match_id).delete(synchronize_session=False)
    db.query(FpaSavedLog).filter(FpaSavedLog.match_id == match_id).delete(synchronize_session=False)
    db.query(MatchMarker).filter(MatchMarker.match_id == match_id).delete(synchronize_session=False)
    db.query(LaneSegment).filter(LaneSegment.match_id == match_id).delete(synchronize_session=False)
    db.query(PossessionSegment).filter(PossessionSegment.match_id == match_id).delete(synchronize_session=False)
    db.query(State).filter(State.match_id == match_id).delete(synchronize_session=False)
    db.query(Event).filter(Event.match_id == match_id).delete(synchronize_session=False)
    db.query(DominanceBin).filter(DominanceBin.match_id == match_id).delete(synchronize_session=False)

    # Keep outbox cleanup portable and resilient across SQLAlchemy/JSONB operator changes.
    outbox_rows = db.query(Outbox).all()
    for row_outbox in outbox_rows:
        payload = row_outbox.payload if isinstance(row_outbox.payload, dict) else {}
        if payload.get("match_id") == str(match_id):
            db.delete(row_outbox)

    db.delete(row)
    db.commit()
    _audit(
        db,
        "MATCH_DELETE",
        "match",
        actor=user,
        target_id=str(match_id),
        match_id=match_id,
        severity="WARN",
        details={"confirmed_live_action": confirm_live_action, "stop_stream": stop_stream},
    )
    db.commit()

    return {"ok": True, "deleted_match_id": str(match_id), "stream_stop_requested": stop_stream}


@app.post("/api/matches/{match_id}/lock/acquire")
def acquire_lock(
    match_id: UUID,
    body: AcquireLockRequest | None = None,
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)
    user_id = _resolve_user_id(body.user_id if body else None, session_user)
    admin_takeover = body.admin_takeover if body else False
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    if row.operator_id and row.operator_id != user_id and not admin_takeover and not _is_superuser(session_user):
        raise HTTPException(status_code=409, detail="Lock already acquired")
    row.operator_id = user_id
    db.commit()
    _audit(
        db,
        "LOCK_ACQUIRE",
        "match",
        actor=session_user,
        target_id=str(row.id),
        match_id=row.id,
        severity="INFO",
        details={"operator_id": row.operator_id, "admin_takeover": admin_takeover},
    )
    db.commit()
    return {"ok": True, "operator_id": row.operator_id}


@app.post("/api/matches/{match_id}/lock/release")
def release_lock(
    match_id: UUID,
    body: ReleaseLockRequest | None = None,
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(row)

    user_id = _resolve_user_id(body.user_id if body else None, session_user)
    admin_takeover = body.admin_takeover if body else False
    if row.operator_id and row.operator_id != user_id and not admin_takeover and not _is_superuser(session_user):
        raise HTTPException(status_code=403, detail="Not lock owner")
    row.operator_id = None
    db.commit()
    _audit(
        db,
        "LOCK_RELEASE",
        "match",
        actor=session_user,
        target_id=str(row.id),
        match_id=row.id,
        severity="INFO",
        details={"admin_takeover": admin_takeover},
    )
    db.commit()
    return {"ok": True}


@app.post("/api/matches/{match_id}/state")
def post_state(
    match_id: UUID,
    body: StateRequest,
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(match_obj)
    _require_write_lock(match_obj, _resolve_user_id(body.user_id, session_user))

    existing = db.get(State, body.state_id)
    if existing:
        return {"ok": True, "idempotent": True, "state_id": existing.id}

    prev = _latest_state(match_id, db)
    if prev and body.clock_ms < prev.clock_ms and not body.allow_clock_rewind:
        # Ignore stale state packets arriving out-of-order to keep possession segments monotonic.
        return {
            "ok": True,
            "ignored": True,
            "reason": "stale_clock",
            "state_id": body.state_id,
            "latest_clock_ms": prev.clock_ms,
        }

    prev_team = prev.possession_team if prev else "NONE"
    if prev and body.clock_ms < prev.clock_ms and body.allow_clock_rewind:
        # Controlled rewind (e.g., 2H starts at 45:00 after 1H stoppage). Close open segments
        # at previous clock to keep durations non-negative, then restart segmentation from clean state.
        open_segments = (
            db.query(PossessionSegment)
            .filter(PossessionSegment.match_id == match_id)
            .filter(PossessionSegment.end_ms.is_(None))
            .all()
        )
        for seg in open_segments:
            if prev.clock_ms >= seg.start_ms:
                seg.end_ms = prev.clock_ms
                apply_possession_segment(db, match_id, seg.team, seg.start_ms, seg.end_ms)
        prev_team = "NONE"

    _normalize_stale_open_possession_segments(match_id, db)

    new_team = body.possession_team

    if prev_team != new_team:
        open_segments = (
            db.query(PossessionSegment)
            .filter(PossessionSegment.match_id == match_id)
            .filter(PossessionSegment.end_ms.is_(None))
            .order_by(PossessionSegment.start_ms.asc(), PossessionSegment.created_at.asc(), PossessionSegment.id.asc())
            .all()
        )
        for seg in open_segments:
            if body.clock_ms >= seg.start_ms:
                seg.end_ms = body.clock_ms
                apply_possession_segment(db, match_id, seg.team, seg.start_ms, seg.end_ms)

        if new_team in ("HOME", "AWAY"):
            db.add(PossessionSegment(match_id=match_id, team=new_team, start_ms=body.clock_ms, end_ms=None))

    elif prev is None and new_team in ("HOME", "AWAY"):
        db.add(PossessionSegment(match_id=match_id, team=new_team, start_ms=body.clock_ms, end_ms=None))

    state = State(
        id=body.state_id,
        match_id=match_id,
        clock_ms=body.clock_ms,
        running=body.running,
        possession_team=body.possession_team,
        selected_team=body.selected_team,
        attack_lr=body.attack_lr,
    )
    db.add(state)

    payload = {
        "kind": "STATE",
        "state_id": str(body.state_id),
        "idempotency_key": str(body.state_id),
        "match_id": str(match_id),
        "clock_ms": body.clock_ms,
        "running": body.running,
        "possession_team": body.possession_team,
        "selected_team": body.selected_team,
        "attack_lr": body.attack_lr,
        "created_at": datetime.utcnow().isoformat(),
    }
    _enqueue_webhook_fanout(db, "STATE", body.state_id, payload)

    db.commit()
    return {"ok": True, "state_id": body.state_id}


@app.post("/api/matches/{match_id}/markers")
def post_match_marker(
    match_id: UUID,
    body: MatchMarkerRequest,
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(match_obj)
    _require_write_lock(match_obj, _resolve_user_id(body.user_id, session_user))

    clock_ms = body.clock_ms
    if clock_ms is None:
        last_state = _latest_state(match_id, db)
        if not last_state:
            raise HTTPException(status_code=400, detail="clock_ms missing and no state exists")
        clock_ms = last_state.clock_ms

    marker = (
        db.query(MatchMarker)
        .filter(MatchMarker.match_id == match_id, MatchMarker.marker_type == body.marker_type)
        .order_by(MatchMarker.created_at.asc(), MatchMarker.id.asc())
        .first()
    )
    if marker:
        marker.clock_ms = clock_ms
        marker.updated_at = datetime.utcnow()
    else:
        marker = MatchMarker(match_id=match_id, marker_type=body.marker_type, clock_ms=clock_ms)
        db.add(marker)

    db.commit()
    db.refresh(marker)
    _audit(
        db,
        "MATCH_MARKER_SET",
        "match",
        actor=session_user,
        target_id=str(match_id),
        match_id=match_id,
        severity="INFO",
        details={"marker_type": body.marker_type, "clock_ms": clock_ms},
    )
    db.commit()
    return {
        "ok": True,
        "marker": {
            "id": str(marker.id),
            "match_id": str(match_id),
            "marker_type": marker.marker_type,
            "clock_ms": marker.clock_ms,
            "created_at": marker.created_at.isoformat(),
            "updated_at": marker.updated_at.isoformat(),
        },
    }


@app.post("/api/matches/{match_id}/events/attack_lane")
def post_attack_lane(
    match_id: UUID,
    body: AttackLaneEventRequest,
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(match_obj)
    _require_write_lock(match_obj, _resolve_user_id(body.user_id, session_user))

    existing = db.get(Event, body.event_id)
    if existing:
        return {"ok": True, "idempotent": True, "event_id": existing.id}

    clock_ms = body.clock_ms
    if clock_ms is None:
        last_state = _latest_state(match_id, db)
        if not last_state:
            raise HTTPException(status_code=400, detail="clock_ms missing and no state exists")
        clock_ms = last_state.clock_ms

    event = Event(
        id=body.event_id,
        match_id=match_id,
        type="ATTACK_LANE",
        clock_ms=clock_ms,
        team=body.team,
        lane=body.lane,
    )
    db.add(event)
    apply_attack_event(db, match_id, body.team, clock_ms)
    clock_context = _clock_normalization_context(match_id, db)
    match_clock_ms = _normalize_match_clock_ms(clock_ms, clock_context)

    payload = {
        "kind": "EVENT",
        "event_id": str(body.event_id),
        "idempotency_key": str(body.event_id),
        "match_id": str(match_id),
        "type": "ATTACK_LANE",
        "clock_ms": match_clock_ms,
        "clock": _fmt_clock_ms(match_clock_ms),
        "raw_clock_ms": clock_ms,
        "raw_clock": _fmt_clock_ms(clock_ms),
        "team": body.team,
        "team_side": "H" if body.team == "HOME" else "A",
        "lane": body.lane,
        "created_at": datetime.utcnow().isoformat(),
    }
    _enqueue_webhook_fanout(db, "EVENT", body.event_id, payload)

    db.commit()
    return {"ok": True, "event_id": body.event_id}


@app.post("/api/matches/{match_id}/events/xg")
def post_xg(
    match_id: UUID,
    body: XGEventRequest,
    db: Session = Depends(get_db),
    session_user: User | None = Depends(_get_session_user),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_match_not_archived(match_obj)
    _require_write_lock(match_obj, _resolve_user_id(body.user_id, session_user))

    existing = db.get(Event, body.event_id)
    if existing:
        return {"ok": True, "idempotent": True, "event_id": existing.id}

    clock_ms = body.clock_ms
    if clock_ms is None:
        last_state = _latest_state(match_id, db)
        if not last_state:
            raise HTTPException(status_code=400, detail="clock_ms missing and no state exists")
        clock_ms = last_state.clock_ms

    xgot_meta = _estimate_xgot(
        body.xg,
        is_on_target=body.is_on_target,
        goalmouth_x=body.goalmouth_x,
        goalmouth_y=body.goalmouth_y,
        is_goal=body.is_goal,
        is_header=body.is_header,
        is_weak_foot=body.is_weak_foot,
        under_pressure=body.under_pressure,
        one_on_one=body.one_on_one,
        shot_pace_band=body.shot_pace_band,
    )

    event = Event(
        id=body.event_id,
        match_id=match_id,
        type="XG",
        clock_ms=clock_ms,
        team=body.team,
        xg=body.xg,
        xgot=xgot_meta["xgot"],
        player_name=(body.player_name or "").strip() or None,
        player_number=(body.player_number or "").strip() or None,
        is_goal=body.is_goal,
        is_on_target=body.is_on_target,
        shot_x=body.shot_x,
        shot_y=body.shot_y,
        goalmouth_x=body.goalmouth_x,
        goalmouth_y=body.goalmouth_y,
        is_header=body.is_header,
        is_weak_foot=body.is_weak_foot,
        under_pressure=body.under_pressure,
        one_on_one=body.one_on_one,
        shot_pace_band=body.shot_pace_band,
    )
    db.add(event)
    goal_boost = float(os.getenv("DOM_GOAL_XG_MULTIPLIER", "2.5"))
    dominance_xg = body.xg * goal_boost if body.is_goal else body.xg
    apply_xg_event(db, match_id, body.team, clock_ms, dominance_xg)
    clock_context = _clock_normalization_context(match_id, db)
    match_clock_ms = _normalize_match_clock_ms(clock_ms, clock_context)

    payload = {
        "kind": "EVENT",
        "event_id": str(body.event_id),
        "idempotency_key": str(body.event_id),
        "match_id": str(match_id),
        "type": "XG",
        "clock_ms": match_clock_ms,
        "clock": _fmt_clock_ms(match_clock_ms),
        "raw_clock_ms": clock_ms,
        "raw_clock": _fmt_clock_ms(clock_ms),
        "team": body.team,
        "team_side": "H" if body.team == "HOME" else "A",
        "xg": body.xg,
        "xgot": xgot_meta["xgot"],
        "player_name": (body.player_name or "").strip() or None,
        "player_number": (body.player_number or "").strip() or None,
        "is_goal": body.is_goal,
        "is_on_target": body.is_on_target,
        "shot_x": body.shot_x,
        "shot_y": body.shot_y,
        "goalmouth_x": body.goalmouth_x,
        "goalmouth_y": body.goalmouth_y,
        "is_header": body.is_header,
        "is_weak_foot": body.is_weak_foot,
        "under_pressure": body.under_pressure,
        "one_on_one": body.one_on_one,
        "shot_pace_band": body.shot_pace_band,
        "created_at": datetime.utcnow().isoformat(),
    }
    _enqueue_webhook_fanout(db, "EVENT", body.event_id, payload)

    db.commit()
    return {"ok": True, "event_id": body.event_id, "xgot": xgot_meta["xgot"], "xgot_meta": xgot_meta}


@app.patch("/api/admin/matches/{match_id}", response_model=MatchResponse)
def update_archived_match(
    match_id: UUID,
    body: UpdateArchivedMatchRequest,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_archived_editor_access(match_obj, user)

    next_name = body.name.strip()
    name_match = MATCH_NAME_PATTERN.match(next_name)
    if not name_match:
        raise HTTPException(status_code=400, detail="Match name must follow '[CLASS | 1R] HOME vs AWAY' format")

    next_class = _normalize_competition_class(name_match.group("class"))
    if not db.get(CompetitionClass, next_class):
        raise HTTPException(status_code=400, detail="Unknown competition class")
    next_round = int(name_match.group("round"))
    home_team = name_match.group("home").strip()
    away_team = name_match.group("away").strip()

    previous_name = match_obj.name
    metadata = dict(match_obj.metadata_json or {})
    metadata["home_team"] = home_team
    metadata["away_team"] = away_team
    match_obj.name = next_name
    match_obj.competition_class = next_class
    match_obj.round_number = next_round
    match_obj.metadata_json = metadata

    _audit(
        db,
        "MATCH_RENAME",
        "match",
        actor=user,
        target_id=str(match_obj.id),
        match_id=match_obj.id,
        severity="INFO",
        details={"previous_name": previous_name, "next_name": next_name},
    )
    db.commit()
    db.refresh(match_obj)
    return _serialize_match(match_obj)


@app.get("/api/admin/matches/{match_id}/timeline-items", response_model=TimelineEditorListResponse)
def list_timeline_items(
    match_id: UUID,
    type: str | None = Query(default=None),
    team: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_archived_editor_access(match_obj, user)

    normalized_type = (type or "").strip().upper() or None
    normalized_team = (team or "").strip().upper() or None

    event_query = db.query(Event).filter(Event.match_id == match_id)
    if normalized_type in {"ATTACK_LANE", "XG"}:
        event_query = event_query.filter(Event.type == normalized_type)
    if normalized_team in {"HOME", "AWAY"}:
        event_query = event_query.filter(Event.team == normalized_team)
    event_rows = event_query.all()

    marker_rows: list[MatchMarker] = []
    if normalized_team is None and normalized_type in {None, "HALFTIME_START"}:
        marker_rows = db.query(MatchMarker).filter(MatchMarker.match_id == match_id).all()

    items = [_serialize_timeline_item(row) for row in event_rows]
    items.extend(_serialize_timeline_item(row) for row in marker_rows)
    items.sort(key=lambda item: (item.clock_ms, item.created_at, item.item_id), reverse=True)

    total = len(items)
    return TimelineEditorListResponse(items=items[offset:offset + limit], total=total, limit=limit, offset=offset)


@app.post("/api/admin/matches/{match_id}/timeline-items")
def create_timeline_item(
    match_id: UUID,
    body: TimelineEditorUpsertRequest,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_archived_editor_access(match_obj, user)

    if body.kind == "EVENT":
        event = Event(id=uuid.uuid4(), match_id=match_id, type="ATTACK_LANE", clock_ms=body.clock_ms, team=body.team or "HOME")
        db.add(event)
        xgot_meta = _apply_editor_item_updates(event=event, marker=None, body=body)
        target_id = str(event.id)
        result = {"ok": True, "item_id": target_id, "kind": "EVENT", "xgot_meta": xgot_meta}
    else:
        marker = MatchMarker(match_id=match_id, marker_type="HALFTIME_START", clock_ms=body.clock_ms)
        db.add(marker)
        _apply_editor_item_updates(event=None, marker=marker, body=body)
        target_id = str(marker.id)
        result = {"ok": True, "item_id": target_id, "kind": "MARKER"}

    _rebuild_match_projections(match_id, db)
    _audit(
        db,
        "TIMELINE_ITEM_CREATE",
        "match",
        actor=user,
        target_id=target_id,
        match_id=match_id,
        severity="WARN",
        details={"kind": body.kind, "type": body.type, "clock_ms": body.clock_ms},
    )
    db.commit()
    return result


@app.patch("/api/admin/matches/{match_id}/timeline-items/{item_kind}/{item_id}")
def update_timeline_item(
    match_id: UUID,
    item_kind: str,
    item_id: UUID,
    body: TimelineEditorUpsertRequest,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_archived_editor_access(match_obj, user)

    normalized_kind = item_kind.strip().upper()
    if normalized_kind == "EVENT":
        event = db.get(Event, item_id)
        if not event or event.match_id != match_id:
            raise HTTPException(status_code=404, detail="Event not found")
        xgot_meta = _apply_editor_item_updates(event=event, marker=None, body=body)
    elif normalized_kind == "MARKER":
        marker = db.get(MatchMarker, item_id)
        if not marker or marker.match_id != match_id:
            raise HTTPException(status_code=404, detail="Marker not found")
        xgot_meta = _apply_editor_item_updates(event=None, marker=marker, body=body)
    else:
        raise HTTPException(status_code=400, detail="Unsupported item kind")

    _rebuild_match_projections(match_id, db)
    _audit(
        db,
        "TIMELINE_ITEM_UPDATE",
        "match",
        actor=user,
        target_id=str(item_id),
        match_id=match_id,
        severity="WARN",
        details={"kind": body.kind, "type": body.type, "clock_ms": body.clock_ms},
    )
    db.commit()
    return {"ok": True, "item_id": str(item_id), "kind": normalized_kind, "xgot_meta": xgot_meta}


@app.delete("/api/admin/matches/{match_id}/timeline-items/{item_kind}/{item_id}")
def delete_timeline_item(
    match_id: UUID,
    item_kind: str,
    item_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_archived_editor_access(match_obj, user)

    normalized_kind = item_kind.strip().upper()
    item_type = ""
    if normalized_kind == "EVENT":
        event = db.get(Event, item_id)
        if not event or event.match_id != match_id:
            raise HTTPException(status_code=404, detail="Event not found")
        item_type = event.type
        db.delete(event)
    elif normalized_kind == "MARKER":
        marker = db.get(MatchMarker, item_id)
        if not marker or marker.match_id != match_id:
            raise HTTPException(status_code=404, detail="Marker not found")
        item_type = marker.marker_type
        db.delete(marker)
    else:
        raise HTTPException(status_code=400, detail="Unsupported item kind")

    _rebuild_match_projections(match_id, db)
    _audit(
        db,
        "TIMELINE_ITEM_DELETE",
        "match",
        actor=user,
        target_id=str(item_id),
        match_id=match_id,
        severity="WARN",
        details={"kind": normalized_kind, "type": item_type},
    )
    db.commit()
    return {"ok": True, "item_id": str(item_id), "kind": normalized_kind}


@app.get("/api/matches/{match_id}/summary")
def summary(match_id: UUID, db: Session = Depends(get_db)):
    cache_key = ("summary", str(match_id))
    cached = _cache_get(_match_response_cache, cache_key)
    if cached is not None:
        return cached
    return _cache_set(_match_response_cache, cache_key, _build_match_summary(match_id, db))


@app.get("/api/matches/{match_id}/dominance")
def dominance(
    match_id: UUID,
    bin_seconds: int = Query(default=180),
    split_halves: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    cache_key = (str(match_id), bin_seconds, split_halves)
    now = time.monotonic()
    if DOMINANCE_CACHE_TTL_SECONDS > 0:
        cached = _dominance_response_cache.get(cache_key)
        if cached and now - cached[0] <= DOMINANCE_CACHE_TTL_SECONDS:
            return cached[1]
    result = _build_dominance(match_id, bin_seconds, db, split_halves=split_halves)
    if DOMINANCE_CACHE_TTL_SECONDS > 0:
        _dominance_response_cache[cache_key] = (now, result)
    return result


@app.get("/api/matches/{match_id}/export.csv")
def export_match_csv(match_id: UUID, db: Session = Depends(get_db)):
    csv_content, filename = _build_match_export_csv(match_id, db)
    return Response(
        content=csv_content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@app.get("/api/v1/matches/{match_id}")
def get_match_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    row = _require_football_match_for_partner(match_id, db)
    return _serialize_match(row, include_sport=False)


@app.get("/api/v1/matches")
def list_matches_v1(_auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    rows = db.query(Match).filter(Match.sport == "FOOTBALL").order_by(desc(Match.created_at)).all()
    return [_serialize_match(r, include_sport=False) for r in rows]


@app.get("/api/v1/matches/{match_id}/summary")
def summary_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    _require_football_match_for_partner(match_id, db)
    return _build_match_summary(match_id, db)


@app.get("/api/v1/matches/{match_id}/dominance")
def dominance_v1(
    match_id: UUID,
    _auth: None = Depends(_require_partner_auth),
    bin_seconds: int = Query(default=180),
    split_halves: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    _require_football_match_for_partner(match_id, db)
    return _build_dominance(match_id, bin_seconds, db, split_halves=split_halves)


@app.get("/api/v1/matches/{match_id}/events")
def events_v1(
    match_id: UUID,
    _auth: None = Depends(_require_partner_auth),
    since: str | None = Query(default=None, description="ISO datetime, exclusive"),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    _require_football_match_for_partner(match_id, db)

    since_dt = _as_naive_utc(_parse_iso_dt(since))
    q = db.query(Event).filter(Event.match_id == match_id)
    base_seq = 0
    if since_dt:
        base_seq = db.query(Event).filter(Event.match_id == match_id, Event.created_at <= since_dt).count()
        q = q.filter(Event.created_at > since_dt)

    rows = q.order_by(Event.created_at.asc(), Event.id.asc()).limit(limit).all()
    clock_context = _clock_normalization_context(match_id, db)
    items = []
    for idx, e in enumerate(rows, start=1):
        match_clock_ms = _normalize_match_clock_ms(e.clock_ms, clock_context)
        items.append(
            {
                "sequence": base_seq + idx,
                "event_id": str(e.id),
                "match_id": str(match_id),
                "type": e.type,
                "clock_ms": match_clock_ms,
                "clock": _fmt_clock_ms(match_clock_ms),
                "raw_clock_ms": e.clock_ms,
                "raw_clock": _fmt_clock_ms(e.clock_ms),
                "team": e.team,
                **_event_player_payload(e),
                "lane": e.lane,
                "xg": e.xg,
                "xgot": e.xgot,
                "is_goal": e.is_goal,
                "is_on_target": e.is_on_target,
                "shot_x": e.shot_x,
                "shot_y": e.shot_y,
                "goalmouth_x": e.goalmouth_x,
                "goalmouth_y": e.goalmouth_y,
                "is_header": e.is_header,
                "is_weak_foot": e.is_weak_foot,
                "under_pressure": e.under_pressure,
                "one_on_one": e.one_on_one,
                "shot_pace_band": e.shot_pace_band,
                "created_at": e.created_at.isoformat(),
            }
        )

    return {
        "match_id": str(match_id),
        "count": len(items),
        "events": items,
    }


@app.get("/api/v1/matches/{match_id}/timeline/possession")
def possession_timeline_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    _require_football_match_for_partner(match_id, db)

    last_state = _latest_state(match_id, db)
    current_clock = last_state.clock_ms if last_state else 0
    rows = (
        db.query(PossessionSegment)
        .filter(PossessionSegment.match_id == match_id)
        .order_by(PossessionSegment.start_ms.asc(), PossessionSegment.created_at.asc())
        .all()
    )

    home_ms = 0
    away_ms = 0
    timeline = []
    clock_context = _clock_normalization_context(match_id, db)
    for seg in rows:
        end_ms = seg.end_ms if seg.end_ms is not None else current_clock
        start_match_ms = _normalize_match_clock_ms(seg.start_ms, clock_context)
        end_match_ms = _normalize_match_clock_ms(end_ms, clock_context)
        duration_ms = max(0, end_ms - seg.start_ms)
        if seg.team == "HOME":
            home_ms += duration_ms
        elif seg.team == "AWAY":
            away_ms += duration_ms
        total = home_ms + away_ms
        timeline.append(
            {
                "timeline": _fmt_clock_ms(end_match_ms),
                "team": seg.team,
                "start_ms": start_match_ms,
                "end_ms": end_match_ms,
                "raw_start_ms": seg.start_ms,
                "raw_end_ms": end_ms,
                "duration_ms": duration_ms,
                "home_pct": (home_ms / total * 100.0) if total else 0.0,
                "away_pct": (away_ms / total * 100.0) if total else 0.0,
            }
        )

    return {"match_id": str(match_id), "timeline": timeline}


@app.get("/api/v1/matches/{match_id}/result")
def partner_match_result_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    _require_football_match_for_partner(match_id, db)
    return _build_partner_match_result(match_id, db)


@app.get("/api/v1/basketball/matches")
def list_basketball_matches_v1(_auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    rows = db.query(Match).filter(Match.sport == "BASKETBALL").order_by(desc(Match.created_at)).all()
    return [_serialize_match(row) for row in rows]


@app.get("/api/v1/basketball/matches/{match_id}")
def get_basketball_match_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    row = _require_basketball_match_for_partner(match_id, db)
    return _serialize_match(row)


@app.get("/api/v1/basketball/matches/{match_id}/state")
def basketball_state_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    row = _require_basketball_match_for_partner(match_id, db)
    return _build_basketball_state(row)


@app.get("/api/v1/basketball/matches/{match_id}/events")
def basketball_events_v1(
    match_id: UUID,
    _auth: None = Depends(_require_partner_auth),
    since: str | None = Query(default=None, description="ISO datetime, exclusive"),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    row = _require_basketball_match_for_partner(match_id, db)
    since_dt = _parse_iso_dt(since)
    raw_events = _basketball_events(row)
    items = []
    base_seq = 0
    for sequence, event in enumerate(raw_events, start=1):
        created_at_raw = _basketball_event_created_at(event) if isinstance(event, dict) else None
        created_at = _as_naive_utc(_parse_iso_dt(created_at_raw)) if created_at_raw else None
        if since_dt and created_at and created_at <= since_dt:
            base_seq = sequence
            continue
        if since_dt and not created_at:
            continue
        items.append(_serialize_basketball_event(match_id, event, sequence))
        if len(items) >= limit:
            break
    return {"match_id": str(match_id), "count": len(items), "base_sequence": base_seq, "events": items}


@app.get("/api/v1/basketball/matches/{match_id}/summary")
def basketball_summary_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    row = _require_basketball_match_for_partner(match_id, db)
    state = _build_basketball_state(row)
    return {
        "match_id": str(row.id),
        "sport": "BASKETBALL",
        "home": state["home"],
        "away": state["away"],
        "timer": state["timer"],
        "stats": state["stats"],
        "event_count": state["event_count"],
        "updated_at": state["updated_at"],
    }


@app.get("/api/v1/basketball/matches/{match_id}/margin-flow")
def basketball_margin_flow_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    row = _require_basketball_match_for_partner(match_id, db)
    return _build_basketball_margin_flow(row)


@app.get("/api/v1/basketball/matches/{match_id}/result")
def basketball_result_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    row = _require_basketball_match_for_partner(match_id, db)
    return {
        "match": _serialize_match(row),
        "state": _build_basketball_state(row),
        "events": basketball_events_v1(match_id, _auth, None, 1000, db),
        "margin_flow": _build_basketball_margin_flow(row),
    }


@app.post("/api/v1/basketball/webhooks/subscriptions")
def create_basketball_webhook_subscription(
    body: dict[str, Any] = Body(default_factory=dict),
    _auth: None = Depends(_require_partner_auth),
    db: Session = Depends(get_db),
):
    callback_url = str(body.get("callback_url") or "").strip()
    if not callback_url:
        raise HTTPException(status_code=400, detail="callback_url is required")
    events = body.get("events") or ["BASKETBALL_EVENT"]
    if not isinstance(events, list):
        raise HTTPException(status_code=400, detail="events must be a list")
    normalized_events = sorted({str(event).strip().upper() for event in events if str(event).strip()})
    allowed_events = {"BASKETBALL_STATE", "BASKETBALL_EVENT"}
    if not normalized_events or any(event not in allowed_events for event in normalized_events):
        raise HTTPException(status_code=400, detail="events must contain BASKETBALL_STATE and/or BASKETBALL_EVENT")

    existing = db.query(WebhookSubscription).filter(WebhookSubscription.callback_url == callback_url).first()
    if existing:
        existing.events = normalized_events
        existing.secret = body.get("secret")
        existing.active = bool(body.get("active", True))
        db.commit()
        db.refresh(existing)
        return _serialize_webhook_subscription(existing)

    sub = WebhookSubscription(
        callback_url=callback_url,
        events=normalized_events,
        secret=body.get("secret"),
        active=bool(body.get("active", True)),
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return _serialize_webhook_subscription(sub)


@app.get("/api/v1/basketball/webhooks/subscriptions")
def list_basketball_webhook_subscriptions(_auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    basketball_events = {"BASKETBALL_STATE", "BASKETBALL_EVENT"}
    rows = db.query(WebhookSubscription).order_by(desc(WebhookSubscription.created_at)).all()
    return [
        _serialize_webhook_subscription(row)
        for row in rows
        if basketball_events.intersection(set(row.events or []))
    ]


@app.delete("/api/v1/basketball/webhooks/subscriptions/{subscription_id}")
def delete_basketball_webhook_subscription(
    subscription_id: UUID,
    _auth: None = Depends(_require_partner_auth),
    db: Session = Depends(get_db),
):
    row = db.get(WebhookSubscription, subscription_id)
    if not row or not {"BASKETBALL_STATE", "BASKETBALL_EVENT"}.intersection(set(row.events or [])):
        raise HTTPException(status_code=404, detail="Subscription not found")
    db.delete(row)
    db.commit()
    return {"ok": True, "subscription_id": str(subscription_id)}


@app.post("/api/v1/webhooks/subscriptions")
def create_webhook_subscription(
    body: WebhookSubscriptionCreateRequest,
    _auth: None = Depends(_require_partner_auth),
    db: Session = Depends(get_db),
):
    events = sorted(set(body.events or ["STATE", "EVENT"]))
    if not events:
        raise HTTPException(status_code=400, detail="At least one event type is required")

    existing = (
        db.query(WebhookSubscription)
        .filter(WebhookSubscription.callback_url == body.callback_url.strip())
        .first()
    )
    if existing:
        existing.events = events
        existing.secret = body.secret
        existing.active = body.active
        db.commit()
        db.refresh(existing)
        sub = existing
    else:
        sub = WebhookSubscription(
            callback_url=body.callback_url.strip(),
            events=events,
            secret=body.secret,
            active=body.active,
        )
        db.add(sub)
        db.commit()
        db.refresh(sub)

    return {
        "id": str(sub.id),
        "callback_url": sub.callback_url,
        "events": sub.events,
        "active": sub.active,
        "created_at": sub.created_at.isoformat(),
        "updated_at": sub.updated_at.isoformat(),
    }


@app.get("/api/v1/webhooks/subscriptions")
def list_webhook_subscriptions(_auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    rows = db.query(WebhookSubscription).order_by(desc(WebhookSubscription.created_at)).all()
    return [
        {
            "id": str(r.id),
            "callback_url": r.callback_url,
            "events": r.events or [],
            "active": r.active,
            "created_at": r.created_at.isoformat(),
            "updated_at": r.updated_at.isoformat(),
        }
        for r in rows
    ]


@app.delete("/api/v1/webhooks/subscriptions/{subscription_id}")
def delete_webhook_subscription(
    subscription_id: UUID,
    _auth: None = Depends(_require_partner_auth),
    db: Session = Depends(get_db),
):
    row = db.get(WebhookSubscription, subscription_id)
    if not row:
        raise HTTPException(status_code=404, detail="Subscription not found")
    db.delete(row)
    db.commit()
    return {"ok": True, "subscription_id": str(subscription_id)}


@app.get("/api/outbox")
def outbox_debug(db: Session = Depends(get_db)):
    rows = latest_outbox(db, 100)
    return [
        {
            "id": str(r.id),
            "kind": r.kind,
            "ref_id": str(r.ref_id),
            "target_url": r.target_url,
            "attempts": r.attempts,
            "next_attempt_at": r.next_attempt_at.isoformat(),
            "last_error": r.last_error,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@app.post("/api/highlight/jobs")
async def create_highlight_job(
    video: UploadFile = File(...),
    mode: str = Form("ai"),
    highlight_count: int = Form(40),
    second_half_start_sec: float = Form(0.0),
    log_data_json: str = Form("[]"),
    db: Session = Depends(get_db),
    user_id: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = db.get(User, user_id)
    if not user or not _is_superuser(user):
        raise HTTPException(status_code=403, detail="Superadmin only")
    if mode not in {"ai", "log_ai"}:
        raise HTTPException(status_code=400, detail="mode must be 'ai' or 'log_ai'")

    try:
        log_data = json.loads(log_data_json) if mode == "log_ai" else []
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid log_data_json: {exc}") from exc
    if not isinstance(log_data, list):
        raise HTTPException(status_code=400, detail="log_data_json must be an array")

    job_id = str(uuid.uuid4())
    suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
    upload_path = upload_dir() / f"{job_id}{suffix}"
    try:
        with upload_path.open("wb") as out_file:
            shutil.copyfileobj(video.file, out_file)
    finally:
        await video.close()

    metadata = {
        "highlight_count": max(1, min(int(highlight_count), 100)),
        "second_half_start_sec": second_half_start_sec,
        "log_data": log_data,
        "worker": {"mode": "external", "queued_at": datetime.utcnow().isoformat()},
        "progress": {
            "phase": "queued",
            "percent": 0,
            "detail": "작업 대기 중",
            "updated_at": datetime.utcnow().isoformat(),
        },
    }
    job = HighlightJob(
        id=job_id,
        status="queued",
        mode=mode,
        original_filename=video.filename or "video.mp4",
        upload_path=str(upload_path),
        job_metadata=metadata,
    )
    db.add(job)
    db.commit()
    return {"job_id": job_id, "status": "queued"}


def _require_player_job(db: Session, job_id: str) -> HighlightJob:
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.mode != "player":
        raise HTTPException(status_code=400, detail="개인 클립 작업이 아닙니다.")
    return job


def _load_player_detection(job: HighlightJob):
    import pandas as pd

    metadata = job.job_metadata or {}
    detection_file = str(metadata.get("detection_file") or "player_detections.csv")
    detection_path = job_dir(job.id) / detection_file
    if not detection_path.exists():
        raise HTTPException(status_code=400, detail="탐지 결과가 없습니다. 먼저 탐지를 완료하세요.")
    return pd.read_csv(detection_path), float(metadata.get("fps") or 30.0)


def _player_track_windows(body: dict, fps: float) -> list[tuple[int, float, float]] | None:
    windows = body.get("track_windows") or []
    parsed = [(int(track_id), float(start_sec) * fps, float(end_sec) * fps) for track_id, start_sec, end_sec in windows]
    return parsed or None


@app.post("/api/highlight/player-jobs")
async def create_player_job(
    video: UploadFile = File(...),
    display_name: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job_id = str(uuid.uuid4())
    suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
    upload_path = upload_dir() / f"{job_id}{suffix}"
    try:
        with upload_path.open("wb") as out_file:
            shutil.copyfileobj(video.file, out_file)
    finally:
        await video.close()

    metadata = {
        "display_name": display_name.strip() or None,
        "worker": {
            "mode": "external",
            "queued_at": datetime.utcnow().isoformat(),
            "queued_by": user.name,
        },
        "progress": {
            "phase": "queued",
            "percent": 0,
            "detail": "개인클립 탐지 대기 중",
            "updated_at": datetime.utcnow().isoformat(),
        },
    }
    job = HighlightJob(
        id=job_id,
        status="queued",
        mode="player",
        original_filename=video.filename or "video.mp4",
        upload_path=str(upload_path),
        job_metadata=metadata,
    )
    db.add(job)
    db.commit()
    return {"job_id": job_id, "status": "queued"}


def _require_operator_job(db: Session, job_id: str, user: User) -> HighlightJob:
    job = db.get(HighlightJob, job_id)
    if not job or job.mode != "operator":
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    if not _is_superuser(user) and job.owner_id != user.id:
        raise HTTPException(status_code=403, detail="본인 업로드만 접근할 수 있습니다.")
    return job


def _require_highlight_job_export_access(db: Session, job_id: str, user: User) -> HighlightJob:
    job = db.get(HighlightJob, job_id)
    if not job or not job.export_path:
        raise HTTPException(status_code=404, detail="Export not found")
    if job.mode == "operator" and job.owner_id == user.id:
        return job
    if not _is_superuser(user):
        raise HTTPException(status_code=403, detail="Superadmin only")
    return job


@app.post("/api/highlight/operator-jobs")
async def create_operator_job(
    video: UploadFile | None = File(default=None),
    reference_image: UploadFile | None = File(default=None),
    source_url: str = Form(""),
    jersey_number: str = Form(""),
    player_name: str = Form(""),
    uniform_color: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    source_url = source_url.strip()
    jersey_number = jersey_number.strip()
    player_name = player_name.strip()
    uniform_color = uniform_color.strip()
    has_file = video is not None and bool(video.filename)
    has_reference = reference_image is not None and bool(reference_image.filename)
    if not has_file and not source_url:
        raise HTTPException(status_code=400, detail="영상 파일 또는 링크가 필요합니다.")
    if has_file and source_url:
        raise HTTPException(status_code=400, detail="파일과 링크 중 하나만 업로드하세요.")
    if not jersey_number:
        raise HTTPException(status_code=400, detail="선수 등번호를 입력하세요.")
    if not player_name:
        raise HTTPException(status_code=400, detail="선수 이름을 입력하세요.")
    if not uniform_color:
        raise HTTPException(status_code=400, detail="유니폼 색을 선택하세요.")
    if not has_reference:
        raise HTTPException(status_code=400, detail="분석할 선수 이미지를 등록하세요.")

    display_name = f"{player_name} ({jersey_number})"
    player_fields = {
        "jersey_number": jersey_number,
        "player_name": player_name,
        "uniform_color": uniform_color,
    }

    job_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()

    assert reference_image is not None
    ref_suffix = Path(reference_image.filename or "ref.png").suffix or ".png"
    reference_path = upload_dir() / f"{job_id}_ref{ref_suffix}"
    try:
        with reference_path.open("wb") as ref_file:
            shutil.copyfileobj(reference_image.file, ref_file)
    finally:
        await reference_image.close()
    player_fields["reference_image_path"] = str(reference_path)

    if has_file:
        assert video is not None
        suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
        upload_path = upload_dir() / f"{job_id}{suffix}"
        try:
            with upload_path.open("wb") as out_file:
                shutil.copyfileobj(video.file, out_file)
        finally:
            await video.close()
        metadata = {
            "source_type": "file",
            "display_name": display_name,
            **player_fields,
            "uploaded_by": user.name,
            "progress": {"phase": "ready", "percent": 100, "detail": "업로드 완료", "updated_at": now},
        }
        job = HighlightJob(
            id=job_id,
            owner_id=user.id,
            status="ready",
            mode="operator",
            original_filename=video.filename or "video.mp4",
            upload_path=str(upload_path),
            job_metadata=metadata,
        )
        db.add(job)
        db.commit()
        return {"job_id": job_id, "status": "ready"}

    metadata = {
        "source_type": "link",
        "source_url": source_url,
        "display_name": display_name,
        **player_fields,
        "uploaded_by": user.name,
        "progress": {"phase": "queued", "percent": 0, "detail": "링크 업로드됨", "updated_at": now},
    }
    job = HighlightJob(
        id=job_id,
        owner_id=user.id,
        status="queued",
        mode="operator",
        original_filename=display_name,
        job_metadata=metadata,
    )
    db.add(job)
    db.commit()
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/highlight/operator-jobs")
def list_operator_jobs(
    scope: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    query = db.query(HighlightJob).filter(HighlightJob.mode == "operator")
    # Non-superusers always see only their own jobs. Superusers see everything by
    # default (the admin process list), but can request scope=mine to limit the
    # result to the clips they uploaded themselves (the "my clips" view).
    if not _is_superuser(user) or scope == "mine":
        query = query.filter(HighlightJob.owner_id == user.id)
    rows = query.order_by(desc(HighlightJob.created_at)).all()

    owner_ids = {row.owner_id for row in rows if row.owner_id}
    name_map: dict[str, str] = {}
    if owner_ids:
        for owner in db.query(User).filter(User.id.in_(owner_ids)).all():
            name_map[owner.id] = owner.name

    result = []
    for row in rows:
        data = serialize_job(row)
        data["owner_name"] = name_map.get(row.owner_id) if row.owner_id else None
        result.append(data)
    return result


@app.get("/api/highlight/operator-jobs/{job_id}")
def get_operator_job(
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    job = _require_operator_job(db, job_id, user)
    data = serialize_job(job)
    if job.owner_id:
        owner = db.get(User, job.owner_id)
        data["owner_name"] = owner.name if owner else None
    return data


@app.delete("/api/highlight/operator-jobs/{job_id}")
def delete_operator_job(
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    job = _require_operator_job(db, job_id, user)
    delete_job_files(job)
    db.delete(job)
    db.commit()
    return {"ok": True}


@app.post("/api/highlight/operator-jobs/{job_id}/fetch")
def fetch_operator_job_link(
    job_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job = _require_operator_job(db, job_id, user)
    metadata = job.job_metadata or {}
    if metadata.get("source_type") != "link":
        raise HTTPException(status_code=400, detail="링크 업로드가 아닙니다.")
    if job.upload_path and Path(job.upload_path).exists():
        return {"status": "ready"}
    background_tasks.add_task(download_link_for_job, job_id)
    return {"status": "downloading"}


@app.get("/api/highlight/operator-jobs/{job_id}/video")
def serve_operator_video(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    job = _require_operator_job(db, job_id, user)
    video_path = Path(job.upload_path) if job.upload_path else None
    if not video_path or not video_path.exists():
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")
    suffix = video_path.suffix.lower()
    media_type = "video/mp4" if suffix in {".mp4", ".m4v", ".mov"} else f"video/{suffix.lstrip('.')}"
    return _serve_file_with_range(video_path, request, media_type)


@app.get("/api/highlight/operator-jobs/{job_id}/reference")
def serve_operator_reference(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    job = _require_operator_job(db, job_id, user)
    ref = (job.job_metadata or {}).get("reference_image_path")
    ref_path = Path(ref) if ref else None
    if not ref_path or not ref_path.exists():
        raise HTTPException(status_code=404, detail="선수 이미지를 찾을 수 없습니다.")
    suffix = ref_path.suffix.lower().lstrip(".") or "png"
    media_type = "image/jpeg" if suffix in {"jpg", "jpeg"} else f"image/{suffix}"
    return _serve_file_with_range(ref_path, request, media_type)


@app.post("/api/highlight/operator-jobs/{job_id}/clips")
def cut_operator_clips(
    job_id: str,
    background_tasks: BackgroundTasks,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job = _require_operator_job(db, job_id, user)
    if not job.upload_path or not Path(job.upload_path).exists():
        raise HTTPException(status_code=409, detail="원본 영상이 아직 준비되지 않았습니다.")
    labels = body.get("labels")
    if not isinstance(labels, list) or not labels:
        raise HTTPException(status_code=400, detail="라벨이 없습니다.")
    try:
        label_secs = [float(x) for x in labels]
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="라벨 형식이 올바르지 않습니다.") from exc
    before = float(body.get("before", 7.0))
    after = float(body.get("after", 4.0))
    background_tasks.add_task(cut_clips_for_job, job_id, label_secs, before, after)
    return {"status": "processing", "count": len(label_secs)}


@app.post("/api/highlight/operator-jobs/{job_id}/clips/{clip_name}/trim")
def trim_operator_clip(
    job_id: str,
    clip_name: str,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job = _require_operator_job(db, job_id, user)
    if not job.upload_path or not Path(job.upload_path).exists():
        raise HTTPException(status_code=409, detail="원본 영상을 찾을 수 없습니다.")
    try:
        start = float(body.get("start"))
        end = float(body.get("end"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="start/end가 올바르지 않습니다.") from exc
    if end <= start:
        raise HTTPException(status_code=400, detail="end는 start보다 커야 합니다.")
    try:
        clip_path = safe_clip_path(job_id, clip_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    from .highlight_jobs import _ffmpeg_cut

    if not _ffmpeg_cut(Path(job.upload_path), clip_path, start, end - start):
        raise HTTPException(status_code=500, detail="클립 트림에 실패했습니다.")

    metadata = dict(job.job_metadata or {})
    clip_info = metadata.get("clip_info") or []
    for clip in clip_info:
        if clip.get("name") == clip_name:
            clip["start"] = round(start, 2)
            clip["end"] = round(end, 2)
            break
    metadata["clip_info"] = clip_info
    update_job(db, job_id, job_metadata=metadata)
    return {"ok": True}


@app.post("/api/highlight/operator-jobs/{job_id}/merge")
def merge_operator_clips(
    job_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job = _require_operator_job(db, job_id, user)
    clips = (job.job_metadata or {}).get("clips") or []
    if not clips:
        raise HTTPException(status_code=400, detail="합칠 클립이 없습니다.")
    background_tasks.add_task(merge_clips_for_job, job_id)
    return {"status": "merging"}


@app.post("/api/highlight/operator-jobs/{job_id}/complete")
def complete_operator_job(
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job = _require_operator_job(db, job_id, user)
    if job.status != "done" or not job.export_path or not Path(job.export_path).exists():
        raise HTTPException(status_code=409, detail="완성된 결과물이 아직 없습니다.")
    metadata = dict(job.job_metadata or {})
    # 원본은 완성되면 삭제하고 결과물(export)만 보존한다.
    if job.upload_path:
        try:
            Path(job.upload_path).unlink(missing_ok=True)
        except Exception:
            pass
    # 분석용 선수 기준 이미지도 함께 삭제한다.
    ref = metadata.get("reference_image_path")
    if ref:
        try:
            Path(ref).unlink(missing_ok=True)
        except Exception:
            pass
        metadata.pop("reference_image_path", None)
    metadata["completed"] = True
    metadata["completed_at"] = datetime.utcnow().isoformat()
    update_job(db, job_id, upload_path=None, job_metadata=metadata)
    return {"ok": True}


@app.get("/api/highlight/player-jobs/{job_id}/video")
def serve_player_video(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user_id: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    metadata = job.job_metadata or {}
    proxy_path = job_dir(job_id) / "proxy.mp4"
    if metadata.get("proxy_file") and proxy_path.exists():
        return _serve_file_with_range(proxy_path, request, "video/mp4")
    video_path = Path(job.upload_path) if job.upload_path else None
    if not video_path or not video_path.exists():
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")
    suffix = video_path.suffix.lower()
    media_type = "video/mp4" if suffix in {".mp4", ".m4v", ".mov"} else f"video/{suffix.lstrip('.')}"
    return _serve_file_with_range(video_path, request, media_type)


@app.post("/api/highlight/player-jobs/{job_id}/proxy")
def make_player_proxy(
    job_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user_id: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    metadata = dict(job.job_metadata or {})
    if metadata.get("proxy_file"):
        proxy_path = job_dir(job_id) / str(metadata["proxy_file"])
        proxy_w, proxy_h = probe_video_dimensions(proxy_path) if proxy_path.exists() else (0, 0)
        if proxy_w > 0 and proxy_h > 0:
            return {"status": "done", "proxy_file": metadata["proxy_file"]}
        metadata["proxy_file"] = None
        metadata["proxy_status"] = "error"
        update_job(db, job_id, job_metadata=metadata)
    if metadata.get("proxy_status") == "running":
        return {"status": "running"}
    metadata["proxy_status"] = "running"
    update_job(db, job_id, job_metadata=metadata)
    background_tasks.add_task(create_player_proxy_for_job, job_id)
    return {"status": "running"}


@app.get("/api/highlight/player-jobs/{job_id}/detections")
def serve_player_detections(
    job_id: str,
    db: Session = Depends(get_db),
    user_id: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    detections, fps = _load_player_detection(job)
    metadata = job.job_metadata or {}
    frames: dict[int, list[dict]] = {}
    for row in detections.itertuples(index=False):
        frames.setdefault(int(row.frame), []).append({
            "cls": row.class_name,
            "tid": int(row.track_id),
            "cx": float(row.cx),
            "cy": float(row.cy),
            "w": float(row.w),
            "h": float(row.h),
        })
    sorted_frames = sorted(frames.keys())
    stride = sorted_frames[1] - sorted_frames[0] if len(sorted_frames) > 1 else 3
    return {
        "job_id": job_id,
        "fps": fps,
        "stride": int(stride),
        "video_w": int(metadata.get("video_w") or 0),
        "video_h": int(metadata.get("video_h") or 0),
        "frames": frames,
    }


@app.get("/api/highlight/player-jobs/{job_id}/events")
def list_player_possession_events(
    job_id: str,
    db: Session = Depends(get_db),
    user_id: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    metadata = job.job_metadata or {}
    return {
        "job_id": job_id,
        "fps": float(metadata.get("fps") or 30.0),
        "event_count": len(metadata.get("events") or []),
        "events": metadata.get("events") or [],
    }


@app.post("/api/highlight/player-jobs/{job_id}/preview")
def preview_player_job_clips(
    job_id: str,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    user_id: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    from .player_clip_extract import CLIP_PAD_AFTER, CLIP_PAD_BEFORE, compute_player_segments

    track_ids = [int(track_id) for track_id in (body.get("track_ids") or [])]
    track_windows = body.get("track_windows") or []
    direct_marks = [float(sec) for sec in (body.get("direct_marks") or [])]
    if not track_ids and not track_windows and not direct_marks:
        return {"job_id": job_id, "clip_count": 0, "segments": []}

    detections, fps = _load_player_detection(job)
    segments = compute_player_segments(
        detections,
        fps,
        track_ids,
        pad_before=float(body.get("pad_before", CLIP_PAD_BEFORE)),
        pad_after=float(body.get("pad_after", CLIP_PAD_AFTER)),
        exclude_intervals=[tuple(interval) for interval in (body.get("exclude_intervals") or [])],
        track_windows=_player_track_windows(body, fps),
        extra_involve_secs=direct_marks,
    )
    total_seconds = round(sum(item["end"] - item["start"] for item in segments), 1)
    return {
        "job_id": job_id,
        "clip_count": len(segments),
        "total_seconds": total_seconds,
        "segments": segments,
    }


@app.post("/api/highlight/player-jobs/{job_id}/extract")
def extract_player_job_clips(
    job_id: str,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    user_id: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if user_id is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    from .player_clip_extract import CLIP_PAD_AFTER, CLIP_PAD_BEFORE, extract_player_clips

    track_ids = [int(track_id) for track_id in (body.get("track_ids") or [])]
    track_windows = body.get("track_windows") or []
    direct_marks = [float(sec) for sec in (body.get("direct_marks") or [])]
    if not track_ids and not track_windows and not direct_marks:
        raise HTTPException(status_code=400, detail="선수를 한 명 이상 지정하세요.")
    if not job.upload_path or not Path(job.upload_path).exists():
        raise HTTPException(status_code=400, detail="원본 영상을 찾을 수 없습니다.")

    detections, fps = _load_player_detection(job)
    clip_paths, segment_metadata = extract_player_clips(
        job.upload_path,
        detections,
        fps,
        track_ids,
        str(job_dir(job_id)),
        pad_before=float(body.get("pad_before", CLIP_PAD_BEFORE)),
        pad_after=float(body.get("pad_after", CLIP_PAD_AFTER)),
        exclude_intervals=[tuple(interval) for interval in (body.get("exclude_intervals") or [])],
        track_windows=_player_track_windows(body, fps),
        extra_involve_secs=direct_marks,
    )
    clip_files = [Path(path).name for path in clip_paths]
    metadata = dict(job.job_metadata or {})
    metadata.update({
        "clips": clip_files,
        "selected": {name: False for name in clip_files},
        "clip_timestamps": {
            item["clip"]: {"start": item["start"], "end": item["end"]}
            for item in segment_metadata
            if item.get("clip")
        },
        "player_segments": segment_metadata,
        "extracted_track_ids": track_ids or sorted({int(window[0]) for window in track_windows}),
    })
    update_job(db, job_id, clips_dir=str(clips_dir(job_id)), job_metadata=metadata)
    return {
        "job_id": job_id,
        "clip_count": len(clip_files),
        "clips": clip_files,
        "segments": segment_metadata,
    }


def _serve_file_with_range(path: Path, request: Request, media_type: str, headers: dict[str, str] | None = None):
    file_size = path.stat().st_size
    base_headers = {"Accept-Ranges": "bytes", **(headers or {})}
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(str(path), media_type=media_type, headers=base_headers)

    try:
        unit, _, byte_range = range_header.partition("=")
        if unit.strip().lower() != "bytes":
            raise ValueError("unsupported range unit")
        start_raw, _, end_raw = byte_range.partition("-")
        start = int(start_raw) if start_raw.strip() else 0
        end = int(end_raw) if end_raw.strip() else file_size - 1
    except Exception:
        return FileResponse(str(path), media_type=media_type, headers=base_headers)

    start = max(0, start)
    end = min(end, file_size - 1)
    if start > end:
        start = 0
        end = file_size - 1
    length = end - start + 1

    def iter_file():
        with path.open("rb") as file_obj:
            file_obj.seek(start)
            remaining = length
            while remaining > 0:
                chunk = file_obj.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    range_headers = {
        **base_headers,
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(length),
    }
    return StreamingResponse(iter_file(), status_code=206, headers=range_headers, media_type=media_type)


@app.get("/api/highlight/jobs")
def list_highlight_jobs(
    limit: int = Query(20, ge=1, le=100),
    mode: str | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    query = db.query(HighlightJob)
    if mode:
        query = query.filter(HighlightJob.mode == mode)
    rows = query.order_by(desc(HighlightJob.created_at)).limit(limit).all()
    return [serialize_job(row) for row in rows]


@app.get("/api/highlight/jobs/{job_id}")
def get_highlight_job(
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return serialize_job(job)


@app.get("/api/highlight/jobs/{job_id}/clips/{clip_name}")
def serve_highlight_clip(
    job_id: str,
    clip_name: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    if not db.get(HighlightJob, job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    try:
        clip_path = safe_clip_path(job_id, clip_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not clip_path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")
    return _serve_file_with_range(clip_path, request, "video/mp4")


@app.delete("/api/highlight/jobs/{job_id}/clips/{clip_name}")
def delete_highlight_clip(
    job_id: str,
    clip_name: str,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    try:
        clip_path = safe_clip_path(job_id, clip_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    clip_path.unlink(missing_ok=True)
    metadata = dict(job.job_metadata or {})
    metadata["clips"] = [name for name in (metadata.get("clips") or []) if name != clip_name]
    if isinstance(metadata.get("selected"), dict):
        metadata["selected"] = {
            name: value for name, value in metadata["selected"].items()
            if name != clip_name
        }
    if isinstance(metadata.get("clip_timestamps"), dict):
        metadata["clip_timestamps"].pop(clip_name, None)
    update_job(db, job_id, job_metadata=metadata)
    return {"ok": True}


@app.post("/api/highlight/jobs/{job_id}/export")
def export_highlight_job(
    job_id: str,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "done":
        raise HTTPException(status_code=409, detail="Job is not completed yet")

    selected = body.get("selected", [])
    order = body.get("order", selected)
    if not isinstance(selected, list) or not selected:
        raise HTTPException(status_code=400, detail="No clips selected")
    if not isinstance(order, list):
        raise HTTPException(status_code=400, detail="Invalid clip order")

    selected_set = {str(name) for name in selected}
    clip_paths: list[str] = []
    for raw_name in order:
        name = str(raw_name)
        if name not in selected_set:
            continue
        try:
            path = safe_clip_path(job_id, name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if path.exists():
            clip_paths.append(str(path))

    if not clip_paths:
        raise HTTPException(status_code=400, detail="None of the selected clips exist")

    export_path = exports_dir() / f"{job_id}_export.mp4"
    clips: list = []
    merged = None
    try:
        from moviepy import VideoFileClip, concatenate_videoclips

        clips = [VideoFileClip(path) for path in clip_paths]
        merged = concatenate_videoclips(clips)
        merged.write_videofile(
            str(export_path),
            codec="libx264",
            audio_codec="aac",
            temp_audiofile=f"temp-audio-export-{job_id}.m4a",
            remove_temp=True,
            logger=None,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Export failed: {exc}") from exc
    finally:
        if merged is not None:
            merged.close()
        for clip in clips:
            clip.close()

    update_job(db, job_id, export_path=str(export_path))
    return {"ok": True, "export_ready": True}


@app.get("/api/highlight/jobs/{job_id}/export/download")
def download_highlight_export(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_session_user),
):
    job = _require_highlight_job_export_access(db, job_id, user)
    export_path = Path(job.export_path)
    if not export_path.exists():
        raise HTTPException(status_code=404, detail="Export file missing")
    filename = f"highlight_{job_id[:8]}.mp4"
    return _serve_file_with_range(
        export_path,
        request,
        "video/mp4",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.delete("/api/highlight/jobs/{job_id}")
def delete_highlight_job(
    job_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(_require_superuser),
):
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    delete_job_files(job)
    db.delete(job)
    db.commit()
    return {"ok": True}
