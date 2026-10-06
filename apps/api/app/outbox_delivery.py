"""Durable delivery loop. HTTP retries and database reconnects are independent."""
import asyncio
import hashlib
import hmac
import json
import os
import random
from datetime import datetime, timedelta
import httpx
from .models import Outbox, WebhookSubscription

HEALTH = {'running': False, 'last_poll_at': None, 'last_delivery_at': None,
          'consecutive_errors': 0, 'recoveries': 0, 'last_error_type': None}

def recovered():
    if HEALTH['consecutive_errors']:
        HEALTH['recoveries'] += 1
    HEALTH['consecutive_errors'] = 0
    HEALTH['last_error_type'] = None

async def pause(stop_event, seconds):
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass

async def outbox_worker(stop_event: asyncio.Event) -> None:
    from .db import SessionLocal

    retry_max = int(os.getenv("OUTBOX_RETRY_MAX", "10"))
    retry_base = int(os.getenv("OUTBOX_RETRY_BASE_SECONDS", "5"))
    retry_cap = int(os.getenv("OUTBOX_RETRY_MAX_DELAY_SECONDS", "300"))
    global_secret = os.getenv("WEBHOOK_SECRET", "")

    while not stop_event.is_set():
        db = None
        HEALTH['running'] = True
        try:
            db = SessionLocal()
            now = datetime.utcnow()
            rows = (
                db.query(Outbox)
                .filter(Outbox.next_attempt_at <= now)
                .filter(Outbox.attempts < retry_max)
                .order_by(Outbox.created_at)
                .limit(50)
                .all()
            )

            HEALTH['last_poll_at'] = datetime.utcnow().isoformat()
            if not rows:
                recovered()
                await pause(stop_event, 1)
                continue

            subs = db.query(WebhookSubscription).filter(WebhookSubscription.active.is_(True)).all()
            secret_by_url = {s.callback_url: (s.secret or global_secret) for s in subs}

            async with httpx.AsyncClient(timeout=5.0) as client:
                for row in rows:
                    if stop_event.is_set():
                        break
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
                        HEALTH['last_delivery_at'] = datetime.utcnow().isoformat()
                    except httpx.HTTPError as ex:
                        row.attempts += 1
                        delay = min(retry_base * (2 ** max(0, row.attempts - 1)), retry_cap)
                        delay += random.uniform(0, 1.0)
                        row.next_attempt_at = datetime.utcnow() + timedelta(seconds=delay)
                        row.last_error = str(ex)[:1000]
                        db.commit()
            recovered()
        except asyncio.CancelledError:
            raise
        except Exception as ex:
            # A failed commit is not an HTTP rejection. Roll back, retain the
            # durable row/ID and acquire a fresh session on the next iteration.
            HEALTH['consecutive_errors'] += 1
            HEALTH['last_error_type'] = type(ex).__name__
            if db is not None:
                try:
                    db.rollback()
                except Exception:
                    pass
            await pause(stop_event, min(30, 2 ** min(HEALTH['consecutive_errors'], 4)))
        finally:
            if db is not None:
                try:
                    db.close()
                except Exception:
                    pass
            HEALTH['running'] = False

        await pause(stop_event, 0.5)

