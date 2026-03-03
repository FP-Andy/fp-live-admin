import asyncio
from datetime import datetime
import math
import uuid
from uuid import UUID
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import desc
from sqlalchemy.orm import Session
import os
import httpx

from .db import Base, engine, get_db
from .models import Match, State, PossessionSegment, LaneSegment, Event, DominanceBin, Outbox
from .schemas import (
    AcquireLockRequest,
    AttachIngestRequest,
    AttackLaneEventRequest,
    AttachSrtRequest,
    CreateMatchRequest,
    IngestProtocol,
    MatchResponse,
    ReleaseLockRequest,
    StateRequest,
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
    if ingest_url or ingest_protocol == "RTMP":
        start_data = _gateway_start_stream(row.id, ingest_url, ingest_protocol)
        row.hls_url = start_data["hls_url"]
        metadata["ingest_protocol"] = start_data.get("ingest_protocol") or ingest_protocol
        metadata["ingest_url"] = start_data.get("source_url") or ingest_url
        if start_data.get("rtmp"):
            metadata["rtmp"] = start_data["rtmp"]

    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "id": row.id,
        "name": row.name,
        "hls_url": row.hls_url,
        "metadata": row.metadata_json,
        "operator_id": row.operator_id,
    }


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


@app.get("/api/matches/{match_id}/stream/rtmp-info")
def get_rtmp_info(match_id: UUID, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    return _gateway_rtmp_info(match_id)


@app.get("/api/matches")
def list_matches(db: Session = Depends(get_db)):
    rows = db.query(Match).order_by(desc(Match.created_at)).all()
    return [
        {
            "id": r.id,
            "name": r.name,
            "hls_url": r.hls_url,
            "metadata": r.metadata_json,
            "operator_id": r.operator_id,
        }
        for r in rows
    ]


@app.get("/api/matches/{match_id}")
def get_match(match_id: UUID, db: Session = Depends(get_db)):
    row = db.get(Match, match_id)
    if not row:
        raise HTTPException(status_code=404, detail="Match not found")
    return {
        "id": row.id,
        "name": row.name,
        "hls_url": row.hls_url,
        "metadata": row.metadata_json,
        "operator_id": row.operator_id,
    }


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
    enqueue_outbox(db, "STATE", body.state_id, os.getenv("WEBHOOK_STATE_URL"), payload)

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
    enqueue_outbox(db, "EVENT", body.event_id, os.getenv("WEBHOOK_EVENT_URL"), payload)

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
    enqueue_outbox(db, "EVENT", body.event_id, os.getenv("WEBHOOK_EVENT_URL"), payload)

    db.commit()
    return {"ok": True, "event_id": body.event_id}


@app.get("/api/matches/{match_id}/summary")
def summary(match_id: UUID, db: Session = Depends(get_db)):
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

    ev_rows = (
        db.query(Event)
        .filter(Event.match_id == match_id)
        .order_by(desc(Event.created_at))
        .limit(50)
        .all()
    )

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


@app.get("/api/matches/{match_id}/dominance")
def dominance(match_id: UUID, bin_seconds: int = Query(default=180), db: Session = Depends(get_db)):
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
