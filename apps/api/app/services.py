import asyncio
import hashlib
import hmac
import json
import os
import random
from datetime import datetime, timedelta
from uuid import UUID
import httpx
from sqlalchemy import desc
from sqlalchemy.orm import Session
from .models import DominanceBin, Event, Outbox, WebhookSubscription

BIN_SIZE_MS = 180000
DOM_POSSESSION_WEIGHT = float(os.getenv("DOM_POSSESSION_WEIGHT", "0.35"))
DOM_XG_WEIGHT = float(os.getenv("DOM_XG_WEIGHT", "0.65"))
DOM_ATTACK_WEIGHT = float(os.getenv("DOM_ATTACK_WEIGHT", "0.25"))
DOM_XG_SCALE = float(os.getenv("DOM_XG_SCALE", "1.8"))


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def recompute_dominance(bin_row: DominanceBin) -> None:
    total = bin_row.home_poss_ms + bin_row.away_poss_ms
    poss_balance = 0.0 if total == 0 else (bin_row.home_poss_ms - bin_row.away_poss_ms) / total
    xg_balance = clamp((bin_row.home_xg - bin_row.away_xg) * DOM_XG_SCALE, -1.0, 1.0)
    attack_total = bin_row.home_attack_score + bin_row.away_attack_score
    attack_balance = 0.0 if attack_total == 0 else (bin_row.home_attack_score - bin_row.away_attack_score) / attack_total
    weight_sum = DOM_POSSESSION_WEIGHT + DOM_XG_WEIGHT + DOM_ATTACK_WEIGHT
    if weight_sum <= 0:
        poss_w = 0.35
        xg_w = 0.65
        attack_w = 0.0
    else:
        poss_w = DOM_POSSESSION_WEIGHT / weight_sum
        xg_w = DOM_XG_WEIGHT / weight_sum
        attack_w = DOM_ATTACK_WEIGHT / weight_sum
    bin_row.dominance = clamp(
        poss_w * poss_balance + xg_w * xg_balance + attack_w * attack_balance,
        -1.0,
        1.0,
    )
    bin_row.updated_at = datetime.utcnow()


def apply_possession_segment(db: Session, match_id: UUID, team: str, start_ms: int, end_ms: int) -> None:
    if team not in ("HOME", "AWAY") or end_ms <= start_ms:
        return

    start_k = start_ms // BIN_SIZE_MS
    end_k = (end_ms - 1) // BIN_SIZE_MS

    for k in range(start_k, end_k + 1):
        bin_start = k * BIN_SIZE_MS
        bin_end = bin_start + BIN_SIZE_MS
        overlap = max(0, min(end_ms, bin_end) - max(start_ms, bin_start))
        if overlap <= 0:
            continue

        row = db.get(DominanceBin, (match_id, k))
        if not row:
            row = DominanceBin(
                match_id=match_id,
                k=k,
                start_ms=bin_start,
                end_ms=bin_end,
                home_poss_ms=0,
                away_poss_ms=0,
                home_xg=0.0,
                away_xg=0.0,
                home_attack_score=0.0,
                away_attack_score=0.0,
                dominance=0.0,
            )
            db.add(row)
            db.flush()

        if team == "HOME":
            row.home_poss_ms += overlap
        else:
            row.away_poss_ms += overlap
        recompute_dominance(row)


def apply_xg_event(db: Session, match_id: UUID, team: str, clock_ms: int, xg: float) -> None:
    if team not in ("HOME", "AWAY"):
        return

    k = clock_ms // BIN_SIZE_MS
    bin_start = k * BIN_SIZE_MS
    bin_end = bin_start + BIN_SIZE_MS

    row = db.get(DominanceBin, (match_id, k))
    if not row:
        row = DominanceBin(
            match_id=match_id,
            k=k,
            start_ms=bin_start,
            end_ms=bin_end,
            home_poss_ms=0,
            away_poss_ms=0,
            home_xg=0.0,
            away_xg=0.0,
            home_attack_score=0.0,
            away_attack_score=0.0,
            dominance=0.0,
        )
        db.add(row)
        db.flush()

    if team == "HOME":
        row.home_xg += xg
    else:
        row.away_xg += xg

    recompute_dominance(row)


def apply_attack_event(db: Session, match_id: UUID, team: str, clock_ms: int, weight: float = 1.0) -> None:
    if team not in ("HOME", "AWAY") or weight <= 0:
        return

    k = clock_ms // BIN_SIZE_MS
    bin_start = k * BIN_SIZE_MS
    bin_end = bin_start + BIN_SIZE_MS

    row = db.get(DominanceBin, (match_id, k))
    if not row:
        row = DominanceBin(
            match_id=match_id,
            k=k,
            start_ms=bin_start,
            end_ms=bin_end,
            home_poss_ms=0,
            away_poss_ms=0,
            home_xg=0.0,
            away_xg=0.0,
            home_attack_score=0.0,
            away_attack_score=0.0,
            dominance=0.0,
        )
        db.add(row)
        db.flush()

    if team == "HOME":
        row.home_attack_score += weight
    else:
        row.away_attack_score += weight

    recompute_dominance(row)


def backfill_attack_scores(db: Session, match_id: UUID) -> None:
    rows = db.query(DominanceBin).filter(DominanceBin.match_id == match_id).all()
    for row in rows:
        row.home_attack_score = 0.0
        row.away_attack_score = 0.0

    attack_events = (
        db.query(Event)
        .filter(Event.match_id == match_id, Event.type == "ATTACK_LANE")
        .order_by(Event.clock_ms.asc(), Event.created_at.asc(), Event.id.asc())
        .all()
    )

    for event in attack_events:
        apply_attack_event(db, match_id, event.team, event.clock_ms)


def enqueue_outbox(db: Session, kind: str, ref_id: UUID, target_url: str | None, payload: dict) -> None:
    if not target_url:
        return
    db.add(
        Outbox(
            kind=kind,
            ref_id=ref_id,
            target_url=target_url,
            payload=payload,
            attempts=0,
            next_attempt_at=datetime.utcnow(),
        )
    )


# Compatibility import; queue transport is independent of football scoring.
from .outbox_delivery import outbox_worker


def latest_outbox(db: Session, limit: int = 50):
    return db.query(Outbox).order_by(desc(Outbox.created_at)).limit(limit).all()
