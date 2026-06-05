import asyncio
import csv
from datetime import datetime
import hashlib
import hmac
import io
import math
import re
import uuid
from pathlib import Path
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
from .fpa_schemas import FcmAnalyzeWorkbookResponse, FpaExportLogsRequest, FpaGenerateLogRequest, FpaGenerateLogResponse, FpaImportLogsResponse, FpaPlayersResponse, FpaVisualizeResponse
from .models import Match, State, PossessionSegment, LaneSegment, Event, DominanceBin, MatchMarker, Outbox, User, WebhookSubscription, AuditLog, FcmSubmission, CompetitionClass, FcmTemplate, HighlightJob
from .schemas import (
    ArchiveMatchRequest,
    AcquireLockRequest,
    AttachIngestRequest,
    AttackLaneEventRequest,
    AttachSrtRequest,
    CompetitionClassCreateRequest,
    CompetitionClassResponse,
    CreateMatchRequest,
    IngestProtocol,
    LoginRequest,
    MatchResultResponse,
    MatchResponse,
    MatchMarkerRequest,
    EventsResetRequest,
    FcmTemplateResponse,
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
MEDIA_CONTROL_URL = os.getenv("MEDIA_CONTROL_URL", "").strip()
MEDIA_CONTROL_TOKEN = os.getenv("MEDIA_CONTROL_TOKEN", "").strip()
MEDIA_INSTANCE_ID = os.getenv("MEDIA_INSTANCE_ID", "").strip()
MEDIA_INSTANCE_NAME = os.getenv("MEDIA_INSTANCE_NAME", "live-admin-media").strip() or "live-admin-media"
FCM_RUNTIME_DIR = Path(os.getenv("FCM_RUNTIME_DIR", "/app/runtime/fcm")).resolve()
FCM_TEMPLATE_RUNTIME_DIR = FCM_RUNTIME_DIR / "templates"

HIGHLIGHT_RUNTIME_DIR = Path(os.getenv("HIGHLIGHT_RUNTIME_DIR", "/app/runtime/highlight")).resolve()
YOLO_MODEL_PATH = os.getenv("YOLO_MODEL_PATH", "/app/models/best-8.pt")
XGB_MODEL_PATH = os.getenv("XGB_MODEL_PATH", "/app/models/highlight_model.xgb")
HIGHLIGHT_BGM_DIR = Path(os.getenv("HIGHLIGHT_BGM_DIR", str(HIGHLIGHT_RUNTIME_DIR / "bgm")))
HIGHLIGHT_BGM_DIR.mkdir(parents=True, exist_ok=True)
_BGM_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"}

_yolo_model: object | None = None
_xgb_model: object | None = None


def _load_highlight_models() -> None:
    global _yolo_model, _xgb_model
    if not Path(YOLO_MODEL_PATH).exists():
        return
    try:
        from .highlight_pipeline import load_models
        _yolo_model, _xgb_model = load_models(YOLO_MODEL_PATH, XGB_MODEL_PATH)
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Highlight models failed to load: %s", exc)


DOM_POSSESSION_WEIGHT = float(os.getenv("DOM_POSSESSION_WEIGHT", "0.35"))
DOM_XG_WEIGHT = float(os.getenv("DOM_XG_WEIGHT", "0.65"))
DOM_ATTACK_WEIGHT = float(os.getenv("DOM_ATTACK_WEIGHT", "0.25"))
DOM_XG_SCALE = float(os.getenv("DOM_XG_SCALE", "1.8"))
DOM_GOAL_XG_MULTIPLIER = float(os.getenv("DOM_GOAL_XG_MULTIPLIER", "2.5"))


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
    statements: list[str] = []

    if "role" not in user_columns:
        statements.append("ALTER TABLE users ADD COLUMN role VARCHAR NOT NULL DEFAULT 'OPERATOR'")
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

    if "highlight_jobs" in table_names:
        hl_columns = {col["name"] for col in inspector.get_columns("highlight_jobs")}
        if "display_name" not in hl_columns:
            statements.append("ALTER TABLE highlight_jobs ADD COLUMN display_name VARCHAR NULL")

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
        with httpx.Client(timeout=5.0) as client:
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
        with httpx.Client(timeout=4.0, follow_redirects=True) as client:
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
    HIGHLIGHT_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    (HIGHLIGHT_RUNTIME_DIR / "uploads").mkdir(exist_ok=True)
    (HIGHLIGHT_RUNTIME_DIR / "jobs").mkdir(exist_ok=True)
    (HIGHLIGHT_RUNTIME_DIR / "exports").mkdir(exist_ok=True)
    db = SessionLocal()
    try:
        _seed_competition_classes(db)
        _seed_existing_fcm_templates(db)
    finally:
        db.close()
    import asyncio as _asyncio
    _asyncio.get_event_loop().run_in_executor(None, _load_highlight_models)
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


def _serialize_match(row: Match) -> dict:
    default_first_half, default_second_half = _default_half_minutes_for_class(row.competition_class)
    return {
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


def _serialize_fcm_template(row: FcmTemplate) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "match_regex": row.match_regex,
        "image_url": f"/api/fcm/templates/{row.id}/image",
        "priority": int(row.priority or 100),
        "active": bool(row.active),
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _find_registered_template_path(db: Session, team_name: str) -> Path | None:
    rows = (
        db.query(FcmTemplate)
        .filter(FcmTemplate.active == True)  # noqa: E712
        .order_by(FcmTemplate.priority.asc(), FcmTemplate.created_at.asc())
        .all()
    )
    for row in rows:
        try:
            if re.search(row.match_regex, team_name or "", flags=re.IGNORECASE):
                path = Path(row.image_path)
                if path.exists():
                    return path
        except re.error:
            continue
    return None


def _build_fcm_card_payload(db: Session, row: FcmSubmission, league: str, round_number: int) -> tuple[str, bytes]:
    template_path = _find_registered_template_path(db, row.team_name or "") or find_template_path(row.team_name or "")
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
        team_rows = [r for r in lane_rows if r.team == team]
        left = sum(1 for r in team_rows if r.lane == "LEFT")
        center = sum(1 for r in team_rows if r.lane == "CENTER")
        right = sum(1 for r in team_rows if r.lane == "RIGHT")
        total = left + center + right
        current_lane = team_rows[-1].lane if team_rows else None
        return {
            "match_name": match_obj.name,
            "match_id": str(match_obj.id),
            "aggregate_clock_ms": aggregate_clock_ms,
            "aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
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

    return {
        "match_name": match_obj.name,
        "match_id": str(match_obj.id),
        "aggregate_clock_ms": aggregate_clock_ms,
        "aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
        "possession": {
            "match_name": match_obj.name,
            "match_id": str(match_obj.id),
            "aggregate_clock_ms": aggregate_clock_ms,
            "aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
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
                "aggregate_clock_ms": aggregate_clock_ms,
                "aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
                "event_clock_ms": r.clock_ms,
                "event_clock": _fmt_clock_ms(r.clock_ms),
                "team": r.team,
                "xg": r.xg,
                "xgot": r.xgot,
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
            "aggregate_clock_ms": aggregate_clock_ms,
            "aggregate_clock": _fmt_clock_ms(aggregate_clock_ms),
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


def _fmt_clock_ms(ms: int) -> str:
    s = max(0, ms // 1000)
    hh = s // 3600
    mm = (s % 3600) // 60
    ss = s % 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


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
    match_regex: str = Form(...),
    priority: int = Form(default=100),
    active: bool = Form(default=True),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _user: User = Depends(_require_session_user),
):
    clean_name = name.strip()
    clean_regex = match_regex.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Template name is required")
    try:
        re.compile(clean_regex)
    except re.error as ex:
        raise HTTPException(status_code=400, detail=f"Invalid regex: {ex}") from ex

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
        match_regex=clean_regex,
        image_path=str(image_path),
        priority=max(1, priority),
        active=active,
    )
    db.add(row)
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


@app.post("/api/matches", response_model=MatchResponse)
def create_match(body: CreateMatchRequest, db: Session = Depends(get_db), user: User | None = Depends(_get_session_user)):
    normalized_class = _normalize_competition_class(body.competition_class)
    competition = db.get(CompetitionClass, normalized_class)
    if not competition:
        raise HTTPException(status_code=400, detail="Unknown competition class")
    name_match = MATCH_NAME_PATTERN.match(body.name.strip())
    if not name_match:
        raise HTTPException(status_code=400, detail="Match name must follow '[CLASS | 1R] HOME vs AWAY' format")
    if name_match.group("class") != normalized_class:
        raise HTTPException(status_code=400, detail="Competition class does not match match name format")
    if int(name_match.group("round")) != body.round_number:
        raise HTTPException(status_code=400, detail="Round number does not match match name format")

    home_team = name_match.group("home").strip()
    away_team = name_match.group("away").strip()
    metadata = dict(body.metadata or {})
    metadata["stream_mode"] = body.stream_mode
    metadata["home_team"] = home_team
    metadata["away_team"] = away_team
    metadata["first_half_minutes"] = competition.first_half_minutes
    metadata["second_half_minutes"] = competition.second_half_minutes
    row = Match(
        id=uuid.uuid4(),
        name=body.name,
        competition_class=normalized_class,
        round_number=body.round_number,
        first_half_minutes=competition.first_half_minutes,
        second_half_minutes=competition.second_half_minutes,
        hls_url=body.hls_url,
        metadata_json=metadata,
        operator_id=user.id if user and body.assign_operator else None,
    )

    ingest_url, ingest_protocol = _resolve_ingest_fields(body.ingest_url, body.srt_url, body.ingest_protocol)
    if ingest_protocol:
        metadata["ingest_protocol"] = ingest_protocol
    if ingest_url:
        metadata["ingest_url"] = ingest_url

    if body.stream_mode == "STREAM" and (ingest_url or ingest_protocol == "RTMP"):
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
def list_matches(db: Session = Depends(get_db)):
    rows = db.query(Match).order_by(desc(Match.created_at)).all()
    return [_serialize_match(r) for r in rows]


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
        "health": {
            "gateway_ok": bool(gateway_status.get("ok")),
            "running_streams": len(gateway_status.get("running_match_ids") or []),
            "active_matches": len(active_matches),
            "live_matches": len(live_matches),
            "streaming_matches": len(streaming_matches),
            "manual_matches": len(manual_matches),
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
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    return _serialize_match(row)


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

    payload = {
        "kind": "EVENT",
        "event_id": str(body.event_id),
        "idempotency_key": str(body.event_id),
        "match_id": str(match_id),
        "type": "ATTACK_LANE",
        "clock_ms": clock_ms,
        "team": body.team,
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

    payload = {
        "kind": "EVENT",
        "event_id": str(body.event_id),
        "idempotency_key": str(body.event_id),
        "match_id": str(match_id),
        "type": "XG",
        "clock_ms": clock_ms,
        "team": body.team,
        "xg": body.xg,
        "xgot": xgot_meta["xgot"],
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
    return _build_match_summary(match_id, db)


@app.get("/api/matches/{match_id}/dominance")
def dominance(
    match_id: UUID,
    bin_seconds: int = Query(default=180),
    split_halves: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    return _build_dominance(match_id, bin_seconds, db, split_halves=split_halves)


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
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    return _serialize_match(row)


@app.get("/api/v1/matches")
def list_matches_v1(_auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    rows = db.query(Match).order_by(desc(Match.created_at)).all()
    return [_serialize_match(r) for r in rows]


@app.get("/api/v1/matches/{match_id}/summary")
def summary_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    return _build_match_summary(match_id, db)


@app.get("/api/v1/matches/{match_id}/dominance")
def dominance_v1(
    match_id: UUID,
    _auth: None = Depends(_require_partner_auth),
    bin_seconds: int = Query(default=180),
    split_halves: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    return _build_dominance(match_id, bin_seconds, db, split_halves=split_halves)


@app.get("/api/v1/matches/{match_id}/events")
def events_v1(
    match_id: UUID,
    _auth: None = Depends(_require_partner_auth),
    since: str | None = Query(default=None, description="ISO datetime, exclusive"),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")

    since_dt = _parse_iso_dt(since)
    q = db.query(Event).filter(Event.match_id == match_id)
    base_seq = 0
    if since_dt:
        base_seq = db.query(Event).filter(Event.match_id == match_id, Event.created_at <= since_dt).count()
        q = q.filter(Event.created_at > since_dt)

    rows = q.order_by(Event.created_at.asc(), Event.id.asc()).limit(limit).all()
    items = []
    for idx, e in enumerate(rows, start=1):
        items.append(
            {
                "sequence": base_seq + idx,
                "event_id": str(e.id),
                "match_id": str(match_id),
                "type": e.type,
                "clock_ms": e.clock_ms,
                "team": e.team,
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
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")

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
    for seg in rows:
        end_ms = seg.end_ms if seg.end_ms is not None else current_clock
        duration_ms = max(0, end_ms - seg.start_ms)
        if seg.team == "HOME":
            home_ms += duration_ms
        elif seg.team == "AWAY":
            away_ms += duration_ms
        total = home_ms + away_ms
        timeline.append(
            {
                "timeline": _fmt_clock_ms(end_ms),
                "team": seg.team,
                "start_ms": seg.start_ms,
                "end_ms": end_ms,
                "duration_ms": duration_ms,
                "home_pct": (home_ms / total * 100.0) if total else 0.0,
                "away_pct": (away_ms / total * 100.0) if total else 0.0,
            }
        )

    return {"match_id": str(match_id), "timeline": timeline}


@app.get("/api/v1/matches/{match_id}/result")
def partner_match_result_v1(match_id: UUID, _auth: None = Depends(_require_partner_auth), db: Session = Depends(get_db)):
    return _build_partner_match_result(match_id, db)


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


# ── Highlight endpoints ────────────────────────────────────────────────────

import json as _json
import shutil as _shutil
import threading as _threading
import time
import numpy as _np


class _NpEncoder(_json.JSONEncoder):
    def default(self, o: object) -> object:
        if isinstance(o, _np.integer):
            return int(o)
        if isinstance(o, _np.floating):
            return float(o)
        if isinstance(o, _np.ndarray):
            return o.tolist()
        return super().default(o)


def _hl_job_dir(job_id: str) -> Path:
    return HIGHLIGHT_RUNTIME_DIR / "jobs" / job_id


def _hl_clips_dir(job_id: str) -> Path:
    return _hl_job_dir(job_id) / "clips"


def _hl_update_job(db: Session, job_id: str, **kwargs: object) -> HighlightJob | None:
    job = db.get(HighlightJob, job_id)
    if not job:
        return None
    for k, v in kwargs.items():
        setattr(job, k, v)
    job.updated_at = datetime.utcnow()
    db.commit()
    return job


def _serialize_hl_job(job: HighlightJob) -> dict:
    meta = job.job_metadata if isinstance(job.job_metadata, dict) else {}
    return {
        "id": job.id,
        "status": job.status,
        "mode": job.mode,
        "original_filename": job.original_filename,
        "display_name": job.display_name or None,
        "export_path": job.export_path or None,
        "error_message": job.error_message,
        "job_metadata": job.job_metadata or {},
        "progress": meta.get("progress"),
        "stage": meta.get("stage"),
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat(),
    }


def _run_ai_analysis(job_id: str, video_path: str, highlight_count: int) -> None:
    db = SessionLocal()
    try:
        _hl_update_job(db, job_id, status="processing")
        if _yolo_model is None:
            _hl_update_job(db, job_id, status="error", error_message="YOLO 모델이 로드되지 않았습니다.")
            return

        from .highlight_pipeline import (
            run_highlight_pipeline,
            CLIP_DURATION_BEFORE,
            CLIP_DURATION_AFTER,
        )

        def _progress(pct: int, stage: str) -> None:
            _hl_update_job(db, job_id, job_metadata={"progress": int(pct), "stage": stage})

        clips_dir = str(_hl_clips_dir(job_id))
        result = run_highlight_pipeline(
            video_path=video_path,
            output_dir=clips_dir,
            yolo_model=_yolo_model,
            xgb_model=_xgb_model,
            highlight_count=highlight_count,
            progress_cb=_progress,
        )

        if not result.success:
            _hl_update_job(db, job_id, status="error", error_message=result.message)
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
            "clips": clip_files,
            "selected": {},
            "clip_scores": clip_scores_by_name,
            "clip_features": clip_features_by_name,
            "clip_feature_stats": clip_feature_stats_by_name,
            "clip_timestamps": clip_timestamps,
            "message": result.message,
        }
        safe_meta = _json.loads(_json.dumps(metadata, cls=_NpEncoder))
        # delete original video after successful analysis
        try:
            Path(video_path).unlink(missing_ok=True)
        except Exception:
            pass
        _hl_update_job(db, job_id, status="done", upload_path=None,
                       clips_dir=clips_dir, job_metadata=safe_meta)
    except Exception as exc:
        _hl_update_job(db, job_id, status="error", error_message=str(exc))
    finally:
        db.close()


def _run_log_analysis(
    job_id: str,
    video_path: str,
    log_data: list[dict],
    second_half_start_sec: float,
    highlight_count: int,
) -> None:
    db = SessionLocal()
    try:
        _hl_update_job(db, job_id, status="processing")
        if _yolo_model is None:
            _hl_update_job(db, job_id, status="error", error_message="YOLO 모델이 로드되지 않았습니다.")
            return

        from .highlight_pipeline import (
            run_log_pipeline,
            CLIP_DURATION_BEFORE,
            CLIP_DURATION_AFTER,
            LOG_CLIP_BEFORE,
            LOG_CLIP_AFTER,
        )

        def _progress(pct: int, stage: str) -> None:
            _hl_update_job(db, job_id, job_metadata={"progress": int(pct), "stage": stage})

        clips_dir = str(_hl_clips_dir(job_id))
        result = run_log_pipeline(
            video_path=video_path,
            log_data=log_data,
            second_half_start_sec=second_half_start_sec,
            output_dir=clips_dir,
            target_count=highlight_count,
            yolo_model=_yolo_model,
            xgb_model=_xgb_model,
            progress_cb=_progress,
        )

        if not result.success:
            _hl_update_job(db, job_id, status="error", error_message=result.message)
            return

        fps_val = float(result.fps or 30.0)
        clip_files = [Path(p).name for p in (result.clip_paths or [])]
        clip_timestamps: dict[str, dict] = {}

        for meta in (result.events or []):
            if meta.get("source") == "log":
                name = meta["clip"]
                video_sec = float(meta.get("video_sec", 0))
                clip_timestamps[name] = {
                    "start": round(max(0.0, video_sec - LOG_CLIP_BEFORE), 1),
                    "end": round(video_sec + LOG_CLIP_AFTER, 1),
                }

        log_clip_names = set(clip_timestamps.keys())
        ai_names = [n for n in clip_files if n not in log_clip_names]
        ai_frames = result.highlight_frames or []
        for i, name in enumerate(ai_names):
            frame = ai_frames[i] if i < len(ai_frames) else None
            if frame is not None:
                anchor_sec = frame / fps_val
                clip_timestamps[name] = {
                    "start": round(max(0.0, anchor_sec - CLIP_DURATION_BEFORE), 1),
                    "end": round(anchor_sec + CLIP_DURATION_AFTER, 1),
                }

        metadata = {
            "clips": clip_files,
            "selected": {},
            "clip_scores": result.clip_scores,
            "clip_features": result.clip_features,
            "clip_feature_stats": result.clip_feature_stats,
            "clip_timestamps": clip_timestamps,
            "events": result.events,
            "message": result.message,
        }
        safe_meta = _json.loads(_json.dumps(metadata, cls=_NpEncoder))
        try:
            Path(video_path).unlink(missing_ok=True)
        except Exception:
            pass
        _hl_update_job(db, job_id, status="done", upload_path=None,
                       clips_dir=clips_dir, job_metadata=safe_meta)
    except Exception as exc:
        _hl_update_job(db, job_id, status="error", error_message=str(exc))
    finally:
        db.close()


# ── 개인(선수) 클립 ──────────────────────────────────────────────────────────
# 영상 업로드 → 선수·공 탐지·추적(track_id) → UI 에서 선수 지정 → 그 선수가 공에
# 관여한 구간만 컷. AI/로그 잡과 달리 추출(extract)이 선수 지정 이후에 일어나므로
# 원본 영상을 보존한다(upload_path 유지). mode="player" 로 HighlightJob 재사용.

def _probe_dimensions(path: Path) -> tuple[int, int]:
    """영상 (width, height) px. 실패 시 (0, 0)."""
    import subprocess
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", str(path)],
            check=True, capture_output=True, text=True,
        )
        w, h = r.stdout.strip().split("x")
        return int(w), int(h)
    except Exception:
        return 0, 0


def _make_playback_proxy(src: Path, out: Path, target_h: int = 720) -> bool:
    """리뷰 재생 전용 저화질 프록시(720p·무음). 탐지·클립은 원본으로 — 프록시는 고배속
    재생용 '보여주기'뿐. 박스 좌표는 원본 px 기준이라 프론트가 원본 W/H 로 스케일."""
    import subprocess
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-vf", f"scale=-2:{target_h}",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
             "-an", "-movflags", "+faststart", str(out)],
            check=True, capture_output=True,
        )
        return out.exists()
    except Exception:
        return False


def _run_player_proxy_job(job_id: str) -> None:
    """기존 player job 원본으로 재생 프록시만 생성(재탐지 X). metadata 에 proxy_file 기록."""
    db = SessionLocal()
    try:
        job = db.get(HighlightJob, job_id)
        if not job or not job.upload_path:
            return
        src = Path(job.upload_path)
        if not src.exists():
            _hl_update_job(db, job_id, job_metadata={**(job.job_metadata or {}), "proxy_status": "error"})
            return
        vw, vh = _probe_dimensions(src)
        ok = _make_playback_proxy(src, _hl_job_dir(job_id) / "proxy.mp4")
        job = db.get(HighlightJob, job_id)  # 그새 바뀌었을 수 있어 재로드
        meta = dict(job.job_metadata or {})
        meta.update({
            "video_w": vw or meta.get("video_w", 0),
            "video_h": vh or meta.get("video_h", 0),
            "proxy_file": "proxy.mp4" if ok else None,
            "proxy_status": "done" if ok else "error",
        })
        _hl_update_job(db, job_id, job_metadata=meta)
    finally:
        db.close()


def _run_player_detect_job(job_id: str, video_path: str) -> None:
    """선수·공 탐지·추적 → detections CSV 저장 + 공 보유 이벤트 계산 (컷은 이후 extract)."""
    db = SessionLocal()
    try:
        _hl_update_job(db, job_id, status="processing")
        if _yolo_model is None:
            _hl_update_job(db, job_id, status="error", error_message="YOLO 모델이 로드되지 않았습니다.")
            return

        import pandas as pd
        from .player_clip_extract import run_player_detection, compute_possession_events

        def _progress(pct: int, stage: str) -> None:
            _hl_update_job(db, job_id, job_metadata={"progress": int(pct), "stage": stage})

        job_dir = _hl_job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        result = run_player_detection(video_path, str(job_dir), _yolo_model, progress_cb=_progress)
        if not result.success:
            _hl_update_job(db, job_id, status="error", error_message=result.message)
            return

        det_df = pd.read_csv(job_dir / result.detection_file)
        events = compute_possession_events(det_df, result.fps)

        # canvas 박스 스케일용 원본 W/H + 고해상도면 고배속 재생용 프록시(720p) 생성
        vw, vh = _probe_dimensions(Path(video_path))
        proxy_file = None
        if vh > 720:
            _progress(98, "재생 프록시 생성")
            if _make_playback_proxy(Path(video_path), job_dir / "proxy.mp4"):
                proxy_file = "proxy.mp4"

        metadata = {
            "mode": "player",
            "fps": result.fps,
            "detection_file": result.detection_file,
            "video_file": Path(video_path).name,
            "n_frames": result.n_frames,
            "n_player_tracks": result.n_player_tracks,
            "video_w": vw,
            "video_h": vh,
            "proxy_file": proxy_file,
            "events": events,
            "clips": [],
            "selected": {},
            "message": result.message,
        }
        safe_meta = _json.loads(_json.dumps(metadata, cls=_NpEncoder))
        _hl_update_job(db, job_id, status="done", clips_dir=str(_hl_clips_dir(job_id)),
                       job_metadata=safe_meta)
    except Exception as exc:
        _hl_update_job(db, job_id, status="error", error_message=str(exc))
    finally:
        db.close()


def _player_track_windows(body: dict, fps: float) -> list | None:
    """body 의 [track_id, from_sec, to_sec] 목록 → (tid, from_frame, to_frame). 없으면 None."""
    tw = body.get("track_windows") or []
    return [(int(t), float(a) * fps, float(b) * fps) for t, a, b in tw] or None


def _load_player_det(job: HighlightJob):
    """개인클립 job 의 (detections df, fps) 로드. 탐지 전이면 400."""
    import pandas as pd
    meta = job.job_metadata or {}
    det_path = _hl_job_dir(job.id) / meta.get("detection_file", "player_detections.csv")
    if not det_path.exists():
        raise HTTPException(status_code=400, detail="탐지 결과가 없습니다. 먼저 탐지를 완료하세요.")
    return pd.read_csv(det_path), float(meta.get("fps") or 30.0)


def _require_player_job(db: Session, job_id: str) -> HighlightJob:
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.mode != "player":
        raise HTTPException(status_code=400, detail="개인 클립 잡이 아닙니다.")
    return job


@app.post("/api/highlight/player-jobs")
async def create_player_job(
    background_tasks: BackgroundTasks,
    video: UploadFile = File(...),
    display_name: str = Form(""),
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    """개인 클립: 영상 업로드 → 선수·공 탐지·추적(백그라운드). 이후 선수 지정 → /extract."""
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    job_id = str(uuid.uuid4())
    upload_dir = HIGHLIGHT_RUNTIME_DIR / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
    upload_path = upload_dir / f"{job_id}{suffix}"

    content = await video.read()
    upload_path.write_bytes(content)

    job = HighlightJob(
        id=job_id,
        status="queued",
        mode="player",
        original_filename=video.filename or "video.mp4",
        display_name=display_name.strip() or None,
        upload_path=str(upload_path),
    )
    db.add(job)
    db.commit()

    _threading.Thread(
        target=_run_player_detect_job,
        args=(job_id, str(upload_path)),
        daemon=True,
    ).start()
    return {"job_id": job_id, "status": "queued"}


def _serve_video_with_range(path: Path, request: Request, media_type: str):
    """HTTP Range 지원 영상 서빙. <video> 의 시킹(드래그 이동)에 필수.
    Range 없으면 200+Accept-Ranges, 있으면 206+해당 바이트 구간 스트리밍."""
    file_size = path.stat().st_size
    range_header = request.headers.get("range") or request.headers.get("Range")
    if not range_header:
        return FileResponse(str(path), media_type=media_type,
                            headers={"Accept-Ranges": "bytes"})
    try:
        unit, _, rng = range_header.partition("=")
        if unit.strip().lower() != "bytes":
            raise ValueError
        start_s, _, end_s = rng.partition("-")
        start = int(start_s) if start_s.strip() else 0
        end = int(end_s) if end_s.strip() else file_size - 1
    except Exception:
        return FileResponse(str(path), media_type=media_type,
                            headers={"Accept-Ranges": "bytes"})
    start = max(0, start)
    end = min(end, file_size - 1)
    if start > end:
        start, end = 0, file_size - 1
    length = end - start + 1

    def _iter():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    }
    return StreamingResponse(_iter(), status_code=206, headers=headers, media_type=media_type)


@app.get("/api/highlight/player-jobs/{job_id}/video")
def serve_player_video(
    job_id: str,
    request: Request,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    """리뷰 재생용 영상 서빙(Range 지원). 프록시(proxy.mp4)가 있으면 저화질 프록시를 우선."""
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    meta = job.job_metadata or {}
    proxy = _hl_job_dir(job_id) / "proxy.mp4"
    if meta.get("proxy_file") and proxy.exists():
        return _serve_video_with_range(proxy, request, "video/mp4")
    path = Path(job.upload_path) if job.upload_path else None
    if not path or not path.exists():
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")
    suffix = path.suffix.lower()
    media = "video/mp4" if suffix in (".mp4", ".m4v", ".mov") else f"video/{suffix.lstrip('.')}"
    return _serve_video_with_range(path, request, media)


@app.post("/api/highlight/player-jobs/{job_id}/proxy")
def make_player_proxy(
    job_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    """기존 job 에 재생 프록시를 즉석 생성(재탐지 X, ffmpeg 만). 백그라운드 → 폴링."""
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    meta = job.job_metadata or {}
    if meta.get("proxy_file"):
        return {"status": "done", "proxy_file": meta["proxy_file"]}
    if meta.get("proxy_status") == "running":
        return {"status": "running"}
    _hl_update_job(db, job_id, job_metadata={**meta, "proxy_status": "running"})
    background_tasks.add_task(_run_player_proxy_job, job_id)
    return {"status": "running"}


@app.get("/api/highlight/player-jobs/{job_id}/detections")
def serve_player_detections(
    job_id: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    """프레임별 탐지 박스(player/ball) JSON. canvas 오버레이 렌더용.
    반환: {fps, stride, video_w, video_h, frames: {frame: [{cls,tid,cx,cy,w,h}]}}."""
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    det_df, fps = _load_player_det(job)
    meta = job.job_metadata or {}
    frames: dict[int, list[dict]] = {}
    for r in det_df.itertuples(index=False):
        frames.setdefault(int(r.frame), []).append({
            "cls": r.class_name, "tid": int(r.track_id),
            "cx": float(r.cx), "cy": float(r.cy), "w": float(r.w), "h": float(r.h),
        })
    fs = sorted(frames.keys())
    stride = (fs[1] - fs[0]) if len(fs) > 1 else 7
    return {
        "job_id": job_id, "fps": fps, "stride": int(stride),
        "video_w": int(meta.get("video_w") or 0), "video_h": int(meta.get("video_h") or 0),
        "frames": frames,
    }


@app.get("/api/highlight/player-jobs/{job_id}/events")
def list_player_possession_events(
    job_id: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    """영상 전체의 공 보유 이벤트(클립 후보) 열거 — 이벤트 리뷰용."""
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    meta = job.job_metadata or {}
    events = meta.get("events") or []
    return {"job_id": job_id, "fps": float(meta.get("fps") or 30.0),
            "event_count": len(events), "events": events}


@app.post("/api/highlight/player-jobs/{job_id}/preview")
def preview_player_job_clips(
    job_id: str,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    """컷 없이 예상 클립 수·구간만 계산(미리보기). ffmpeg 미실행이라 빠름."""
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    from .player_clip_extract import compute_player_segments, CLIP_PAD_BEFORE, CLIP_PAD_AFTER

    track_ids = [int(t) for t in (body.get("track_ids") or [])]
    track_windows = body.get("track_windows") or []
    direct_marks = [float(s) for s in (body.get("direct_marks") or [])]
    if not track_ids and not track_windows and not direct_marks:
        return {"job_id": job_id, "clip_count": 0, "segments": []}

    det_df, fps = _load_player_det(job)
    segments = compute_player_segments(
        det_df, fps, track_ids,
        pad_before=float(body.get("pad_before", CLIP_PAD_BEFORE)),
        pad_after=float(body.get("pad_after", CLIP_PAD_AFTER)),
        exclude_intervals=[tuple(iv) for iv in (body.get("exclude_intervals") or [])],
        track_windows=_player_track_windows(body, fps),
        extra_involve_secs=direct_marks,
    )
    total = round(sum(s["end"] - s["start"] for s in segments), 1)
    return {"job_id": job_id, "clip_count": len(segments),
            "total_seconds": total, "segments": segments}


@app.post("/api/highlight/player-jobs/{job_id}/extract")
def extract_player_job_clips(
    job_id: str,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    """지정한 선수 track_id 들이 공에 관여한 구간만 클립으로 추출."""
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = _require_player_job(db, job_id)
    from .player_clip_extract import extract_player_clips, CLIP_PAD_BEFORE, CLIP_PAD_AFTER

    track_ids = [int(t) for t in (body.get("track_ids") or [])]
    track_windows = body.get("track_windows") or []
    direct_marks = [float(s) for s in (body.get("direct_marks") or [])]
    if not track_ids and not track_windows and not direct_marks:
        raise HTTPException(status_code=400, detail="선수를 한 명 이상 지정하세요.")
    if not job.upload_path or not Path(job.upload_path).exists():
        raise HTTPException(status_code=400, detail="원본 영상을 찾을 수 없습니다.")

    det_df, fps = _load_player_det(job)
    clip_paths, seg_meta = extract_player_clips(
        job.upload_path, det_df, fps, track_ids, str(_hl_job_dir(job_id)),
        pad_before=float(body.get("pad_before", CLIP_PAD_BEFORE)),
        pad_after=float(body.get("pad_after", CLIP_PAD_AFTER)),
        exclude_intervals=[tuple(iv) for iv in (body.get("exclude_intervals") or [])],
        track_windows=_player_track_windows(body, fps),
        extra_involve_secs=direct_marks,
    )
    clip_files = [Path(p).name for p in clip_paths]
    meta = dict(job.job_metadata or {})
    meta.update({
        "clips": clip_files,
        "selected": {n: False for n in clip_files},
        "clip_timestamps": {m["clip"]: {"start": m["start"], "end": m["end"]} for m in seg_meta},
        "player_segments": seg_meta,
        "extracted_track_ids": track_ids or sorted({int(w[0]) for w in track_windows}),
    })
    safe_meta = _json.loads(_json.dumps(meta, cls=_NpEncoder))
    _hl_update_job(db, job_id, clips_dir=str(_hl_clips_dir(job_id)), job_metadata=safe_meta)
    return {"job_id": job_id, "clip_count": len(clip_files),
            "clips": clip_files, "segments": seg_meta}


@app.post("/api/highlight/jobs")
async def create_highlight_job(
    background_tasks: BackgroundTasks,
    video: UploadFile = File(...),
    mode: str = Form("ai"),
    highlight_count: int = Form(40),
    second_half_start_sec: float = Form(0.0),
    log_data_json: str = Form("[]"),
    display_name: str = Form(""),
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if mode not in ("ai", "log_ai"):
        raise HTTPException(status_code=400, detail="mode must be 'ai' or 'log_ai'")

    job_id = str(uuid.uuid4())
    upload_dir = HIGHLIGHT_RUNTIME_DIR / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
    upload_path = upload_dir / f"{job_id}{suffix}"

    content = await video.read()
    upload_path.write_bytes(content)

    job = HighlightJob(
        id=job_id,
        status="queued",
        mode=mode,
        original_filename=video.filename or "video.mp4",
        display_name=display_name.strip() or None,
        upload_path=str(upload_path),
    )
    db.add(job)
    db.commit()

    if mode == "ai":
        _threading.Thread(
            target=_run_ai_analysis,
            args=(job_id, str(upload_path), highlight_count),
            daemon=True,
        ).start()
    else:
        try:
            log_data = _json.loads(log_data_json)
        except Exception:
            log_data = []
        _threading.Thread(
            target=_run_log_analysis,
            args=(job_id, str(upload_path), log_data, second_half_start_sec, highlight_count),
            daemon=True,
        ).start()

    return {"job_id": job_id, "status": "queued"}


@app.get("/api/highlight/jobs")
def list_highlight_jobs(
    limit: int = Query(20, ge=1, le=100),
    mode: str | None = Query(None),
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    q = db.query(HighlightJob)
    if mode:
        q = q.filter(HighlightJob.mode == mode)
    rows = q.order_by(desc(HighlightJob.created_at)).limit(limit).all()
    return [_serialize_hl_job(r) for r in rows]


@app.get("/api/highlight/jobs/{job_id}")
def get_highlight_job(
    job_id: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _serialize_hl_job(job)


@app.get("/api/highlight/jobs/{job_id}/clips/{clip_name}")
def serve_highlight_clip(
    job_id: str,
    clip_name: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    clip_path = _hl_clips_dir(job_id) / clip_name
    if not clip_path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")
    return FileResponse(str(clip_path), media_type="video/mp4")


def _hl_apply_transitions(clips: list, t: float) -> tuple[list, float]:
    if t <= 0 or len(clips) <= 1:
        return clips, 0.0
    from moviepy import vfx
    min_dur = min(c.duration for c in clips)
    t = min(t, min_dur / 2.5)
    result = []
    for i, clip in enumerate(clips):
        effects = []
        if i > 0:
            effects.append(vfx.CrossFadeIn(t))
        if i < len(clips) - 1:
            effects.append(vfx.CrossFadeOut(t))
        result.append(clip.with_effects(effects) if effects else clip)
    return result, -t


def _hl_mix_bgm(merged_clip, bgm_name: str, bgm_volume: float):
    bgm_path = HIGHLIGHT_BGM_DIR / bgm_name
    if not bgm_path.exists() or bgm_path.suffix.lower() not in _BGM_EXTENSIONS:
        return merged_clip
    from moviepy import AudioFileClip, CompositeAudioClip, concatenate_audioclips, afx
    total_dur = merged_clip.duration
    bgm_raw = AudioFileClip(str(bgm_path))
    if bgm_raw.duration < total_dur:
        loops = int(total_dur / bgm_raw.duration) + 1
        bgm_raw = concatenate_audioclips([bgm_raw] * loops)
    bgm_clip = bgm_raw.subclipped(0, total_dur)
    fade_dur = min(2.0, total_dur * 0.1)
    bgm_clip = bgm_clip.with_effects([afx.AudioFadeOut(fade_dur)])
    bgm_clip = bgm_clip.with_volume_scaled(max(0.0, min(bgm_volume, 2.0)))
    if merged_clip.audio is not None:
        mixed = CompositeAudioClip([merged_clip.audio, bgm_clip])
    else:
        mixed = bgm_clip
    return merged_clip.with_audio(mixed)


@app.get("/api/highlight/bgm")
def list_highlight_bgm(
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    tracks = sorted(
        f.name for f in HIGHLIGHT_BGM_DIR.iterdir()
        if f.is_file() and f.suffix.lower() in _BGM_EXTENSIONS
    )
    return {"tracks": tracks}


@app.post("/api/highlight/jobs/{job_id}/clips/{clip_name}/trim")
def trim_highlight_clip(
    job_id: str,
    clip_name: str,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if "/" in clip_name or "\\" in clip_name:
        raise HTTPException(status_code=400, detail="Invalid clip name")
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    clip_path = _hl_clips_dir(job_id) / clip_name
    if not clip_path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")

    start = max(0.0, float(body.get("start", 0.0)))
    end = float(body.get("end", 0.0))

    from moviepy import VideoFileClip
    video = VideoFileClip(str(clip_path))
    if end <= 0 or end > video.duration:
        end = video.duration
    if start >= end:
        video.close()
        raise HTTPException(status_code=400, detail="start must be less than end")

    try:
        try:
            clip = video.subclipped(start, end)
        except AttributeError:
            clip = video.subclip(start, end)
        clip.write_videofile(
            str(clip_path), codec="libx264", audio_codec="aac",
            temp_audiofile=f"temp-trim-{job_id}.m4a", remove_temp=True, logger=None,
        )
    finally:
        video.close()

    meta = dict(job.job_metadata or {})
    trimmed = dict(meta.get("trimmed", {}))
    trimmed[clip_name] = {"start": round(start, 2), "end": round(end, 2)}
    meta["trimmed"] = trimmed
    _hl_update_job(db, job_id, job_metadata=meta)
    return {"ok": True, "clip_name": clip_name, "start": start, "end": end}


@app.post("/api/highlight/jobs/{job_id}/export")
def export_highlight_job(
    job_id: str,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "done":
        raise HTTPException(status_code=409, detail="Job is not completed yet")

    selected: list[str] = body.get("selected", [])
    order: list[str] = body.get("order", [])
    transition_sec = max(0.0, min(float(body.get("transition_sec", 0.5)), 1.5))
    audio_volume = max(0.0, min(float(body.get("audio_volume", 1.0)), 2.0))
    bgm_name: str = body.get("bgm_name", "")
    bgm_volume = max(0.0, min(float(body.get("bgm_volume", 0.3)), 2.0))

    if not selected:
        raise HTTPException(status_code=400, detail="No clips selected")

    # 순서 미지정 시 clip_timestamps.start 기준 시간순 정렬
    if not order:
        ts = (job.job_metadata or {}).get("clip_timestamps") or {}
        order = sorted(selected, key=lambda n: ts.get(n, {}).get("start", float("inf")))

    clips_dir = _hl_clips_dir(job_id)
    clip_paths = []
    for name in order:
        if name in selected:
            p = clips_dir / name
            if p.exists():
                clip_paths.append(str(p))

    if not clip_paths:
        raise HTTPException(status_code=400, detail="None of the selected clips exist")

    exports_dir = HIGHLIGHT_RUNTIME_DIR / "exports"
    exports_dir.mkdir(exist_ok=True)
    export_path = exports_dir / f"{job_id}_export.mp4"

    clips: list = []
    merged = None
    try:
        from moviepy import VideoFileClip, concatenate_videoclips
        clips = [VideoFileClip(p) for p in clip_paths]
        transition_clips, padding = _hl_apply_transitions(clips, transition_sec)
        merged = concatenate_videoclips(transition_clips, padding=padding, method="compose")
        if audio_volume != 1.0 and merged.audio is not None:
            merged = merged.with_volume_scaled(audio_volume)
        if bgm_name:
            merged = _hl_mix_bgm(merged, bgm_name, bgm_volume)
        merged.write_videofile(str(export_path), codec="libx264", audio_codec="aac",
                               temp_audiofile=f"temp-audio-export-{job_id}.m4a",
                               remove_temp=True, logger=None)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Export failed: {exc}") from exc
    finally:
        if merged is not None:
            merged.close()
        for c in clips:
            c.close()

    _hl_update_job(db, job_id, export_path=str(export_path))
    return {"ok": True, "export_ready": True}


@app.get("/api/highlight/jobs/{job_id}/export/download")
def download_highlight_export(
    job_id: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = db.get(HighlightJob, job_id)
    if not job or not job.export_path:
        raise HTTPException(status_code=404, detail="Export not found")
    export_path = Path(job.export_path)
    if not export_path.exists():
        raise HTTPException(status_code=404, detail="Export file missing")
    filename = f"highlight_{job_id[:8]}.mp4"
    return FileResponse(str(export_path), media_type="video/mp4",
                         headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _hl_image_cards_dir(job_id: str) -> Path:
    d = _hl_job_dir(job_id) / "image_cards"
    d.mkdir(parents=True, exist_ok=True)
    return d


_IMAGE_CARD_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}


@app.post("/api/highlight/jobs/{job_id}/image-cards")
async def upload_highlight_image_card(
    job_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not db.get(HighlightJob, job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    if not file.filename:
        raise HTTPException(status_code=400, detail="파일이 없습니다.")
    safe_name = Path(file.filename).name
    if Path(safe_name).suffix.lower() not in _IMAGE_CARD_EXTS:
        raise HTTPException(status_code=400, detail="이미지 파일만 가능합니다 (jpg/png/gif/bmp/webp).")
    saved = _hl_image_cards_dir(job_id) / safe_name
    import shutil as _shutil2
    with saved.open("wb") as f:
        _shutil2.copyfileobj(file.file, f)
    return {"ok": True, "name": safe_name}


@app.get("/api/highlight/jobs/{job_id}/image-cards")
def list_highlight_image_cards(
    job_id: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not db.get(HighlightJob, job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    d = _hl_image_cards_dir(job_id)
    cards = sorted(f.name for f in d.iterdir() if f.is_file() and f.suffix.lower() in _IMAGE_CARD_EXTS)
    return {"cards": cards}


@app.get("/api/highlight/jobs/{job_id}/image-cards/{filename}")
def serve_highlight_image_card(
    job_id: str,
    filename: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    p = _hl_image_cards_dir(job_id) / filename
    if not p.exists():
        raise HTTPException(status_code=404, detail="Image card not found")
    return FileResponse(str(p))


@app.post("/api/highlight/jobs/{job_id}/export/timeline")
def export_highlight_timeline(
    job_id: str,
    body: dict = Body(...),
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    """타임라인 (영상 클립 + 이미지 카드 혼합 + 오버레이/BGM 트랙) → 최종 영상 합치기.

    - 출력 해상도는 EXPORT_TARGET_SIZE 로 고정하고 클립은 종횡비 유지 레터박스(_hl_fit_clip).
    - timeline 항목별 job_id 로 멀티 job/외부 클립 지원.
    - overlays: 점수판/득점자/이미지 오버레이를 합성 영상 위에 burn-in.
    - bgm_tracks: 편집기에서 배치한 다중 BGM 트랙. 없으면 legacy 단일 bgm_name 사용.
    """
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    timeline: list[dict] = body.get("timeline", [])
    if not timeline:
        raise HTTPException(status_code=400, detail="타임라인이 비어 있습니다.")

    transition_sec = max(0.0, min(float(body.get("transition_sec", 0.5)), 1.5))
    audio_volume = max(0.0, min(float(body.get("audio_volume", 1.0)), 2.0))
    bgm_name: str = body.get("bgm_name", "")
    bgm_volume = max(0.0, min(float(body.get("bgm_volume", 0.3)), 2.0))
    bgm_tracks: list[dict] = body.get("bgm_tracks", []) or []
    overlays: list[dict] = body.get("overlays", []) or []

    from moviepy import VideoFileClip, ImageClip, CompositeVideoClip, concatenate_videoclips

    # 출력 해상도는 EXPORT_TARGET_SIZE 로 고정(해상도 혼합 시 축소-박힘 방지). fps만 첫 클립에서 결정.
    video_size = EXPORT_TARGET_SIZE
    fps = 30.0
    has_clip = False
    for item in timeline:
        if item.get("type") == "clip":
            item_job = item.get("job_id") or job_id
            p = _hl_clips_dir(item_job) / item.get("name", "")
            if p.exists():
                tmp = VideoFileClip(str(p))
                fps = float(tmp.fps or 30.0)
                tmp.close()
                has_clip = True
                break

    if not has_clip:
        raise HTTPException(status_code=400, detail="영상 클립이 최소 1개 필요합니다.")

    final_clips: list = []
    try:
        for item in timeline:
            itype = item.get("type")
            name = item.get("name", "")
            item_job = item.get("job_id") or job_id
            if "/" in name or "\\" in name:
                raise HTTPException(status_code=400, detail=f"잘못된 파일명: {name}")

            if itype == "clip":
                p = _hl_clips_dir(item_job) / name
                if not p.exists():
                    raise HTTPException(status_code=404, detail=f"클립 없음: {name}")
                final_clips.append(_hl_fit_clip(VideoFileClip(str(p)), video_size))

            elif itype == "image":
                p = _hl_image_cards_dir(item_job) / name
                if not p.exists():
                    raise HTTPException(status_code=404, detail=f"이미지 없음: {name}")
                duration = max(0.5, min(float(item.get("duration", 3.0)), 60.0))
                img_clip = ImageClip(str(p), duration=duration)
                try:
                    img_clip = img_clip.resized(video_size)
                except AttributeError:
                    img_clip = img_clip.resize(video_size)
                img_clip = img_clip.with_fps(fps)
                final_clips.append(img_clip)
            else:
                raise HTTPException(status_code=400, detail=f"알 수 없는 타입: {itype}")

        transition_clips, padding = _hl_apply_transitions(final_clips, transition_sec)
        merged = concatenate_videoclips(transition_clips, padding=padding, method="compose")

        if audio_volume != 1.0 and merged.audio is not None:
            merged = merged.with_volume_scaled(audio_volume)
        if bgm_tracks:
            merged = _hl_mix_bgm_tracks(merged, bgm_tracks)
        elif bgm_name:
            merged = _hl_mix_bgm(merged, bgm_name, bgm_volume)

        # 합쳐진 영상 위에 오버레이 트랙 burn-in
        if overlays:
            ov_clips = []
            for ov in overlays:
                if not ov.get("enabled", True):
                    continue
                try:
                    oc = _hl_make_overlay_clip(ov, merged.size, merged.duration, fallback_job_id=job_id, fps=fps)
                    if oc is not None:
                        ov_clips.append(oc)
                except Exception as exc:
                    import logging
                    logging.getLogger(__name__).warning("overlay render failed: %s", exc)
            if ov_clips:
                merged = CompositeVideoClip([merged] + ov_clips)

        exports_dir = HIGHLIGHT_RUNTIME_DIR / "exports"
        exports_dir.mkdir(exist_ok=True)
        export_path = exports_dir / f"{job_id}_timeline.mp4"
        merged.write_videofile(
            str(export_path), codec="libx264", audio_codec="aac",
            temp_audiofile=f"temp-timeline-{job_id}.m4a", remove_temp=True, logger=None,
        )
        merged.close()
    finally:
        for c in final_clips:
            try:
                c.close()
            except Exception:
                pass

    _hl_update_job(db, job_id, export_path=str(export_path))
    return {"ok": True, "export_ready": True}


@app.patch("/api/highlight/jobs/{job_id}/display-name")
def rename_highlight_job(
    job_id: str,
    body: dict,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    name = (body.get("display_name") or "").strip() or None
    job.display_name = name
    db.commit()
    return {"ok": True, "display_name": job.display_name}


@app.delete("/api/highlight/jobs/{job_id}")
def delete_highlight_job(
    job_id: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    job_dir = _hl_job_dir(job_id)
    if job_dir.exists():
        _shutil.rmtree(job_dir, ignore_errors=True)

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

    db.delete(job)
    db.commit()
    return {"ok": True}


@app.delete("/api/highlight/jobs/{job_id}/clips/{clip_name}")
def delete_highlight_clip(
    job_id: str,
    clip_name: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    clip_path = _hl_clips_dir(job_id) / clip_name
    clip_path.unlink(missing_ok=True)
    meta = dict(job.job_metadata or {})
    clips = [c for c in (meta.get("clips") or []) if c != clip_name]
    meta["clips"] = clips
    _hl_update_job(db, job_id, job_metadata=meta)
    return {"ok": True}


@app.delete("/api/highlight/jobs/{job_id}/export")
def delete_highlight_export(
    job_id: str,
    db: Session = Depends(get_db),
    _user: str | None = Depends(lambda live_admin_session=Cookie(default=None): _verify_session_value(live_admin_session)),
):
    if _user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.export_path:
        try:
            Path(job.export_path).unlink(missing_ok=True)
        except Exception:
            pass
        _hl_update_job(db, job_id, export_path=None)
    return {"ok": True}


# ── Highlight editor (overlays / BGM tracks / projects / split / external) ──

EXPORT_TARGET_SIZE = (1920, 1080)

# Camera transport-stream formats (AVCHD etc.) whose fps OpenCV/extract may misread.
# These are often interlaced / variable-framerate, which skews clip timestamps.
_HL_TRANSCODE_EXTS = {".mts", ".m2ts", ".m2t", ".ts", ".mod", ".tod"}
_HL_EXTERNAL_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}

_HL_ASSET_DIR = Path(__file__).resolve().parent / "assets"
HIGHLIGHT_OVERLAY_LOGO = Path(os.getenv("HIGHLIGHT_OVERLAY_LOGO", str(_HL_ASSET_DIR / "overlay_logo.png")))
_HL_OVERLAY_FONT_CANDIDATES = [
    str(_HL_ASSET_DIR / "fonts" / "KFAGothicBold.otf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]

HIGHLIGHT_EDITOR_PROJECTS_PATH = HIGHLIGHT_RUNTIME_DIR / "editor_projects.json"


def _hl_require_user(live_admin_session: str | None = Cookie(default=None)) -> str:
    user = _verify_session_value(live_admin_session)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def _hl_overlay_images_dir(job_id: str) -> Path:
    d = _hl_job_dir(job_id) / "overlay_images"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── ffmpeg utils for split jobs ─────────────────────────────────────────────

def _hl_probe_duration(path: Path) -> float:
    import subprocess
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            check=True, capture_output=True,
        )
        return float(r.stdout.decode("utf-8", "ignore").strip())
    except (subprocess.CalledProcessError, ValueError):
        return 0.0


def _hl_concat_videos(video_paths: list[Path], output_path: Path) -> None:
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        for p in video_paths:
            f.write(f"file '{p}'\n")
        list_file = f.name
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", list_file, "-c", "copy", str(output_path)],
        check=True, capture_output=True,
    )
    Path(list_file).unlink(missing_ok=True)


def _hl_normalize_for_analysis(src: Path) -> Path:
    """Transcode only fps/interlace-problematic inputs (MTS etc.) to a fixed-fps,
    deinterlaced mp4. Standard formats (mp4/mov) are returned unchanged."""
    import subprocess
    if src.suffix.lower() not in _HL_TRANSCODE_EXTS:
        return src
    out = src.with_suffix(".mp4")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src),
             "-vf", "yadif=0", "-r", "30",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
             "-c:a", "aac", "-movflags", "+faststart", str(out)],
            check=True, capture_output=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return src
    src.unlink(missing_ok=True)
    return out


# ── video/audio compositing helpers ─────────────────────────────────────────

def _hl_fit_clip(clip, target_size: tuple[int, int]):
    """Scale clip to target_size keeping aspect ratio, letterboxing with black bars."""
    tw, th = target_size
    cw, ch = clip.size
    if (cw, ch) == (tw, th):
        return clip
    scale = min(tw / cw, th / ch)
    new_w = max(2, round(cw * scale / 2) * 2)  # even (libx264 requirement)
    new_h = max(2, round(ch * scale / 2) * 2)
    try:
        scaled = clip.resized((new_w, new_h))
    except AttributeError:
        scaled = clip.resize((new_w, new_h))
    if (new_w, new_h) == (tw, th):
        return scaled
    from moviepy import ColorClip, CompositeVideoClip
    bg = ColorClip(size=(tw, th), color=(0, 0, 0), duration=clip.duration)
    return CompositeVideoClip([bg, scaled.with_position("center")], size=(tw, th))


def _hl_mix_bgm_tracks(merged_clip, tracks: list[dict]):
    """Mix editor-placed BGM tracks with per-track fade in/out.

    Each track dict: name, start_sec, duration_sec, volume, fade_in_sec, fade_out_sec.
    BGM shorter than the segment is looped, longer is trimmed."""
    from moviepy import AudioFileClip, CompositeAudioClip, concatenate_audioclips, afx

    total_dur = float(merged_clip.duration or 0.0)
    if total_dur <= 0:
        return merged_clip

    pieces: list = []
    if merged_clip.audio is not None:
        pieces.append(merged_clip.audio)

    for t in tracks:
        bgm_path = HIGHLIGHT_BGM_DIR / Path(str(t.get("name", ""))).name
        if not bgm_path.exists() or bgm_path.suffix.lower() not in _BGM_EXTENSIONS:
            continue
        start_s = max(0.0, float(t.get("start_sec", 0.0)))
        if start_s >= total_dur:
            continue
        seg_dur = max(0.5, min(float(t.get("duration_sec", 10.0)), total_dur - start_s))
        if seg_dur <= 0:
            continue

        raw = AudioFileClip(str(bgm_path))
        if raw.duration < seg_dur:
            loops = int(seg_dur / raw.duration) + 1
            raw = concatenate_audioclips([raw] * loops)
        seg = raw.subclipped(0, seg_dur)

        effects = []
        fade_in = max(0.0, min(float(t.get("fade_in_sec", 1.0)), seg_dur / 2.0))
        fade_out = max(0.0, min(float(t.get("fade_out_sec", 1.0)), seg_dur / 2.0))
        if fade_in > 0:
            effects.append(afx.AudioFadeIn(fade_in))
        if fade_out > 0:
            effects.append(afx.AudioFadeOut(fade_out))
        if effects:
            seg = seg.with_effects(effects)
        seg = seg.with_volume_scaled(max(0.0, min(float(t.get("volume", 0.3)), 2.0)))
        seg = seg.with_start(start_s)
        pieces.append(seg)

    if not pieces:
        return merged_clip
    return merged_clip.with_audio(CompositeAudioClip(pieces))


def _hl_snap_overlay_timing(start_sec: float, duration_sec: float, clip_duration: float, fps: float) -> tuple[float, float]:
    """Snap overlay start/duration to frame boundaries so appearance/disappearance
    matches the edited time exactly (avoids ±1 frame jitter that looks like a delay)."""
    fps = fps if fps and fps > 0 else 30.0
    start_s = max(0.0, round(float(start_sec) * fps) / fps)
    raw_dur = min(float(duration_sec), max(0.0, clip_duration - start_s))
    dur_s = max(1.0 / fps, round(raw_dur * fps) / fps)
    return start_s, dur_s


def _hl_make_overlay_clip(
    ov: dict,
    video_size: tuple[int, int],
    clip_duration: float,
    fallback_job_id: str | None = None,
    fps: float = 30.0,
):
    """Build an overlay clip (image-template mode or draw mode)."""
    import numpy as _np2
    from PIL import Image, ImageDraw, ImageFont
    from moviepy import ImageClip

    W, H = video_size

    kind = str(ov.get("kind", ""))
    start_sec = float(ov.get("start_sec", 0.0))
    duration_sec = float(ov.get("duration_sec", 5.0))
    x_pct = float(ov.get("x_pct", 25.0))
    y_pct = float(ov.get("y_pct", 5.0))
    image_path = str(ov.get("image_path", "") or "")

    # ── image-template mode: composite an uploaded template image ──
    if image_path:
        img_job_id = ov.get("image_job_id") or fallback_job_id
        if not img_job_id:
            return None
        img_path = _hl_overlay_images_dir(img_job_id) / Path(image_path).name
        if not img_path.exists():
            return None
        try:
            pil_img = Image.open(img_path).convert("RGBA")
        except Exception:
            return None

        width_pct = float(ov.get("width_pct", 30.0))
        height_pct = float(ov.get("height_pct", 0.0))
        target_w = max(50, int(W * max(5.0, min(width_pct, 100.0)) / 100.0))
        if height_pct > 0:
            target_h = max(20, int(H * min(height_pct, 100.0) / 100.0))
        else:
            ratio = target_w / max(1, pil_img.width)
            target_h = max(20, int(pil_img.height * ratio))
        pil_img = pil_img.resize((target_w, target_h), Image.LANCZOS)

        bx = max(0, min(int((x_pct / 100.0) * W), max(0, W - target_w)))
        by = max(0, min(int((y_pct / 100.0) * H), max(0, H - target_h)))

        arr = _np2.array(pil_img)
        start_s, dur_s = _hl_snap_overlay_timing(start_sec, duration_sec, clip_duration, fps)
        return (ImageClip(arr, duration=dur_s)
                .with_start(start_s).with_fps(fps).with_position((bx, by)))

    # ── draw mode: render box/text directly with Pillow ──
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    def _font(size: int):
        for path in _HL_OVERLAY_FONT_CANDIDATES:
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
        return ImageFont.load_default()

    def _hex_to_rgba(h: str, alpha: int = 127) -> tuple[int, int, int, int]:
        s = (h or "").lstrip("#")
        if len(s) == 6:
            try:
                return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), alpha)
            except ValueError:
                pass
        return (255, 116, 0, alpha)

    def _load_logo():
        if HIGHLIGHT_OVERLAY_LOGO.exists():
            try:
                return Image.open(HIGHLIGHT_OVERLAY_LOGO).convert("RGBA")
            except Exception:
                pass
        return None

    ACCENT = _hex_to_rgba(str(ov.get("bg_color", "#FF7400")), alpha=127)
    WHITE = (255, 255, 255, 255)
    LIGHT_DIM = (255, 255, 255, 215)
    logo_img = _load_logo()

    def _center_y(box_top: int, box_h: int, bbox, glyph_h: int) -> int:
        return box_top + (box_h - glyph_h) // 2 - bbox[1]

    if kind == "scoreboard":
        font_team = _font(max(20, int(H * 0.04)))
        font_score = _font(max(26, int(H * 0.052)))

        home_text = str(ov.get("home", "") or "HOME")
        score_text = f"{int(ov.get('home_score', 0))} - {int(ov.get('away_score', 0))}"
        away_text = str(ov.get("away", "") or "AWAY")

        hb = draw.textbbox((0, 0), home_text, font=font_team)
        sb = draw.textbbox((0, 0), score_text, font=font_score)
        ab = draw.textbbox((0, 0), away_text, font=font_team)
        hw, hh = hb[2] - hb[0], hb[3] - hb[1]
        sw, sh = sb[2] - sb[0], sb[3] - sb[1]
        aw_, ah = ab[2] - ab[0], ab[3] - ab[1]

        pad_x = max(14, int(W * 0.013))
        pad_y = max(8, int(H * 0.014))
        sep = max(10, int(W * 0.01))
        block_h = sh + pad_y * 2

        logo_h = block_h
        logo_w = 0
        logo_resized = None
        if logo_img is not None and logo_img.height > 0:
            ratio = logo_img.width / logo_img.height
            logo_w = int(logo_h * ratio)
            logo_resized = logo_img.resize((logo_w, logo_h), Image.LANCZOS)

        rect_w = pad_x + hw + sep + sw + sep + aw_ + pad_x
        total_w = (logo_w + sep if logo_w else 0) + rect_w

        bx = max(0, min(int((x_pct / 100.0) * W), W - total_w))
        by = max(0, min(int((y_pct / 100.0) * H), H - block_h))

        rect_x = bx
        if logo_resized is not None:
            img.paste(logo_resized, (bx, by + (block_h - logo_h) // 2), logo_resized)
            rect_x = bx + logo_w + sep

        draw.rectangle([rect_x, by, rect_x + rect_w, by + block_h], fill=ACCENT)

        x = rect_x + pad_x
        draw.text((x, _center_y(by, block_h, hb, hh)), home_text, font=font_team, fill=WHITE)
        x += hw + sep
        draw.text((x, _center_y(by, block_h, sb, sh)), score_text, font=font_score, fill=WHITE)
        x += sw + sep
        draw.text((x, _center_y(by, block_h, ab, ah)), away_text, font=font_team, fill=WHITE)

    elif kind == "scorer":
        font_num = _font(max(22, int(H * 0.045)))
        font_label = _font(max(12, int(H * 0.022)))
        font_name = _font(max(22, int(H * 0.042)))

        number_text = str(ov.get("number", "") or "0")
        label_text = "GOAL!"
        name_text = str(ov.get("name", "") or "PLAYER")

        nb = draw.textbbox((0, 0), number_text, font=font_num)
        lb = draw.textbbox((0, 0), label_text, font=font_label)
        nmb = draw.textbbox((0, 0), name_text, font=font_name)
        nw_, nh_ = nb[2] - nb[0], nb[3] - nb[1]
        lw_, lh_ = lb[2] - lb[0], lb[3] - lb[1]
        nmw, nmh = nmb[2] - nmb[0], nmb[3] - nmb[1]

        pad_x = max(12, int(W * 0.011))
        pad_y = max(8, int(H * 0.012))
        sep = max(10, int(W * 0.01))
        text_inner_h = lh_ + 4 + nmh
        block_h = text_inner_h + pad_y * 2

        logo_h = block_h
        logo_w = 0
        logo_resized = None
        if logo_img is not None and logo_img.height > 0:
            ratio = logo_img.width / logo_img.height
            logo_w = int(logo_h * ratio)
            logo_resized = logo_img.resize((logo_w, logo_h), Image.LANCZOS)

        rect_w = pad_x + nw_ + sep + max(lw_, nmw) + pad_x
        total_w = (logo_w + sep if logo_w else 0) + rect_w

        bx = max(0, min(int((x_pct / 100.0) * W), W - total_w))
        by = max(0, min(int((y_pct / 100.0) * H), H - block_h))

        rect_x = bx
        if logo_resized is not None:
            img.paste(logo_resized, (bx, by + (block_h - logo_h) // 2), logo_resized)
            rect_x = bx + logo_w + sep

        draw.rectangle([rect_x, by, rect_x + rect_w, by + block_h], fill=ACCENT)

        x = rect_x + pad_x
        draw.text((x, _center_y(by, block_h, nb, nh_)), number_text, font=font_num, fill=WHITE)
        x += nw_ + sep

        text_top = by + (block_h - text_inner_h) // 2
        draw.text((x, text_top - lb[1]), label_text, font=font_label, fill=LIGHT_DIM)
        draw.text((x, text_top + lh_ + 4 - nmb[1]), name_text, font=font_name, fill=WHITE)

    else:
        return None

    bbox = img.getbbox()
    if bbox:
        pos = (bbox[0], bbox[1])
        arr = _np2.array(img.crop(bbox))
    else:
        pos = (0, 0)
        arr = _np2.array(img)
    start_s, dur_s = _hl_snap_overlay_timing(start_sec, duration_sec, clip_duration, fps)
    return (ImageClip(arr, duration=dur_s)
            .with_start(start_s).with_fps(fps).with_position(pos))


# ── editor project persistence (runtime JSON, not committed) ────────────────

def _hl_load_editor_projects() -> dict:
    if HIGHLIGHT_EDITOR_PROJECTS_PATH.exists():
        try:
            return _json.loads(HIGHLIGHT_EDITOR_PROJECTS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _hl_save_editor_projects(data: dict) -> None:
    HIGHLIGHT_EDITOR_PROJECTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    HIGHLIGHT_EDITOR_PROJECTS_PATH.write_text(
        _json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ── split jobs (first-half + second-half uploads → concat → analyze) ────────

@app.post("/api/highlight/jobs/split")
async def create_highlight_split_job(
    first_half: UploadFile = File(...),
    second_half: UploadFile = File(...),
    mode: str = Form("ai"),
    highlight_count: int = Form(40),
    log_data_json: str = Form("[]"),
    display_name: str = Form(""),
    db: Session = Depends(get_db),
    _user: str = Depends(_hl_require_user),
):
    if mode not in ("ai", "log_ai"):
        raise HTTPException(status_code=400, detail="mode must be 'ai' or 'log_ai'")
    for f in (first_half, second_half):
        if not f.filename:
            raise HTTPException(status_code=400, detail="전반/후반 파일을 모두 선택하세요.")

    job_id = str(uuid.uuid4())
    upload_dir = HIGHLIGHT_RUNTIME_DIR / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)

    ext1 = Path(first_half.filename).suffix or ".mp4"
    ext2 = Path(second_half.filename).suffix or ".mp4"
    path1 = upload_dir / f"{job_id}_1{ext1}"
    path2 = upload_dir / f"{job_id}_2{ext2}"
    with path1.open("wb") as buf:
        _shutil.copyfileobj(first_half.file, buf)
    with path2.open("wb") as buf:
        _shutil.copyfileobj(second_half.file, buf)
    path1 = _hl_normalize_for_analysis(path1)
    path2 = _hl_normalize_for_analysis(path2)

    second_half_start_sec = _hl_probe_duration(path1)
    combined = upload_dir / f"{job_id}_combined.mp4"
    _hl_concat_videos([path1, path2], combined)

    source_name = f"{Path(first_half.filename).stem} + {Path(second_half.filename).stem}"
    job = HighlightJob(
        id=job_id,
        status="queued",
        mode=mode,
        original_filename=source_name,
        display_name=display_name.strip() or None,
        upload_path=str(combined),
    )
    db.add(job)
    db.commit()

    if mode == "ai":
        _threading.Thread(
            target=_run_ai_analysis,
            args=(job_id, str(combined), highlight_count),
            daemon=True,
        ).start()
    else:
        try:
            parsed = _json.loads(log_data_json)
            log_data = parsed.get("data", []) if isinstance(parsed, dict) else parsed
            if not isinstance(log_data, list):
                log_data = []
        except Exception:
            log_data = []
        _threading.Thread(
            target=_run_log_analysis,
            args=(job_id, str(combined), log_data, second_half_start_sec, highlight_count),
            daemon=True,
        ).start()

    return {"job_id": job_id, "status": "queued", "second_half_start_sec": round(second_half_start_sec, 1)}


# ── editor overlays / bgm tracks (stored in job_metadata) ───────────────────

@app.get("/api/highlight/jobs/{job_id}/overlays")
def get_highlight_overlays(
    job_id: str, db: Session = Depends(get_db), _user: str = Depends(_hl_require_user),
):
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"overlays": (job.job_metadata or {}).get("editor_overlays", []) or []}


@app.post("/api/highlight/jobs/{job_id}/overlays")
def set_highlight_overlays(
    job_id: str, body: dict = Body(...), db: Session = Depends(get_db), _user: str = Depends(_hl_require_user),
):
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    meta = dict(job.job_metadata or {})
    meta["editor_overlays"] = body.get("overlays", []) or []
    _hl_update_job(db, job_id, job_metadata=meta)
    return {"ok": True}


@app.get("/api/highlight/jobs/{job_id}/bgm-tracks")
def get_highlight_bgm_tracks(
    job_id: str, db: Session = Depends(get_db), _user: str = Depends(_hl_require_user),
):
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"bgm_tracks": (job.job_metadata or {}).get("editor_bgm_tracks", []) or []}


@app.post("/api/highlight/jobs/{job_id}/bgm-tracks")
def set_highlight_bgm_tracks(
    job_id: str, body: dict = Body(...), db: Session = Depends(get_db), _user: str = Depends(_hl_require_user),
):
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    meta = dict(job.job_metadata or {})
    meta["editor_bgm_tracks"] = body.get("bgm_tracks", []) or []
    _hl_update_job(db, job_id, job_metadata=meta)
    return {"ok": True}


# ── BGM upload ──────────────────────────────────────────────────────────────

@app.post("/api/highlight/bgm/upload")
async def upload_highlight_bgm(
    file: UploadFile = File(...), _user: str = Depends(_hl_require_user),
):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in _BGM_EXTENSIONS:
        raise HTTPException(status_code=400, detail="지원하지 않는 파일 형식입니다.")
    safe_name = Path(file.filename).name
    dest = HIGHLIGHT_BGM_DIR / safe_name
    with dest.open("wb") as f:
        f.write(await file.read())
    return {"name": safe_name}


# ── overlay images (scoreboard / scorer templates) ──────────────────────────

@app.post("/api/highlight/jobs/{job_id}/overlay-images")
async def upload_highlight_overlay_image(
    job_id: str, file: UploadFile = File(...), db: Session = Depends(get_db), _user: str = Depends(_hl_require_user),
):
    if not db.get(HighlightJob, job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    if not file.filename:
        raise HTTPException(status_code=400, detail="파일이 없습니다.")
    safe_name = Path(file.filename).name
    if Path(safe_name).suffix.lower() not in _IMAGE_CARD_EXTS:
        raise HTTPException(status_code=400, detail="이미지 파일만 업로드 가능합니다.")
    saved = _hl_overlay_images_dir(job_id) / safe_name
    with saved.open("wb") as f:
        _shutil.copyfileobj(file.file, f)
    return {"ok": True, "name": safe_name}


@app.get("/api/highlight/jobs/{job_id}/overlay-images")
def list_highlight_overlay_images(
    job_id: str, db: Session = Depends(get_db), _user: str = Depends(_hl_require_user),
):
    if not db.get(HighlightJob, job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    d = _hl_overlay_images_dir(job_id)
    images = sorted(f.name for f in d.iterdir() if f.is_file() and f.suffix.lower() in _IMAGE_CARD_EXTS)
    return {"images": images}


@app.get("/api/highlight/jobs/{job_id}/overlay-images/{filename}")
def serve_highlight_overlay_image(
    job_id: str, filename: str, db: Session = Depends(get_db), _user: str = Depends(_hl_require_user),
):
    if "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    p = _hl_overlay_images_dir(job_id) / filename
    if not p.exists():
        raise HTTPException(status_code=404, detail="Overlay image not found")
    return FileResponse(str(p))


@app.delete("/api/highlight/jobs/{job_id}/overlay-images/{filename}")
def delete_highlight_overlay_image(
    job_id: str, filename: str, db: Session = Depends(get_db), _user: str = Depends(_hl_require_user),
):
    if "/" in filename or "\\" in filename or filename.startswith(".."):
        raise HTTPException(status_code=400, detail="잘못된 파일명")
    p = _hl_overlay_images_dir(job_id) / filename
    if not p.exists():
        raise HTTPException(status_code=404, detail="이미지 없음")
    p.unlink()
    return {"ok": True}


# ── external clips (add external video into the timeline without analysis) ──

@app.post("/api/highlight/jobs/{job_id}/external-clips")
async def upload_highlight_external_clip(
    job_id: str,
    file: UploadFile = File(...),
    register: bool = False,
    db: Session = Depends(get_db),
    _user: str = Depends(_hl_require_user),
):
    job = db.get(HighlightJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if not file.filename:
        raise HTTPException(status_code=400, detail="파일이 없습니다.")
    ext = Path(file.filename).suffix.lower()
    if ext not in _HL_EXTERNAL_VIDEO_EXTS:
        raise HTTPException(status_code=400, detail="영상 파일만 업로드 가능합니다 (mp4/mov/avi/mkv/webm/m4v).")
    clips_dir = _hl_clips_dir(job_id)
    clips_dir.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r"[^\w가-힣.\-]", "_", Path(file.filename).stem).strip("_") or "external"
    name = f"ext_{safe_stem}{ext}"
    saved = clips_dir / name
    i = 1
    while saved.exists():
        name = f"ext_{safe_stem}_{i}{ext}"
        saved = clips_dir / name
        i += 1
    with saved.open("wb") as f:
        _shutil.copyfileobj(file.file, f)

    if register:
        meta = dict(job.job_metadata or {})
        clips = list(meta.get("clips") or [])
        if name not in clips:
            clips.append(name)
        meta["clips"] = clips
        selected = dict(meta.get("selected") or {})
        selected[name] = True
        meta["selected"] = selected
        _hl_update_job(db, job_id, job_metadata=meta)

    return {"ok": True, "name": name}


# ── editor projects (timeline + overlays + bgm + settings) ──────────────────

@app.get("/api/highlight/editor/projects")
def list_highlight_editor_projects(_user: str = Depends(_hl_require_user)):
    data = _hl_load_editor_projects()
    out = [
        {
            "id": pid,
            "name": p.get("name", "(이름없음)"),
            "created_at": p.get("created_at"),
            "updated_at": p.get("updated_at"),
            "item_count": len(p.get("timeline", []) or []),
            "overlay_count": len(p.get("overlays", []) or []),
        }
        for pid, p in data.items()
    ]
    out.sort(key=lambda x: x.get("updated_at") or 0, reverse=True)
    return {"projects": out}


@app.post("/api/highlight/editor/projects")
def save_highlight_editor_project(body: dict = Body(...), _user: str = Depends(_hl_require_user)):
    data = _hl_load_editor_projects()
    name = (str(body.get("name", "")) or "").strip() or "무제 프로젝트"
    pid = next((k for k, v in data.items() if v.get("name") == name), None)
    now = time.time()
    created = data[pid].get("created_at", now) if pid else now
    if pid is None:
        pid = uuid.uuid4().hex
    data[pid] = {
        "name": name,
        "created_at": created,
        "updated_at": now,
        "job_id": body.get("job_id"),
        "timeline": body.get("timeline", []) or [],
        "overlays": body.get("overlays", []) or [],
        "bgm_tracks": body.get("bgm_tracks", []) or [],
        "transition_sec": float(body.get("transition_sec", 0.5)),
        "audio_volume": float(body.get("audio_volume", 1.0)),
    }
    _hl_save_editor_projects(data)
    return {"ok": True, "id": pid, "name": name}


@app.get("/api/highlight/editor/projects/{project_id}")
def get_highlight_editor_project(project_id: str, _user: str = Depends(_hl_require_user)):
    data = _hl_load_editor_projects()
    p = data.get(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")
    return {"id": project_id, **p}


@app.delete("/api/highlight/editor/projects/{project_id}")
def delete_highlight_editor_project(project_id: str, _user: str = Depends(_hl_require_user)):
    data = _hl_load_editor_projects()
    if project_id in data:
        del data[project_id]
        _hl_save_editor_projects(data)
    return {"ok": True}
