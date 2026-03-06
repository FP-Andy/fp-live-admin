import asyncio
from datetime import datetime
import math
import uuid
from uuid import UUID
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import desc
from sqlalchemy.orm import Session
import os
import httpx

from .db import Base, engine, get_db
from .models import Match, State, PossessionSegment, LaneSegment, Event, DominanceBin, Outbox, WebhookSubscription
from .schemas import (
    AcquireLockRequest,
    AttachIngestRequest,
    AttackLaneEventRequest,
    AttachSrtRequest,
    CreateMatchRequest,
    IngestProtocol,
    MatchResultResponse,
    MatchResponse,
    ReleaseLockRequest,
    StateRequest,
    WebhookSubscriptionCreateRequest,
    XGEstimateRequest,
    XGEventRequest,
)
from .services import apply_possession_segment, apply_xg_event, enqueue_outbox, latest_outbox, outbox_worker

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


@app.on_event("startup")
async def startup() -> None:
    global worker_task
    Base.metadata.create_all(bind=engine)
    worker_task = asyncio.create_task(outbox_worker(worker_stop_event))


@app.on_event("shutdown")
async def shutdown() -> None:
    worker_stop_event.set()
    if worker_task:
        await worker_task


def _require_write_lock(match_obj: Match, user_id: str | None) -> None:
    if match_obj.operator_id and match_obj.operator_id != user_id:
        raise HTTPException(status_code=403, detail="Operator lock held by another user")


def _is_in_penalty_area(x: float, y: float) -> bool:
    return (x > 88.5) and (13.84 < y < 54.16)


def _normalize_shot_x(
    team: str,
    attack_lr: str,
    start_x: float,
) -> float:
    home_dir = attack_lr
    away_dir = "R2L" if attack_lr == "L2R" else "L2R"
    team_dir = home_dir if team == "HOME" else away_dir
    return start_x if team_dir == "L2R" else 105.0 - start_x


def _estimate_xg(
    team: str,
    attack_lr: str,
    start_x: float,
    start_y: float,
    is_header: bool,
    is_weak_foot: bool,
) -> dict:
    shot_x_adj = _normalize_shot_x(team, attack_lr, start_x)
    shot_y_adj = start_y

    goal_x, goal_y = 105.0, 34.0
    goal_post_left = 30.34
    goal_post_right = 37.66

    distance = math.sqrt((goal_x - shot_x_adj) ** 2 + (goal_y - shot_y_adj) ** 2)

    dx_left = goal_x - shot_x_adj
    dy_left = goal_post_left - shot_y_adj
    dx_right = goal_x - shot_x_adj
    dy_right = goal_post_right - shot_y_adj
    angle_left = math.atan2(dy_left, dx_left)
    angle_right = math.atan2(dy_right, dx_right)
    angle = abs(angle_left - angle_right)

    is_pa = 1 if _is_in_penalty_area(shot_x_adj, shot_y_adj) else 0
    is_head = 1 if is_header else 0
    is_weak = 1 if is_weak_foot else 0

    exponent = 0.2 * distance - 2.0 * angle - 1.2 * is_pa + 1.5 * is_head + 0.8 * is_weak - 0.6
    xg = 1.0 / (1.0 + math.exp(exponent))
    xg = max(0.0, min(1.0, xg))

    return {
        "xg": round(xg, 3),
        "distance": round(distance, 2),
        "angle_rad": round(angle, 4),
        "is_in_box": bool(is_pa),
        "normalized_x": round(shot_x_adj, 2),
        "normalized_y": round(shot_y_adj, 2),
    }


def _serialize_match(row: Match) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "hls_url": row.hls_url,
        "metadata": row.metadata_json,
        "operator_id": row.operator_id,
    }


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


def _build_match_summary(match_id: UUID, db: Session) -> dict:
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")

    last_state = (
        db.query(State)
        .filter(State.match_id == match_id)
        .order_by(desc(State.created_at))
        .first()
    )
    current_clock = last_state.clock_ms if last_state else 0

    poss_rows = db.query(PossessionSegment).filter(PossessionSegment.match_id == match_id).all()
    home_ms = 0
    away_ms = 0
    for seg in poss_rows:
        end_ms = seg.end_ms if seg.end_ms is not None else current_clock
        dur = max(0, end_ms - seg.start_ms)
        if seg.team == "HOME":
            home_ms += dur
        elif seg.team == "AWAY":
            away_ms += dur

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

    def lane_calc(team: str):
        left = center = right = 0
        current_lane = None
        team_lane_events = [e for e in ev_rows if e.type == "ATTACK_LANE" and e.team == team]
        for ev in team_lane_events:
            if ev.lane == "LEFT":
                left += 1
            elif ev.lane == "CENTER":
                center += 1
            elif ev.lane == "RIGHT":
                right += 1

        for ev in ev_rows:
            if ev.type != "ATTACK_LANE" or ev.team != team:
                continue
            current_lane = ev.lane
            break

        total = left + center + right
        return {
            "left_count": left,
            "center_count": center,
            "right_count": right,
            "left_pct": (left / total * 100.0) if total else 0.0,
            "center_pct": (center / total * 100.0) if total else 0.0,
            "right_pct": (right / total * 100.0) if total else 0.0,
            "total_count": total,
            "current_lane": current_lane,
        }

    return {
        "match": {
            "id": str(match_obj.id),
            "name": match_obj.name,
            "hls_url": match_obj.hls_url,
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
                "created_at": e.created_at.isoformat(),
            }
            for e in ev_rows
        ],
    }


def _build_dominance(match_id: UUID, bin_seconds: int, db: Session) -> dict:
    if bin_seconds != 180:
        raise HTTPException(status_code=400, detail="Only 180-second bins are supported in MVP")
    rows = (
        db.query(DominanceBin)
        .filter(DominanceBin.match_id == match_id)
        .order_by(DominanceBin.k)
        .all()
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
                "dominance": r.dominance,
            }
            for r in rows
        ],
    }


def _build_partner_match_result(match_id: UUID, db: Session) -> dict:
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")

    last_state = (
        db.query(State)
        .filter(State.match_id == match_id)
        .order_by(desc(State.created_at))
        .first()
    )
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


def _require_partner_auth(x_api_key: str | None = Header(default=None, alias="X-API-Key")) -> None:
    required = os.getenv("PARTNER_API_KEY", "").strip()
    if not required:
        return
    if x_api_key != required:
        raise HTTPException(status_code=401, detail="Invalid API key")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "time": datetime.utcnow().isoformat()}


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


@app.post("/api/matches", response_model=MatchResponse)
def create_match(body: CreateMatchRequest, db: Session = Depends(get_db)):
    metadata = dict(body.metadata or {})
    row = Match(id=uuid.uuid4(), name=body.name, hls_url=body.hls_url, metadata_json=metadata)

    ingest_url, ingest_protocol = _resolve_ingest_fields(body.ingest_url, body.srt_url, body.ingest_protocol)
    if ingest_protocol:
        metadata["ingest_protocol"] = ingest_protocol
    if ingest_url:
        metadata["ingest_url"] = ingest_url

    if ingest_url or ingest_protocol == "RTMP":
        try:
            start_data = _gateway_start_stream(row.id, ingest_url, ingest_protocol)
            row.hls_url = start_data["hls_url"]
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

    start_data = _gateway_start_stream(match_id, body.srt_url, "SRT")
    metadata = dict(row.metadata_json or {})
    metadata["ingest_protocol"] = "SRT"
    metadata["ingest_url"] = body.srt_url
    row.metadata_json = metadata
    row.hls_url = start_data["hls_url"]
    db.commit()
    db.refresh(row)
    return {
        "ok": True,
        "match_id": str(row.id),
        "ingest_url": body.srt_url,
        "ingest_protocol": "SRT",
        "hls_url": row.hls_url,
    }


@app.post("/api/matches/{match_id}/stream")
def attach_ingest_stream(match_id: UUID, body: AttachIngestRequest, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")

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
    row.hls_url = start_data["hls_url"]
    db.commit()
    db.refresh(row)
    return {
        "ok": True,
        "match_id": str(row.id),
        "ingest_protocol": metadata.get("ingest_protocol"),
        "ingest_url": metadata.get("ingest_url"),
        "hls_url": row.hls_url,
        "rtmp": metadata.get("rtmp"),
    }


@app.post("/api/matches/{match_id}/stream/clear")
def clear_match_stream(match_id: UUID, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    _gateway_clear_stream(match_id)
    return {"ok": True, "match_id": str(row.id)}


@app.post("/api/matches/{match_id}/stream/stop")
def stop_match_stream(match_id: UUID, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")

    gateway_base = os.getenv("GATEWAY_API_BASE", "http://host.docker.internal:8090").rstrip("/")
    if not gateway_base:
        raise HTTPException(status_code=500, detail="GATEWAY_API_BASE not configured")

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(f"{gateway_base}/matches/{match_id}/stop")
            resp.raise_for_status()
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"gateway stop failed: {ex}") from ex

    return {"ok": True, "match_id": str(row.id)}


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

    last_state = (
        db.query(State)
        .filter(State.match_id == match_id)
        .order_by(desc(State.created_at))
        .first()
    )

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
    home_ms = 0
    away_ms = 0
    for seg in poss_rows:
        end_ms = seg.end_ms if seg.end_ms is not None else clock_ms
        dur = max(0, end_ms - seg.start_ms)
        if seg.team == "HOME":
            home_ms += dur
        elif seg.team == "AWAY":
            away_ms += dur

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
def delete_match(match_id: UUID, stop_stream: bool = True, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")

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

    return {"ok": True, "deleted_match_id": str(match_id), "stream_stop_requested": stop_stream}


@app.post("/api/matches/{match_id}/lock/acquire")
def acquire_lock(match_id: UUID, body: AcquireLockRequest, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    if row.operator_id and row.operator_id != body.user_id and not body.admin_takeover:
        raise HTTPException(status_code=409, detail="Lock already acquired")
    row.operator_id = body.user_id
    db.commit()
    return {"ok": True, "operator_id": row.operator_id}


@app.post("/api/matches/{match_id}/lock/release")
def release_lock(match_id: UUID, body: ReleaseLockRequest | None = None, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")

    user_id = body.user_id if body else None
    admin_takeover = body.admin_takeover if body else False
    if row.operator_id and row.operator_id != user_id and not admin_takeover:
        raise HTTPException(status_code=403, detail="Not lock owner")
    row.operator_id = None
    db.commit()
    return {"ok": True}


@app.post("/api/matches/{match_id}/state")
def post_state(match_id: UUID, body: StateRequest, db: Session = Depends(get_db)):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_write_lock(match_obj, body.user_id)

    existing = db.get(State, body.state_id)
    if existing:
        return {"ok": True, "idempotent": True, "state_id": existing.id}

    prev = (
        db.query(State)
        .filter(State.match_id == match_id)
        .order_by(desc(State.created_at))
        .first()
    )

    prev_team = prev.possession_team if prev else "NONE"
    new_team = body.possession_team

    if prev_team != new_team:
        if prev_team in ("HOME", "AWAY"):
            open_seg = (
                db.query(PossessionSegment)
                .filter(PossessionSegment.match_id == match_id)
                .filter(PossessionSegment.team == prev_team)
                .filter(PossessionSegment.end_ms.is_(None))
                .order_by(desc(PossessionSegment.created_at))
                .first()
            )
            if open_seg and body.clock_ms >= open_seg.start_ms:
                open_seg.end_ms = body.clock_ms
                apply_possession_segment(db, match_id, prev_team, open_seg.start_ms, open_seg.end_ms)

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


@app.post("/api/matches/{match_id}/events/attack_lane")
def post_attack_lane(match_id: UUID, body: AttackLaneEventRequest, db: Session = Depends(get_db)):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_write_lock(match_obj, body.user_id)

    existing = db.get(Event, body.event_id)
    if existing:
        return {"ok": True, "idempotent": True, "event_id": existing.id}

    clock_ms = body.clock_ms
    if clock_ms is None:
        last_state = (
            db.query(State)
            .filter(State.match_id == match_id)
            .order_by(desc(State.created_at))
            .first()
        )
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
def post_xg(match_id: UUID, body: XGEventRequest, db: Session = Depends(get_db)):
    match_obj = db.get(Match, match_id)
    if not match_obj:
        raise HTTPException(status_code=404, detail="Match not found")
    _require_write_lock(match_obj, body.user_id)

    existing = db.get(Event, body.event_id)
    if existing:
        return {"ok": True, "idempotent": True, "event_id": existing.id}

    clock_ms = body.clock_ms
    if clock_ms is None:
        last_state = (
            db.query(State)
            .filter(State.match_id == match_id)
            .order_by(desc(State.created_at))
            .first()
        )
        if not last_state:
            raise HTTPException(status_code=400, detail="clock_ms missing and no state exists")
        clock_ms = last_state.clock_ms

    event = Event(
        id=body.event_id,
        match_id=match_id,
        type="XG",
        clock_ms=clock_ms,
        team=body.team,
        xg=body.xg,
    )
    db.add(event)
    apply_xg_event(db, match_id, body.team, clock_ms, body.xg)

    payload = {
        "kind": "EVENT",
        "event_id": str(body.event_id),
        "idempotency_key": str(body.event_id),
        "match_id": str(match_id),
        "type": "XG",
        "clock_ms": clock_ms,
        "team": body.team,
        "xg": body.xg,
        "created_at": datetime.utcnow().isoformat(),
    }
    _enqueue_webhook_fanout(db, "EVENT", body.event_id, payload)

    db.commit()
    return {"ok": True, "event_id": body.event_id}


@app.get("/api/matches/{match_id}/summary")
def summary(match_id: UUID, db: Session = Depends(get_db)):
    return _build_match_summary(match_id, db)


@app.get("/api/matches/{match_id}/dominance")
def dominance(match_id: UUID, bin_seconds: int = Query(default=180), db: Session = Depends(get_db)):
    return _build_dominance(match_id, bin_seconds, db)


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
    db: Session = Depends(get_db),
):
    return _build_dominance(match_id, bin_seconds, db)


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

    last_state = (
        db.query(State)
        .filter(State.match_id == match_id)
        .order_by(desc(State.created_at))
        .first()
    )
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
