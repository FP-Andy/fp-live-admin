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
from .models import DominanceBin, Outbox, WebhookSubscription

BIN_SIZE_MS = 180000


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def recompute_dominance(bin_row: DominanceBin) -> None:
    total = bin_row.home_poss_ms + bin_row.away_poss_ms
    poss_balance = 0.0 if total == 0 else (bin_row.home_poss_ms - bin_row.away_poss_ms) / total
    xg_balance = clamp(bin_row.home_xg - bin_row.away_xg, -1.0, 1.0)
    bin_row.dominance = clamp(0.6 * poss_balance + 0.4 * xg_balance, -1.0, 1.0)
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
            dominance=0.0,
        )
        db.add(row)
        db.flush()

    if team == "HOME":
        row.home_xg += xg
    else:
        row.away_xg += xg

    recompute_dominance(row)


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


async def outbox_worker(stop_event: asyncio.Event) -> None:
    from .db import SessionLocal

    retry_max = int(os.getenv("OUTBOX_RETRY_MAX", "10"))
    retry_base = int(os.getenv("OUTBOX_RETRY_BASE_SECONDS", "5"))
    retry_cap = int(os.getenv("OUTBOX_RETRY_MAX_DELAY_SECONDS", "300"))
    global_secret = os.getenv("WEBHOOK_SECRET", "")

    while not stop_event.is_set():
        db = SessionLocal()
        try:
            now = datetime.utcnow()
            rows = (
                db.query(Outbox)
                .filter(Outbox.next_attempt_at <= now)
                .filter(Outbox.attempts < retry_max)
                .order_by(Outbox.created_at)
                .limit(50)
                .all()
            )

            if not rows:
                await asyncio.sleep(1)
                continue

            subs = db.query(WebhookSubscription).filter(WebhookSubscription.active.is_(True)).all()
            secret_by_url = {s.callback_url: (s.secret or global_secret) for s in subs}

            async with httpx.AsyncClient(timeout=5.0) as client:
                for row in rows:
                    payload_raw = json.dumps(row.payload, separators=(",", ":"), sort_keys=True)
                    headers = {"Content-Type": "application/json"}
                    timestamp = str(int(datetime.utcnow().timestamp()))
                    secret = secret_by_url.get(row.target_url) or global_secret
                    headers["X-Webhook-Id"] = str(row.id)
                    headers["X-Webhook-Event"] = row.kind
                    headers["X-Webhook-Timestamp"] = timestamp
                    if secret:
                        signing_input = f"{timestamp}.{payload_raw}"
                        signature = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).hexdigest()
                        headers["X-Webhook-Signature"] = f"sha256={signature}"

                    try:
                        resp = await client.post(row.target_url, content=payload_raw, headers=headers)
                        if 400 <= resp.status_code < 500 and resp.status_code != 429:
                            row.attempts = retry_max
                            row.last_error = f"non-retryable HTTP {resp.status_code}: {resp.text[:300]}"
                            db.commit()
                            continue
                        resp.raise_for_status()
                        db.delete(row)
                        db.commit()
                    except Exception as ex:
                        row.attempts += 1
                        delay = min(retry_base * (2 ** max(0, row.attempts - 1)), retry_cap)
                        delay += random.uniform(0, 1.0)
                        row.next_attempt_at = datetime.utcnow() + timedelta(seconds=delay)
                        row.last_error = str(ex)[:1000]
                        db.commit()
        finally:
            db.close()

        await asyncio.sleep(0.5)


def latest_outbox(db: Session, limit: int = 50):
    return db.query(Outbox).order_by(desc(Outbox.created_at)).limit(limit).all()
