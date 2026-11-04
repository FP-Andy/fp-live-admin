"""FPC 직원용 FLA 에이전트 API — `/api/agent/fla/**` (이사68, 2026-11-04).

직원이 자기 AI 에이전트로 FLA 경기 기록을 읽고, 잘못 넣은 기록을 **정해진 규칙대로** 고친다.

경계(보안 검증용 요약)
- 인증은 이 파일의 `Authorization: Bearer fpcfla_…` 하나뿐이다. 세션 쿠키·파트너 키(X-API-Key)·방송 키는
  이 경로에서 읽지도 않는다. 반대로 다른 라우트는 Authorization 헤더를 읽지 않으므로 이 토큰은 거기서 아무것도 열지 못한다.
- 토큰은 해시(sha256)만 저장, 사람(users 행) 1명당 활성 토큰 1개, 범위 fla:read / fla:write, 만료·폐기.
- 쓰기는 plan → apply 두 단계다. plan 은 아무것도 바꾸지 않고, 바뀔 전/후·점수·경고를 돌려준다.
  apply 는 plan 때 본 항목이 그 사이 바뀌지 않았는지(항목별 지문) 확인한 뒤 그대로 쓴다.
- 값은 기록 수정 화면과 같은 함수(main._apply_editor_item_updates)로 만든다 — 같은 데이터에 규칙이 두 벌 생기지 않게.
  점유 구간·시각 일괄 이동은 그 화면에 없는 정정이라 여기서 범위를 좁게 정의했다(닫힌 구간만, 열린 구간은 운영자 몫).
- 진행 중 경기(보관 전)도 고칠 수 있다. 단 운영자 실시간 입력을 깨지 않게:
  시계·점유 명령(State, fla_clock_revision)은 절대 쓰지 않는다 → 운영자 보관함(outbox)의 명령 번호와 엮이지 않는다.
  지금 시계보다 뒤의 기록, 방금(LIVE_SETTLE_SECONDS) 들어온 기록, 열린 점유 구간, 하프 전환(새 마커)은 거부한다.
  지운 운영자 기록은 삭제표식(tombstone)을 남겨, 응답을 못 받은 보관함이 같은 id 로 다시 보내도 되살아나지 않게 한다.
- 모든 apply·revert 는 변경 묶음(agent_fla_changes)에 전/후 스냅샷으로 남고 audit_logs 에도 실명으로 남는다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Literal, Union
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func, or_, select
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, Session, mapped_column

from .auth import require_admin, require_session_user
from .auth_security import fingerprint, normalize_login
from .db import Base, get_db
from .models import AuditLog, Event, Match, MatchMarker, PossessionSegment, ScheduleEntry, State, User

router = APIRouter()

TOKEN_PREFIX = "fpcfla_"
SCOPES = ("fla:read", "fla:write")
KST = timezone(timedelta(hours=9))


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


AGENT_ENABLED = os.getenv("AGENT_FLA_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
WRITE_ENABLED = os.getenv("AGENT_FLA_WRITE_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
RATE_PER_MINUTE = _env_int("AGENT_FLA_RATE_PER_MINUTE", 60)
WRITE_RATE_PER_MINUTE = _env_int("AGENT_FLA_WRITE_RATE_PER_MINUTE", 20)
DAILY_WRITES = _env_int("AGENT_FLA_DAILY_WRITES", 40)  # apply + revert, 토큰당, 한국 날짜 기준
DAILY_PLANS = _env_int("AGENT_FLA_DAILY_PLANS", 200)
MAX_ITEMS = _env_int("AGENT_FLA_MAX_ITEMS", 20)  # plan 하나가 바꾸는 행 수
PLAN_TTL_SECONDS = _env_int("AGENT_FLA_PLAN_TTL_SECONDS", 600)
LIVE_SETTLE_SECONDS = _env_int("AGENT_FLA_LIVE_SETTLE_SECONDS", 30)
TOKEN_DEFAULT_DAYS = 90
STOPPAGE_MAX_MS = 20 * 60_000  # 하프마다 추가시간 상한(표기 45+20:00까지)
DUPLICATE_WINDOW_MS = 3_000
RULES_PATH = Path(__file__).resolve().parent / "data" / "agent_fla_rules.md"
RULES_VERSION = "2026-11-04.1"

# 토큰으로 할 수 없는 일 — 이름을 넣으면 422 가 아니라 403 과 이유를 돌려준다(에이전트가 다른 길을 찾지 않게).
FORBIDDEN_OPS = {
    "create_match": "경기 생성", "delete_match": "경기 삭제", "archive_match": "경기 보관", "unarchive_match": "보관 해제",
    "start_stream": "송출 시작", "stop_stream": "송출 중지", "cleanup_stream": "송출 정리",
    "reset_possession": "점유 기록 전체 초기화", "reset_events": "기록 전체 초기화", "reset_match": "경기 초기화",
    "release_lock": "잠금 해제", "force_unlock": "잠금 강제 해제", "acquire_lock": "운영권 가져오기",
    "set_clock": "경기 시계 조작", "start_clock": "시계 시작", "stop_clock": "시계 정지", "start_period": "하프 전환",
    "set_possession": "현재 점유 바꾸기", "update_lineup": "라인업 수정", "manage_users": "사용자 관리",
    "manage_tokens": "토큰 관리", "send_fineplay": "FinePlay 전송", "highlight": "하이라이트 작업",
    "card": "카드 제작", "fpa": "FPA 작업", "broadcast": "중계 그래픽 조작",
}


# ── 표 ────────────────────────────────────────────────────────────────────────

class AgentFlaToken(Base):
    __tablename__ = "agent_fla_tokens"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    display_prefix: Mapped[str] = mapped_column(String(24), nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    scopes: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_by: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_by: Mapped[str | None] = mapped_column(String, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AgentFlaChange(Base):
    """plan 1건 = 행 1개. apply 하면 같은 행이 변경 묶음이 된다(전/후 스냅샷 포함)."""

    __tablename__ = "agent_fla_changes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    token_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    actor_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    match_id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="planned", index=True)
    live: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    request_summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    summary: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    ops: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    items: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    preview: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    reverted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    reverted_by_token: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AgentFlaTombstone(Base):
    """에이전트가 지운 기록의 id. 운영자 보관함이 같은 id 를 다시 보내도 되살리지 않는다."""

    __tablename__ = "agent_fla_tombstones"

    event_id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    match_id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False, index=True)
    change_id: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)


def is_tombstoned(db: Session, event_id: UUID) -> bool:
    return db.get(AgentFlaTombstone, event_id) is not None


def _core():
    # main 이 이 모듈을 불러오므로 실행 시점에 가져온다. 재사용하는 main 함수는 이 이름으로만 부른다.
    from . import main
    return main


def _utcnow() -> datetime:
    return datetime.utcnow()


def _kst(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc).astimezone(KST).isoformat(timespec="seconds")


def _kst_day_start_utc(now: datetime | None = None) -> datetime:
    now = now or _utcnow()
    local = now.replace(tzinfo=timezone.utc).astimezone(KST)
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(timezone.utc).replace(tzinfo=None)


# ── 인증 ──────────────────────────────────────────────────────────────────────

class _RateLimiter:
    def __init__(self):
        self._hits: dict[tuple[str, str], deque] = {}
        self._lock = threading.Lock()

    def hit(self, token_id: str, bucket: str, limit: int) -> int | None:
        """한도 안이면 None, 넘으면 다시 시도할 초."""
        now = time.monotonic()
        with self._lock:
            q = self._hits.setdefault((token_id, bucket), deque())
            while q and now - q[0] >= 60:
                q.popleft()
            if len(q) >= max(1, limit):
                return max(1, int(60 - (now - q[0])) + 1)
            q.append(now)
            return None

    def reset(self):
        with self._lock:
            self._hits.clear()


rate_limiter = _RateLimiter()


class AgentPrincipal:
    def __init__(self, token: AgentFlaToken, user: User):
        self.token = token
        self.user = user

    @property
    def scopes(self) -> set[str]:
        return set(self.token.scopes or [])


def _unauthorized(detail: str = "에이전트 토큰이 없거나 올바르지 않습니다.") -> HTTPException:
    return HTTPException(401, detail, headers={"WWW-Authenticate": "Bearer"})


def _agent_principal(request: Request, db: Session = Depends(get_db)) -> AgentPrincipal:
    if not AGENT_ENABLED:
        raise HTTPException(503, "에이전트 API 가 꺼져 있습니다(관리자 문의).")
    header = request.headers.get("authorization") or ""
    scheme, _, raw = header.partition(" ")
    raw = raw.strip()
    if scheme.lower() != "bearer" or not raw.startswith(TOKEN_PREFIX) or len(raw) > 200:
        raise _unauthorized()
    digest = fingerprint(raw)
    row = db.scalar(select(AgentFlaToken).where(AgentFlaToken.token_hash == digest))
    if row is None or not hmac.compare_digest(row.token_hash, digest):
        raise _unauthorized()
    now = _utcnow()
    if row.revoked_at is not None:
        raise _unauthorized("폐기된 토큰입니다.")
    if row.expires_at <= now:
        raise _unauthorized("만료된 토큰입니다.")
    user = db.get(User, row.user_id)
    if user is None:
        raise _unauthorized()
    retry = rate_limiter.hit(row.id, "all", RATE_PER_MINUTE)
    if retry is not None:
        raise HTTPException(429, "호출 한도를 넘었습니다. 잠시 뒤 다시 하세요.", headers={"Retry-After": str(retry)})
    if row.last_used_at is None or now - row.last_used_at > timedelta(seconds=60):
        row.last_used_at = now
        db.commit()
    return AgentPrincipal(row, user)


def _require_scope(scope: str):
    def dependency(principal: AgentPrincipal = Depends(_agent_principal)) -> AgentPrincipal:
        if scope not in principal.scopes:
            raise HTTPException(403, f"이 토큰에는 {scope} 권한이 없습니다.")
        if scope == "fla:write":
            if not WRITE_ENABLED:
                raise HTTPException(503, "에이전트 수정 기능이 꺼져 있습니다(관리자 문의).")
            retry = rate_limiter.hit(principal.token.id, "write", WRITE_RATE_PER_MINUTE)
            if retry is not None:
                raise HTTPException(429, "수정 호출 한도를 넘었습니다. 잠시 뒤 다시 하세요.", headers={"Retry-After": str(retry)})
        return principal
    return dependency


read_principal = _require_scope("fla:read")
write_principal = _require_scope("fla:write")


def _audit(db: Session, principal: AgentPrincipal, action: str, *, match_id=None, target_id=None,
           severity: str = "INFO", details: dict | None = None) -> None:
    user = principal.user
    db.add(AuditLog(actor_id=user.id, actor_name=user.name, actor_role=user.role, action=action,
                    target_type="agent_fla", target_id=target_id, match_id=str(match_id) if match_id else None,
                    severity=severity, details={"token_id": principal.token.id, "token_label": principal.token.label,
                                                **(details or {})}))


# ── 시각 규칙 ─────────────────────────────────────────────────────────────────

HALVES = ("1H", "2H", "ET1", "ET2")
MARKER_FOR = {"2H": "HALFTIME_START", "ET1": "EXTRA_TIME_1_START", "ET2": "EXTRA_TIME_2_START"}
HALF_FOR_MARKER = {v: k for k, v in MARKER_FOR.items()}
HALF_LABEL = {"1H": "전반", "2H": "후반", "ET1": "연장 전반", "ET2": "연장 후반"}
CLOCK_RE = re.compile(r"^\s*(\d{1,3})(?:\+(\d{1,2})(?::(\d{2}))?|:(\d{2}))\s*$")


class RuleError(Exception):
    def __init__(self, code: str, message: str, **extra):
        super().__init__(message)
        self.code, self.message, self.extra = code, message, extra

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message, **self.extra}


def _fmt_mmss(ms: int) -> str:
    s = max(0, int(ms) // 1000)
    return f"{s // 60:02d}:{s % 60:02d}"


class ClockContext:
    """경기 시계 ↔ 저장 값(raw clock_ms) 변환. main._normalize_match_clock_ms 와 같은 기준이다.

    저장 값은 킥오프부터 시계가 실제로 흐른 누적 ms(쉬는 시간 제외)다. 후반 시작 표시(HALFTIME_START)의
    저장 값이 S 면 후반 경기 시계 = 전반 길이 + (raw − S). 전반 추가시간은 raw 그대로(45+2:00 = 47:00).
    """

    def __init__(self, match_obj: Match, markers: dict[str, int | None]):
        fh = int(match_obj.first_half_minutes or 45) * 60_000
        sh = int(match_obj.second_half_minutes or 45) * 60_000
        e1 = int(getattr(match_obj, "extra_first_half_minutes", None) or 15) * 60_000
        e2 = int(getattr(match_obj, "extra_second_half_minutes", None) or 15) * 60_000
        self.base = {"1H": 0, "2H": fh, "ET1": fh + sh, "ET2": fh + sh + e1}
        self.length = {"1H": fh, "2H": sh, "ET1": e1, "ET2": e2}
        self.markers = dict(markers)

    def start(self, half: str) -> int | None:
        return 0 if half == "1H" else self.markers.get(MARKER_FOR[half])

    def half_of(self, raw: int) -> str:
        for half in ("ET2", "ET1", "2H"):
            start = self.start(half)
            if start is not None and raw >= start:
                return half
        return "1H"

    def next_start(self, half: str) -> int | None:
        idx = HALVES.index(half)
        for later in HALVES[idx + 1:]:
            start = self.start(later)
            if start is not None:
                return start
        return None

    def clock_in(self, half: str, raw: int) -> str:
        """raw 를 그 하프의 경기 시계로 적는다. 정규 시간을 넘으면 '45+2:10' 꼴."""
        display = self.base[half] + (raw - (self.start(half) or 0))
        end = self.base[half] + self.length[half]
        if display > end:
            over = display - end
            return f"{end // 60_000}+{over // 60_000}:{(over // 1000) % 60:02d}"
        return _fmt_mmss(display)

    def describe(self, raw: int) -> dict:
        half = self.half_of(raw)
        clock = self.clock_in(half, raw)
        return {"half": half, "clock": clock, "label": f"{half} {clock}", "raw_clock_ms": int(raw)}

    def parse_display(self, half: str, text: str) -> int:
        match = CLOCK_RE.match(text or "")
        if not match:
            raise RuleError("BAD_CLOCK", f"시각 '{text}' 를 읽을 수 없습니다. 'mm:ss' 또는 '45+2:10' 처럼 적으세요.")
        minutes, extra_min, extra_sec, sec = match.groups()
        end = self.base[half] + self.length[half]
        if extra_min is not None:
            if int(minutes) * 60_000 != end:
                raise RuleError("BAD_CLOCK", f"{half} 추가시간은 '{end // 60_000}+분:초' 로 적습니다(받은 값 '{text}').")
            return end + int(extra_min) * 60_000 + int(extra_sec or 0) * 1000
        if int(sec) >= 60:
            raise RuleError("BAD_CLOCK", f"초는 00~59 입니다(받은 값 '{text}').")
        return int(minutes) * 60_000 + int(sec) * 1000

    def to_raw(self, half: str, text: str, *, check_next: bool = True) -> int:
        if half not in HALVES:
            raise RuleError("BAD_HALF", "하프는 1H·2H·ET1·ET2 중 하나입니다.")
        display = self.parse_display(half, text)
        lo, hi = self.base[half], self.base[half] + self.length[half] + STOPPAGE_MAX_MS
        if not lo <= display <= hi:
            raise RuleError("CLOCK_OUT_OF_HALF", f"{half} 시각은 {_fmt_mmss(lo)} ~ {self.describe_end(half)} 사이여야 합니다(받은 값 '{text}').")
        start = self.start(half)
        if start is None:
            raise RuleError("PERIOD_NOT_STARTED", f"이 경기에는 {HALF_LABEL[half]} 시작 표시가 없습니다. 하프를 다시 확인하세요.")
        raw = start + (display - lo)
        nxt = self.next_start(half)
        if check_next and nxt is not None and raw >= nxt:
            raise RuleError("CLOCK_IN_NEXT_PERIOD", f"{half} {text} 는 다음 하프가 시작된 뒤입니다. 하프를 다시 확인하세요.",
                            next_period_start=self.describe(nxt)["label"])
        return raw

    def describe_end(self, half: str) -> str:
        end = self.base[half] + self.length[half]
        return f"{end // 60_000}+{STOPPAGE_MAX_MS // 60_000}:00"


def _marker_map(markers: list[MatchMarker]) -> dict[str, int | None]:
    # main._period_start_marker_ms 와 같이 종류마다 가장 이른 표시를 쓴다.
    found: dict[str, int | None] = {}
    for m in sorted(markers, key=lambda r: (r.clock_ms, r.created_at or datetime.min, str(r.id))):
        found.setdefault(m.marker_type, m.clock_ms)
    return found


# ── 스냅샷 ────────────────────────────────────────────────────────────────────

EVENT_COLS = ("id", "match_id", "type", "clock_ms", "team", "lane", "xg", "xgot", "player_name", "player_number",
              "is_goal", "is_own_goal", "is_on_target", "shot_x", "shot_y", "goalmouth_x", "goalmouth_y", "is_header",
              "is_weak_foot", "under_pressure", "one_on_one", "shot_pace_band", "created_at")
MARKER_COLS = ("id", "match_id", "marker_type", "clock_ms", "created_at")
SEGMENT_COLS = ("id", "match_id", "team", "start_ms", "end_ms", "created_at")


def _jsonable(value):
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _snap(row, cols) -> dict:
    return {c: _jsonable(getattr(row, c)) for c in cols}


def _fp(snapshot: dict | None) -> str | None:
    if snapshot is None:
        return None
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]


def _copy(model, row, cols):
    return model(**{c: getattr(row, c) for c in cols})


def _restore_value(col: str, value):
    if value is None:
        return None
    if col in ("id", "match_id"):
        return UUID(str(value))
    if col == "created_at":
        return datetime.fromisoformat(value)
    return value


# ── 수정 요청(ops) ─────────────────────────────────────────────────────────────

Team = Literal["HOME", "AWAY"]
Lane = Literal["LEFT", "CENTER", "RIGHT"]
HalfName = Literal["1H", "2H", "ET1", "ET2"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TimeRef(_Strict):
    half: HalfName
    clock: str = Field(min_length=3, max_length=12, description="경기 시계. 'mm:ss' 또는 추가시간 '45+2:10'·'90+3:00'")


class AddShotOp(_Strict):
    op: Literal["add_shot"]
    team: Team
    at: TimeRef
    shot_x: float = Field(ge=52.5, le=105, description="공격 방향 기준 x(m). 상대 골라인 105")
    shot_y: float = Field(ge=0, le=68)
    xg: float | None = Field(default=None, ge=0, le=1, description="비우면 위치로 계산(라이브 입력과 같은 식)")
    is_goal: bool = False
    is_on_target: bool = False
    is_own_goal: bool = False
    player_number: str | None = Field(default=None, max_length=20)
    player_name: str | None = Field(default=None, max_length=80)
    goalmouth_x: float | None = Field(default=None, ge=0, le=1)
    goalmouth_y: float | None = Field(default=None, ge=0, le=1)
    is_header: bool = False
    is_weak_foot: bool = False
    under_pressure: bool = False
    one_on_one: bool = False
    shot_pace_band: Literal["LOW", "MID", "HIGH"] = "MID"
    allow_duplicate: bool = False


class AddAttackLaneOp(_Strict):
    op: Literal["add_attack_lane"]
    team: Team
    lane: Lane
    at: TimeRef
    allow_duplicate: bool = False


class EventSet(_Strict):
    at: TimeRef | None = None
    team: Team | None = None
    lane: Lane | None = None
    xg: float | None = Field(default=None, ge=0, le=1)
    is_goal: bool | None = None
    is_on_target: bool | None = None
    is_own_goal: bool | None = None
    player_number: str | None = Field(default=None, max_length=20)
    player_name: str | None = Field(default=None, max_length=80)
    clear_player: bool = False
    shot_x: float | None = Field(default=None, ge=52.5, le=105)
    shot_y: float | None = Field(default=None, ge=0, le=68)
    goalmouth_x: float | None = Field(default=None, ge=0, le=1)
    goalmouth_y: float | None = Field(default=None, ge=0, le=1)
    is_header: bool | None = None
    is_weak_foot: bool | None = None
    under_pressure: bool | None = None
    one_on_one: bool | None = None
    shot_pace_band: Literal["LOW", "MID", "HIGH"] | None = None


class UpdateEventOp(_Strict):
    op: Literal["update_event"]
    event_id: UUID
    set: EventSet
    allow_duplicate: bool = False


class DeleteEventOp(_Strict):
    op: Literal["delete_event"]
    event_id: UUID


class SetPeriodStartOp(_Strict):
    op: Literal["set_period_start"]
    period: Literal["2H", "ET1", "ET2"]
    previous_period_clock: str = Field(min_length=3, max_length=12,
                                       description="그 하프가 시작될 때 앞 하프 시계가 가리킨 값. 예: 2H 시작 = '45+2:30'")


class ShiftEventsOp(_Strict):
    op: Literal["shift_events"]
    half: HalfName
    from_clock: str = Field(min_length=3, max_length=12)
    to_clock: str = Field(min_length=3, max_length=12)
    delta_seconds: int = Field(ge=-300, le=300)
    types: list[Literal["XG", "ATTACK_LANE"]] = Field(default_factory=lambda: ["XG", "ATTACK_LANE"], min_length=1)


class SetPossessionTeamOp(_Strict):
    op: Literal["set_possession_team"]
    segment_id: UUID
    team: Team


class MovePossessionBoundaryOp(_Strict):
    op: Literal["move_possession_boundary"]
    segment_id: UUID = Field(description="앞 구간 id. 이 구간의 끝(=바로 뒤 구간의 시작)을 옮긴다")
    new_end: TimeRef


class RenameMatchOp(_Strict):
    op: Literal["rename_match"]
    name: str = Field(min_length=1, max_length=120)


Op = Annotated[Union[AddShotOp, AddAttackLaneOp, UpdateEventOp, DeleteEventOp, SetPeriodStartOp, ShiftEventsOp,
                     SetPossessionTeamOp, MovePossessionBoundaryOp, RenameMatchOp], Field(discriminator="op")]


class PlanRequest(_Strict):
    request_summary: str = Field(min_length=2, max_length=500, description="직원이 요청한 내용 요약(감사에 남는다)")
    ops: list[Op] = Field(min_length=1, max_length=MAX_ITEMS)


# ── 경기 읽기 공통 ────────────────────────────────────────────────────────────

def _load_match(db: Session, match_id: UUID, *, for_update: bool = False) -> Match:
    query = db.query(Match).filter(Match.id == match_id)
    if for_update:
        query = query.with_for_update()
    match_obj = query.first()
    sport = str(getattr(match_obj, "sport", "") or "FOOTBALL").upper() if match_obj else ""
    if not match_obj or sport not in {"FOOTBALL", "FUTSAL"}:
        # 농구는 이번 범위 밖 — 있는지조차 알려 주지 않는다.
        raise HTTPException(404, "경기를 찾을 수 없습니다.")
    return match_obj


def _team_names(match_obj: Match) -> dict:
    try:
        names = _core()._team_names_from_match(match_obj)
        return {"HOME": names.get("HOME") or "홈", "AWAY": names.get("AWAY") or "어웨이"}
    except Exception:
        meta = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
        return {"HOME": meta.get("home_team") or "홈", "AWAY": meta.get("away_team") or "어웨이"}


def _lineups(match_obj: Match) -> dict:
    meta = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
    teams = ((meta.get("lineups") or {}).get("teams") or {}) if isinstance(meta.get("lineups"), dict) else {}
    out = {}
    for side in ("HOME", "AWAY"):
        rows = teams.get(side) if isinstance(teams.get(side), list) else []
        out[side] = [{"number": str(p.get("number") or "").strip(), "name": str(p.get("name") or "").strip(),
                      "position": p.get("position"), "is_substitute": bool(p.get("isSubstitute"))}
                     for p in rows if isinstance(p, dict)]
    return out


def _match_mode(match_obj: Match) -> str:
    return "ARCHIVED" if match_obj.archived else "LIVE"


def _latest_state(db: Session, match_id: UUID) -> State | None:
    return _core()._latest_state(match_id, db)


def _status(match_obj: Match, state: State | None) -> str:
    if match_obj.archived:
        return "ARCHIVED"
    if state is None:
        return "SCHEDULED"
    if state.running:
        return "LIVE"
    return "PAUSED" if state.clock_ms > 0 else "SCHEDULED"


def _operator_name(db: Session, match_obj: Match) -> str | None:
    if not match_obj.operator_id:
        return None
    user = db.get(User, match_obj.operator_id)
    return user.name if user else None


def _score(events) -> dict:
    return {side: sum(1 for e in events if e.type == "XG" and e.is_goal and e.team == side) for side in ("HOME", "AWAY")}


def _shot_stats(events) -> dict:
    out = {}
    for side in ("HOME", "AWAY"):
        rows = [e for e in events if e.type == "XG" and e.team == side and not e.is_own_goal]
        out[side] = {"shots": len(rows), "on_target": sum(1 for e in rows if e.is_on_target),
                     "xg": round(sum(float(e.xg or 0) for e in rows), 2),
                     "attack_lanes": sum(1 for e in events if e.type == "ATTACK_LANE" and e.team == side)}
    return out


def _possession_pct(segments, current_clock: int) -> dict:
    home, away = _core()._accumulate_possession_ms(list(segments), current_clock)
    total = home + away
    return {"home_pct": round(home / total * 100, 1) if total else 0.0,
            "away_pct": round(away / total * 100, 1) if total else 0.0}


def _event_view(e, ctx: ClockContext, names: dict) -> dict:
    when = ctx.describe(e.clock_ms)
    out = {"event_id": str(e.id), "type": e.type, "team": e.team, "team_name": names.get(e.team),
           **{k: when[k] for k in ("half", "clock", "label", "raw_clock_ms")}}
    if e.type == "ATTACK_LANE":
        out["lane"] = e.lane
    else:
        out.update({"xg": e.xg, "xgot": e.xgot, "is_goal": bool(e.is_goal), "is_own_goal": bool(e.is_own_goal),
                    "is_on_target": bool(e.is_on_target), "player_number": e.player_number, "player_name": e.player_name,
                    "shot_x": e.shot_x, "shot_y": e.shot_y, "goalmouth_x": e.goalmouth_x, "goalmouth_y": e.goalmouth_y,
                    "is_header": bool(e.is_header), "is_weak_foot": bool(e.is_weak_foot),
                    "under_pressure": bool(e.under_pressure), "one_on_one": bool(e.one_on_one),
                    "shot_pace_band": e.shot_pace_band})
    out["recorded_at"] = _kst(e.created_at) if isinstance(e.created_at, datetime) else None
    return out


def _event_kind_label(e) -> str:
    if e.type == "ATTACK_LANE":
        return "공격방향"
    if e.is_own_goal:
        return "자책골"
    if e.is_goal:
        return "골"
    return "유효슈팅" if e.is_on_target else "슈팅"


def _event_line(e, ctx: ClockContext, names: dict) -> str:
    when = ctx.describe(e.clock_ms)["label"]
    parts = [_event_kind_label(e), f"{names.get(e.team, e.team)}({'홈' if e.team == 'HOME' else '어웨이'})", when]
    if e.type == "ATTACK_LANE":
        parts.append({"LEFT": "왼쪽", "CENTER": "가운데", "RIGHT": "오른쪽"}.get(e.lane or "", str(e.lane)))
    else:
        if e.player_number:
            parts.append(f"{e.player_number}번 {e.player_name or ''}".strip())
        parts.append(f"xG {float(e.xg or 0):.2f}")
    return " · ".join(parts)


def _record_fingerprint(events, markers, segments) -> str:
    rows = sorted([_snap(e, EVENT_COLS) for e in events], key=lambda r: r["id"])
    rows += sorted([_snap(m, MARKER_COLS) for m in markers], key=lambda r: r["id"])
    rows += sorted([_snap(s, SEGMENT_COLS) for s in segments], key=lambda r: r["id"])
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()[:16]


def _load_record(db: Session, match_id: UUID):
    events = db.query(Event).filter(Event.match_id == match_id).all()
    markers = db.query(MatchMarker).filter(MatchMarker.match_id == match_id).all()
    segments = db.query(PossessionSegment).filter(PossessionSegment.match_id == match_id).all()
    return events, markers, segments


# ── 읽기 라우트 ───────────────────────────────────────────────────────────────

def _envelope(data, **extra) -> dict:
    return {"timezone": "Asia/Seoul", "data": data, **extra}


@router.get("/api/agent/fla/me")
def agent_me(principal: AgentPrincipal = Depends(_agent_principal), db: Session = Depends(get_db)):
    day = _kst_day_start_utc()
    used = _daily_writes(db, principal.token.id, day)
    return _envelope({"name": principal.user.name, "token_id": principal.token.id, "label": principal.token.label,
                      "scopes": principal.token.scopes, "expires_at": _kst(principal.token.expires_at),
                      "limits": {"calls_per_minute": RATE_PER_MINUTE, "writes_per_minute": WRITE_RATE_PER_MINUTE,
                                 "writes_per_day": DAILY_WRITES, "writes_used_today": used,
                                 "plans_per_day": DAILY_PLANS, "items_per_plan": MAX_ITEMS,
                                 "plan_ttl_seconds": PLAN_TTL_SECONDS, "live_settle_seconds": LIVE_SETTLE_SECONDS}})


@router.get("/api/agent/fla/rules")
def agent_rules(_p: AgentPrincipal = Depends(read_principal)):
    return _envelope({"version": RULES_VERSION, "markdown": RULES_PATH.read_text(encoding="utf-8"),
                      "limits": {"items_per_plan": MAX_ITEMS, "plan_ttl_seconds": PLAN_TTL_SECONDS,
                                 "writes_per_day": DAILY_WRITES, "live_settle_seconds": LIVE_SETTLE_SECONDS,
                                 "stoppage_max_minutes": STOPPAGE_MAX_MS // 60_000,
                                 "duplicate_window_seconds": DUPLICATE_WINDOW_MS // 1000},
                      "ops": sorted(["add_shot", "add_attack_lane", "update_event", "delete_event", "set_period_start",
                                     "shift_events", "set_possession_team", "move_possession_boundary", "rename_match"]),
                      "forbidden_ops": FORBIDDEN_OPS})


@router.get("/api/agent/fla/matches")
def agent_list_matches(
    q: str | None = Query(default=None, max_length=80, description="경기 이름·팀 이름 일부"),
    competition_class: str | None = Query(default=None, max_length=40),
    round_number: int | None = Query(default=None, ge=1, le=99),
    status: Literal["ARCHIVED", "LIVE", "PAUSED", "SCHEDULED", "NOT_ARCHIVED"] | None = None,
    date_from: str | None = Query(default=None, description="경기 생성일(KST) 이상, YYYY-MM-DD"),
    date_to: str | None = Query(default=None, description="경기 생성일(KST) 이하, YYYY-MM-DD"),
    sport: Literal["FOOTBALL", "FUTSAL"] | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _p: AgentPrincipal = Depends(read_principal),
    db: Session = Depends(get_db),
):
    query = db.query(Match).filter(Match.sport.in_([sport] if sport else ["FOOTBALL", "FUTSAL"]))
    if q:
        query = query.filter(Match.name.ilike(f"%{q.strip()}%"))
    if competition_class:
        query = query.filter(Match.competition_class == competition_class.strip().upper())
    if round_number:
        query = query.filter(Match.round_number == round_number)
    for value, op in ((date_from, "ge"), (date_to, "le")):
        if value:
            try:
                day = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=KST)
            except ValueError:
                raise HTTPException(422, "날짜는 YYYY-MM-DD 로 적습니다.")
            if op == "le":
                day += timedelta(days=1)
            bound = day.astimezone(timezone.utc).replace(tzinfo=None)
            query = query.filter(Match.created_at >= bound if op == "ge" else Match.created_at < bound)
    if status == "ARCHIVED":
        query = query.filter(Match.archived.is_(True))
    elif status:
        query = query.filter(Match.archived.is_(False))
    rows = query.order_by(Match.created_at.desc()).all()
    ids = [r.id for r in rows]
    latest: dict = {}
    goals: dict = {}
    if ids:
        sub = (db.query(State.match_id, func.max(State.created_at).label("at"))
               .filter(State.match_id.in_(ids)).group_by(State.match_id).subquery())
        for st in db.query(State).join(sub, (State.match_id == sub.c.match_id) & (State.created_at == sub.c.at)).all():
            latest[st.match_id] = st
        for mid, team, count in (db.query(Event.match_id, Event.team, func.count())
                                 .filter(Event.match_id.in_(ids), Event.type == "XG", Event.is_goal.is_(True))
                                 .group_by(Event.match_id, Event.team).all()):
            goals.setdefault(mid, {})[team] = count
    items = []
    for row in rows:
        st = latest.get(row.id)
        current = _status(row, st)
        if status and status not in {"ARCHIVED", "NOT_ARCHIVED"} and current != status:
            continue
        names = _team_names(row)
        items.append({"match_id": str(row.id), "name": row.name, "sport": row.sport,
                      "competition_class": row.competition_class, "round_number": row.round_number,
                      "home_team": names["HOME"], "away_team": names["AWAY"], "status": current,
                      "score": {"HOME": goals.get(row.id, {}).get("HOME", 0), "AWAY": goals.get(row.id, {}).get("AWAY", 0)},
                      "clock_ms": st.clock_ms if st else 0, "archived_at": _kst(row.archived_at),
                      "created_at": _kst(row.created_at), "locked_by_operator": bool(row.operator_id)})
    total = len(items)
    return _envelope(items[offset:offset + limit], total=total, limit=limit, offset=offset)


@router.get("/api/agent/fla/schedule")
def agent_schedule(
    date_from: str | None = Query(default=None, description="YYYY-MM-DD"),
    date_to: str | None = Query(default=None, description="YYYY-MM-DD"),
    league: str | None = Query(default=None, max_length=80),
    team: str | None = Query(default=None, max_length=80),
    limit: int = Query(default=100, ge=1, le=500),
    _p: AgentPrincipal = Depends(read_principal),
    db: Session = Depends(get_db),
):
    query = db.query(ScheduleEntry)
    if date_from:
        query = query.filter(ScheduleEntry.match_date >= date_from)
    if date_to:
        query = query.filter(ScheduleEntry.match_date <= date_to)
    if league:
        query = query.filter(ScheduleEntry.league.ilike(f"%{league.strip()}%"))
    if team:
        query = query.filter(or_(ScheduleEntry.home_team.ilike(f"%{team.strip()}%"), ScheduleEntry.away_team.ilike(f"%{team.strip()}%")))
    rows = query.order_by(ScheduleEntry.match_date.asc(), ScheduleEntry.kickoff_time.asc()).limit(limit).all()
    return _envelope([{"id": str(r.id), "league": r.league, "round": r.round_label, "date": r.match_date,
                       "kickoff": r.kickoff_time, "home_team": r.home_team, "away_team": r.away_team,
                       "fla_staff": r.fla_staff, "fpa_home_staff": r.fpa_home_staff, "fpa_away_staff": r.fpa_away_staff}
                      for r in rows])


def _previous_period_clock(ctx: ClockContext, period: str | None, raw: int) -> str | None:
    if period not in HALVES or period == "1H":
        return None
    return ctx.clock_in(HALVES[HALVES.index(period) - 1], raw)


def _match_detail(db: Session, match_obj: Match) -> dict:
    events, markers, segments = _load_record(db, match_obj.id)
    ctx = ClockContext(match_obj, _marker_map(markers))
    st = _latest_state(db, match_obj.id)
    names = _team_names(match_obj)
    core = _core()
    broadcast = core._broadcast_state(match_obj)
    manual = broadcast.get("home_score") is not None or broadcast.get("away_score") is not None
    mode = _match_mode(match_obj)
    return {
        "match_id": str(match_obj.id), "name": match_obj.name, "sport": match_obj.sport,
        "competition_class": match_obj.competition_class, "round_number": match_obj.round_number,
        "home_team": names["HOME"], "away_team": names["AWAY"], "status": _status(match_obj, st), "edit_mode": mode,
        "writable": str(match_obj.sport or "").upper() == "FOOTBALL",
        "halves": {h: {"base": _fmt_mmss(ctx.base[h]), "minutes": ctx.length[h] // 60_000,
                       "started": ctx.start(h) is not None,
                       "start_raw_clock_ms": ctx.start(h)} for h in HALVES},
        "markers": [{"marker_id": str(m.id), "type": m.marker_type, "period": HALF_FOR_MARKER.get(m.marker_type),
                     "raw_clock_ms": m.clock_ms,
                     "previous_period_clock": _previous_period_clock(ctx, HALF_FOR_MARKER.get(m.marker_type), m.clock_ms)}
                    for m in markers],
        "current_clock": ctx.describe(st.clock_ms) if st else None,
        "clock_running": bool(st and st.running),
        "score": _score(events), "stats": _shot_stats(events),
        "possession": _possession_pct(segments, st.clock_ms if st else 0),
        "broadcast_manual_score": {"active": manual, "home": broadcast.get("home_score"), "away": broadcast.get("away_score")},
        "operator": {"locked": bool(match_obj.operator_id), "name": _operator_name(db, match_obj)},
        "lineups": _lineups(match_obj),
        "record_fingerprint": _record_fingerprint(events, markers, segments),
        "archived_at": _kst(match_obj.archived_at), "created_at": _kst(match_obj.created_at),
    }


@router.get("/api/agent/fla/matches/{match_id}")
def agent_get_match(match_id: UUID, _p: AgentPrincipal = Depends(read_principal), db: Session = Depends(get_db)):
    return _envelope(_match_detail(db, _load_match(db, match_id)))


@router.get("/api/agent/fla/matches/{match_id}/timeline")
def agent_timeline(
    match_id: UUID,
    type: Literal["XG", "ATTACK_LANE"] | None = None,
    team: Team | None = None,
    half: HalfName | None = None,
    goals_only: bool = False,
    _p: AgentPrincipal = Depends(read_principal),
    db: Session = Depends(get_db),
):
    match_obj = _load_match(db, match_id)
    events, markers, segments = _load_record(db, match_id)
    ctx = ClockContext(match_obj, _marker_map(markers))
    names = _team_names(match_obj)
    rows = sorted(events, key=lambda e: (e.clock_ms, e.created_at or datetime.min, str(e.id)))
    out = []
    for e in rows:
        if type and e.type != type or team and e.team != team or goals_only and not e.is_goal:
            continue
        view = _event_view(e, ctx, names)
        if half and view["half"] != half:
            continue
        out.append(view)
    poss = []
    for s in sorted(segments, key=lambda r: (r.start_ms, r.created_at or datetime.min, str(r.id))):
        start = ctx.describe(s.start_ms)
        poss.append({"segment_id": str(s.id), "team": s.team, "team_name": names.get(s.team),
                     "start": start["label"], "start_raw_clock_ms": s.start_ms,
                     "end": ctx.describe(s.end_ms)["label"] if s.end_ms is not None else None,
                     "end_raw_clock_ms": s.end_ms, "open": s.end_ms is None,
                     "seconds": round(((s.end_ms or s.start_ms) - s.start_ms) / 1000, 1)})
    if half:
        poss = [p for p in poss if ctx.half_of(p["start_raw_clock_ms"]) == half]
    return _envelope({"match_id": str(match_id), "events": out, "possession_segments": poss,
                      "markers": [{"marker_id": str(m.id), "type": m.marker_type, "raw_clock_ms": m.clock_ms} for m in markers],
                      "record_fingerprint": _record_fingerprint(events, markers, segments)})


@router.get("/api/agent/fla/matches/{match_id}/result")
def agent_result(match_id: UUID, _p: AgentPrincipal = Depends(read_principal), db: Session = Depends(get_db)):
    match_obj = _load_match(db, match_id)
    core = _core()
    result = core.get_match_result(match_id, db)
    summary = core._build_match_summary(match_id, db)
    dominance = core._build_dominance(match_id, 180, db)
    events, _markers, _segments = _load_record(db, match_id)
    return _envelope({"match_id": str(match_id), "name": match_obj.name,
                      "result": result.model_dump() if hasattr(result, "model_dump") else result,
                      "score": _score(events), "stats": _shot_stats(events),
                      "possession": summary.get("possession"), "attack_lanes": summary.get("lanes"),
                      "dominance": dominance})


# ── plan / apply / revert ──────────────────────────────────────────────────────

class _Virtual:
    """DB 를 건드리지 않고 ops 를 차례로 적용해 보는 작업판."""

    def __init__(self, db: Session, match_obj: Match):
        self.db = db
        self.match = match_obj
        events, markers, segments = _load_record(db, match_obj.id)
        self.orig: dict[str, dict | None] = {}
        self.events = {str(e.id): _copy(Event, e, EVENT_COLS) for e in events}
        self.markers = {str(m.id): _copy(MatchMarker, m, MARKER_COLS) for m in markers}
        self.segments = {str(s.id): _copy(PossessionSegment, s, SEGMENT_COLS) for s in segments}
        for e in events:
            self.orig[f"event:{e.id}"] = _snap(e, EVENT_COLS)
        for m in markers:
            self.orig[f"marker:{m.id}"] = _snap(m, MARKER_COLS)
        for s in segments:
            self.orig[f"possession:{s.id}"] = _snap(s, SEGMENT_COLS)
        self.orig_events = [_copy(Event, e, EVENT_COLS) for e in events]
        self.orig_segments = [_copy(PossessionSegment, s, SEGMENT_COLS) for s in segments]
        self.orig_ctx = ClockContext(match_obj, _marker_map(markers))
        meta = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
        self.match_info = {"name": match_obj.name, "competition_class": match_obj.competition_class,
                           "round_number": match_obj.round_number, "home_team": meta.get("home_team"),
                           "away_team": meta.get("away_team")}
        self.orig[f"match:{match_obj.id}"] = dict(self.match_info)
        self.touched: list[str] = []
        self.lines: list[dict] = []
        self.warnings: list[dict] = []
        self.live = not match_obj.archived
        st = _latest_state(db, match_obj.id)
        self.current_clock = st.clock_ms if st else 0
        self.names = _team_names(match_obj)
        self.lineups = _lineups(match_obj)
        self.now = _utcnow()

    def ctx(self) -> ClockContext:
        return ClockContext(self.match, _marker_map(list(self.markers.values())))

    def touch(self, key: str):
        if key not in self.touched:
            self.touched.append(key)

    def warn(self, code: str, message: str, **extra):
        if not any(w["code"] == code and w["message"] == message for w in self.warnings):
            self.warnings.append({"code": code, "message": message, **extra})

    # 진행 중 경기 보호
    def guard_live_time(self, raw: int, what: str):
        if self.live and raw > self.current_clock:
            raise RuleError("LIVE_FUTURE_TIME", f"{what}: 진행 중 경기는 지금 시계({self.ctx().describe(self.current_clock)['label']})보다 뒤를 고칠 수 없습니다.")

    def guard_live_settled(self, row, what: str):
        if not self.live:
            return
        created = row.created_at if isinstance(row.created_at, datetime) else None
        if created and self.now - created < timedelta(seconds=LIVE_SETTLE_SECONDS):
            raise RuleError("LIVE_TOO_RECENT", f"{what}: 방금 들어온 기록입니다. {LIVE_SETTLE_SECONDS}초 뒤에 다시 plan 하세요(운영자 화면이 저장을 확인하는 중).")


def _resolve_player(v: _Virtual, team: str, number: str | None, name: str | None) -> tuple[str | None, str | None]:
    number = (number or "").strip() or None
    name = (name or "").strip() or None
    lineup = v.lineups.get(team) or []
    if number is None:
        if name:
            raise RuleError("NAME_WITHOUT_NUMBER", "선수 이름만으로는 넣지 않습니다. 등번호를 함께 주세요.")
        return None, None
    if not lineup:
        v.warn("NO_LINEUP", f"{v.names[team]} 라인업이 없어 등번호 {number} 를 확인하지 못했습니다(입력값 그대로 저장).")
        return number, name
    match = next((p for p in lineup if p["number"] == number), None)
    if match is None:
        raise RuleError("NUMBER_NOT_IN_LINEUP", f"{v.names[team]} 라인업에 {number}번이 없습니다.",
                        lineup_numbers=[p["number"] for p in lineup])
    if name and name != match["name"]:
        raise RuleError("NAME_MISMATCH", f"{number}번은 라인업에 '{match['name']}' 입니다(받은 이름 '{name}').")
    return number, match["name"] or name


def _check_shot_shape(fields: dict):
    if fields["is_own_goal"]:
        fields.update(is_goal=True, is_on_target=False, xg=0.0, player_number=None, player_name=None,
                      goalmouth_x=None, goalmouth_y=None, is_header=False, under_pressure=False, one_on_one=False)
        return
    if fields["is_goal"] and not fields["is_on_target"]:
        raise RuleError("GOAL_NOT_ON_TARGET", "골은 유효슈팅이어야 합니다(is_on_target=true).")
    if fields["is_on_target"] and (fields.get("goalmouth_x") is None or fields.get("goalmouth_y") is None):
        raise RuleError("GOALMOUTH_REQUIRED", "유효슈팅·골은 골문 도착 위치(goalmouth_x·goalmouth_y, 0~1)가 필요합니다.")
    if not fields["is_on_target"]:
        fields.update(goalmouth_x=None, goalmouth_y=None)


def _editor_body(event: Event | None, fields: dict):
    """main.TimelineEditorUpsertRequest 를 만들어 기록 수정 화면과 같은 함수로 값을 채운다."""
    from .schemas import TimelineEditorUpsertRequest
    return TimelineEditorUpsertRequest(kind="EVENT", **fields)


def _apply_event_fields(v: _Virtual, event: Event, fields: dict):
    core = _core()
    if fields["type"] == "XG":
        body = _editor_body(event, {k: fields.get(k) for k in (
            "type", "clock_ms", "team", "xg", "player_name", "player_number", "is_goal", "is_on_target", "shot_x",
            "shot_y", "goalmouth_x", "goalmouth_y", "is_header", "is_weak_foot", "under_pressure", "one_on_one",
            "shot_pace_band", "is_own_goal")})
    else:
        body = _editor_body(event, {"type": "ATTACK_LANE", "clock_ms": fields["clock_ms"], "team": fields["team"],
                                    "lane": fields["lane"]})
    try:
        core._apply_editor_item_updates(event=event, marker=None, body=body)
    except HTTPException as exc:
        raise RuleError("EDITOR_REJECTED", str(exc.detail))


def _dup_check(v: _Virtual, target: Event, allow: bool):
    for other in v.events.values():
        if str(other.id) == str(target.id) or other.type != target.type or other.team != target.team:
            continue
        if abs(other.clock_ms - target.clock_ms) <= DUPLICATE_WINDOW_MS and (target.type == "XG" or other.lane == target.lane):
            if allow:
                v.warn("DUPLICATE_ALLOWED", f"같은 팀·같은 종류 기록이 3초 안에 이미 있습니다({_event_line(other, v.ctx(), v.names)}) — allow_duplicate 로 진행.")
                return
            raise RuleError("DUPLICATE_SUSPECT", "같은 팀·같은 종류 기록이 3초 안에 이미 있습니다. 중복이면 넣지 말고, 정말 따로 있었던 일이면 직원에게 확인한 뒤 allow_duplicate=true 로 다시 plan 하세요.",
                            existing=_event_view(other, v.ctx(), v.names))


def _event_fields_from(e: Event) -> dict:
    return {c: getattr(e, c) for c in ("type", "clock_ms", "team", "lane", "xg", "player_name", "player_number", "is_goal",
                                       "is_on_target", "is_own_goal", "shot_x", "shot_y", "goalmouth_x", "goalmouth_y",
                                       "is_header", "is_weak_foot", "under_pressure", "one_on_one", "shot_pace_band")}


def _op_add_shot(v: _Virtual, op: AddShotOp):
    ctx = v.ctx()
    raw = ctx.to_raw(op.at.half, op.at.clock)
    v.guard_live_time(raw, "슈팅 추가")
    fields = {"type": "XG", "clock_ms": raw, "team": op.team, "lane": None, "xg": op.xg, "is_goal": op.is_goal,
              "is_on_target": op.is_on_target or op.is_goal, "is_own_goal": op.is_own_goal, "shot_x": op.shot_x,
              "shot_y": op.shot_y, "goalmouth_x": op.goalmouth_x, "goalmouth_y": op.goalmouth_y,
              "is_header": op.is_header, "is_weak_foot": op.is_weak_foot, "under_pressure": op.under_pressure,
              "one_on_one": op.one_on_one, "shot_pace_band": op.shot_pace_band}
    if op.is_own_goal:
        fields["player_number"] = fields["player_name"] = None
    else:
        fields["player_number"], fields["player_name"] = _resolve_player(v, op.team, op.player_number, op.player_name)
    _check_shot_shape(fields)
    if fields["xg"] is None:
        fields["xg"] = float(_core()._estimate_xg("HOME", "L2R", op.shot_x, op.shot_y, op.is_header, op.is_weak_foot)["xg"])
        v.warn("XG_ESTIMATED", f"xG 를 위치로 계산했습니다: {fields['xg']:.3f}")
    event = Event(id=uuid.uuid4(), match_id=v.match.id, type="XG", clock_ms=raw, team=op.team, created_at=v.now)
    _apply_event_fields(v, event, fields)
    _dup_check(v, event, op.allow_duplicate)
    v.events[str(event.id)] = event
    v.orig.setdefault(f"event:{event.id}", None)
    v.touch(f"event:{event.id}")
    v.lines.append({"op": "add_shot", "after": _event_line(event, v.ctx(), v.names)})


def _op_add_lane(v: _Virtual, op: AddAttackLaneOp):
    raw = v.ctx().to_raw(op.at.half, op.at.clock)
    v.guard_live_time(raw, "공격방향 추가")
    event = Event(id=uuid.uuid4(), match_id=v.match.id, type="ATTACK_LANE", clock_ms=raw, team=op.team, created_at=v.now)
    _apply_event_fields(v, event, {"type": "ATTACK_LANE", "clock_ms": raw, "team": op.team, "lane": op.lane})
    _dup_check(v, event, op.allow_duplicate)
    v.events[str(event.id)] = event
    v.orig.setdefault(f"event:{event.id}", None)
    v.touch(f"event:{event.id}")
    v.lines.append({"op": "add_attack_lane", "after": _event_line(event, v.ctx(), v.names)})


def _get_event(v: _Virtual, event_id: UUID) -> Event:
    event = v.events.get(str(event_id))
    if event is None:
        raise RuleError("EVENT_NOT_FOUND", f"이 경기에 기록 {event_id} 가 없습니다. timeline 으로 id 를 다시 확인하세요.")
    return event


def _op_update_event(v: _Virtual, op: UpdateEventOp):
    event = _get_event(v, op.event_id)
    v.guard_live_settled(event, "기록 수정")
    v.guard_live_time(event.clock_ms, "기록 수정")
    before = _event_line(event, v.ctx(), v.names)
    fields = _event_fields_from(event)
    s = op.set
    given = s.model_dump(exclude_unset=True)
    if not given:
        raise RuleError("NOTHING_TO_CHANGE", "set 에 바꿀 값이 없습니다.")
    if s.at is not None:
        fields["clock_ms"] = v.ctx().to_raw(s.at.half, s.at.clock)
        v.guard_live_time(fields["clock_ms"], "기록 수정")
    for key in ("team", "lane", "xg", "is_goal", "is_on_target", "is_own_goal", "shot_x", "shot_y", "goalmouth_x",
                "goalmouth_y", "is_header", "is_weak_foot", "under_pressure", "one_on_one", "shot_pace_band"):
        if key in given and key != "at":
            fields[key] = given[key]
    if event.type == "ATTACK_LANE":
        bad = set(given) - {"at", "team", "lane"}
        if bad:
            raise RuleError("FIELD_NOT_FOR_LANE", f"공격방향 기록에서 바꿀 수 있는 것은 at·team·lane 뿐입니다(받은 값: {sorted(bad)}).")
    else:
        if "lane" in given:
            raise RuleError("FIELD_NOT_FOR_SHOT", "슈팅 기록에는 lane 이 없습니다.")
        if "is_goal" in given and given["is_goal"] and "is_on_target" not in given:
            fields["is_on_target"] = True
        if "is_own_goal" in given and not given["is_own_goal"] and event.is_own_goal and "is_goal" not in given:
            fields["is_goal"] = False  # 자책골 표시만 지우면 골도 아니게 된다 — 골로 남기려면 is_goal 을 함께 준다
        if s.clear_player or fields["is_own_goal"]:
            fields["player_number"] = fields["player_name"] = None
        elif "player_number" in given or "player_name" in given or "team" in given:
            number = given.get("player_number", fields["player_number"])
            name = given.get("player_name") if "player_name" in given else (None if "player_number" in given or "team" in given else fields["player_name"])
            fields["player_number"], fields["player_name"] = _resolve_player(v, fields["team"], number, name)
        if fields.get("xg") is None:
            fields["xg"] = 0.0
        fields["shot_pace_band"] = fields.get("shot_pace_band") or "MID"  # 기록 수정 화면과 같은 기본값
        _check_shot_shape(fields)
    _apply_event_fields(v, event, fields)
    if any(k in given for k in ("at", "team", "lane", "is_goal")):
        _dup_check(v, event, op.allow_duplicate)
    v.touch(f"event:{event.id}")
    v.lines.append({"op": "update_event", "event_id": str(event.id), "before": before, "after": _event_line(event, v.ctx(), v.names)})


def _op_delete_event(v: _Virtual, op: DeleteEventOp):
    event = _get_event(v, op.event_id)
    v.guard_live_settled(event, "기록 삭제")
    v.guard_live_time(event.clock_ms, "기록 삭제")
    line = _event_line(event, v.ctx(), v.names)
    del v.events[str(event.id)]
    v.touch(f"event:{event.id}")
    v.lines.append({"op": "delete_event", "event_id": str(event.id), "before": line, "after": None})


def _op_set_period_start(v: _Virtual, op: SetPeriodStartOp):
    marker_type = MARKER_FOR[op.period]
    existing = sorted([m for m in v.markers.values() if m.marker_type == marker_type], key=lambda m: m.clock_ms)
    previous = HALVES[HALVES.index(op.period) - 1]
    ctx = v.ctx()
    raw = ctx.to_raw(previous, op.previous_period_clock, check_next=False)
    prev_start = ctx.start(previous)
    if prev_start is None or raw <= prev_start:
        raise RuleError("PERIOD_ORDER", f"{op.period} 시작은 {previous} 시작보다 뒤여야 합니다.")
    later = [ctx.start(h) for h in HALVES[HALVES.index(op.period) + 1:] if ctx.start(h) is not None]
    if later and raw >= min(later):
        raise RuleError("PERIOD_ORDER", f"{op.period} 시작은 다음 하프 시작보다 앞이어야 합니다.")
    if v.live:
        if not existing:
            raise RuleError("LIVE_PERIOD_TRANSITION", "진행 중 경기에서 하프 전환(새 시작 표시)은 운영자가 매치 컨트롤에서 합니다.")
        v.guard_live_time(raw, "하프 시작 시각")
        v.guard_live_time(existing[0].clock_ms, "하프 시작 시각")
    old_ctx = ctx
    if existing:
        marker = existing[0]
        before = f"{op.period} 시작 = {previous} {old_ctx.clock_in(previous, marker.clock_ms)}"
    else:
        marker = MatchMarker(id=uuid.uuid4(), match_id=v.match.id, marker_type=marker_type, clock_ms=raw, created_at=v.now)
        v.markers[str(marker.id)] = marker
        v.orig.setdefault(f"marker:{marker.id}", None)
        before = f"{op.period} 시작 표시 없음"
    from .schemas import TimelineEditorUpsertRequest
    try:
        _core()._apply_editor_item_updates(event=None, marker=marker,
                                           body=TimelineEditorUpsertRequest(kind="MARKER", type=marker_type, clock_ms=raw))
    except HTTPException as exc:
        raise RuleError("EDITOR_REJECTED", str(exc.detail))
    new_ctx = v.ctx()
    moved = [e for e in v.events.values() if old_ctx.half_of(e.clock_ms) != new_ctx.half_of(e.clock_ms)]
    shifted = [e for e in v.events.values() if old_ctx.describe(e.clock_ms)["label"] != new_ctx.describe(e.clock_ms)["label"]]
    v.touch(f"marker:{marker.id}")
    v.lines.append({"op": "set_period_start", "before": before, "after": f"{op.period} 시작 = {previous} {op.previous_period_clock}"})
    if moved or shifted:
        v.warn("PERIOD_SHIFT", f"하프가 바뀌는 기록 {len(moved)}건, 표시 시각이 바뀌는 기록 {len(shifted)}건입니다(저장 값은 그대로, 표시만 바뀜).",
               examples=[{"event_id": str(e.id), "before": old_ctx.describe(e.clock_ms)["label"],
                          "after": new_ctx.describe(e.clock_ms)["label"]} for e in shifted[:8]])


def _op_shift(v: _Virtual, op: ShiftEventsOp):
    ctx = v.ctx()
    lo = ctx.to_raw(op.half, op.from_clock)
    hi = ctx.to_raw(op.half, op.to_clock)
    if hi < lo:
        raise RuleError("BAD_RANGE", "from_clock 이 to_clock 보다 뒤입니다.")
    if op.delta_seconds == 0:
        raise RuleError("NOTHING_TO_CHANGE", "delta_seconds 가 0 입니다.")
    delta = op.delta_seconds * 1000
    targets = sorted([e for e in v.events.values() if e.type in op.types and lo <= e.clock_ms <= hi], key=lambda e: e.clock_ms)
    if not targets:
        raise RuleError("NO_TARGETS", "그 범위에 옮길 기록이 없습니다.")
    start, nxt = ctx.start(op.half) or 0, ctx.next_start(op.half)
    for e in targets:
        v.guard_live_settled(e, "시각 일괄 이동")
        new = e.clock_ms + delta
        if new < start or (nxt is not None and new >= nxt):
            raise RuleError("SHIFT_LEAVES_HALF", f"옮기면 {_event_line(e, ctx, v.names)} 가 {op.half} 밖으로 나갑니다. 범위나 초를 줄이세요.")
        v.guard_live_time(new, "시각 일괄 이동")
        e.clock_ms = new
        v.touch(f"event:{e.id}")
    v.lines.append({"op": "shift_events", "before": f"{op.half} {op.from_clock}~{op.to_clock} 기록 {len(targets)}건",
                    "after": f"{'+' if delta > 0 else ''}{op.delta_seconds}초 이동"})
    v.warn("POSSESSION_NOT_SHIFTED", "점유 구간은 함께 옮기지 않습니다(점유율 비율은 그대로). 구간 경계가 문제면 move_possession_boundary 를 쓰세요.")


def _get_segment(v: _Virtual, segment_id: UUID) -> PossessionSegment:
    seg = v.segments.get(str(segment_id))
    if seg is None:
        raise RuleError("SEGMENT_NOT_FOUND", f"이 경기에 점유 구간 {segment_id} 가 없습니다.")
    if seg.end_ms is None:
        raise RuleError("SEGMENT_OPEN", "지금 열려 있는 점유 구간은 운영자가 매치 컨트롤에서 바꿉니다.")
    if v.live and seg.end_ms > v.current_clock:
        raise RuleError("LIVE_FUTURE_TIME", "진행 중 경기에서 지금 시계보다 뒤의 점유 구간은 고칠 수 없습니다.")
    return seg


def _seg_line(v: _Virtual, seg) -> str:
    ctx = v.ctx()
    end = ctx.describe(seg.end_ms)["label"] if seg.end_ms is not None else "진행 중"
    return f"점유 {v.names.get(seg.team, seg.team)} {ctx.describe(seg.start_ms)['label']}~{end}"


def _op_possession_team(v: _Virtual, op: SetPossessionTeamOp):
    seg = _get_segment(v, op.segment_id)
    if seg.team == op.team:
        raise RuleError("NOTHING_TO_CHANGE", "이미 그 팀의 점유 구간입니다.")
    before = _seg_line(v, seg)
    seg.team = op.team
    v.touch(f"possession:{seg.id}")
    v.lines.append({"op": "set_possession_team", "before": before, "after": _seg_line(v, seg)})


def _op_possession_boundary(v: _Virtual, op: MovePossessionBoundaryOp):
    seg = _get_segment(v, op.segment_id)
    raw = v.ctx().to_raw(op.new_end.half, op.new_end.clock)
    nxt = next((s for s in v.segments.values() if s is not seg and s.start_ms == seg.end_ms), None)
    later = [s.start_ms for s in v.segments.values() if s is not seg and s.start_ms > seg.start_ms]
    if raw <= seg.start_ms:
        raise RuleError("BOUNDARY_ORDER", "새 끝 시각은 이 구간의 시작보다 뒤여야 합니다.")
    if nxt is not None:
        if nxt.end_ms is None:
            raise RuleError("SEGMENT_OPEN", "바로 뒤 구간이 지금 열려 있는 점유입니다 — 운영자 몫입니다.")
        if raw >= nxt.end_ms:
            raise RuleError("BOUNDARY_ORDER", "새 끝 시각은 바로 뒤 구간의 끝보다 앞이어야 합니다.")
    elif later and raw > min(later):
        raise RuleError("BOUNDARY_ORDER", "새 끝 시각이 다음 점유 구간의 시작을 넘습니다.")
    v.guard_live_time(raw, "점유 경계 이동")
    before = _seg_line(v, seg) + (f" / {_seg_line(v, nxt)}" if nxt else "")
    seg.end_ms = raw
    v.touch(f"possession:{seg.id}")
    if nxt is not None:
        nxt.start_ms = raw
        v.touch(f"possession:{nxt.id}")
    v.lines.append({"op": "move_possession_boundary", "before": before,
                    "after": _seg_line(v, seg) + (f" / {_seg_line(v, nxt)}" if nxt else "")})


def _op_rename(v: _Virtual, op: RenameMatchOp):
    if v.live:
        raise RuleError("LIVE_RENAME", "진행 중 경기의 이름(팀 이름)은 방송에 바로 나가므로 바꾸지 않습니다. 경기 보관 뒤에 하세요.")
    try:
        name, cls, rnd, home, away = _core()._parse_archived_match_name(v.db, op.name)
    except HTTPException as exc:
        raise RuleError("BAD_MATCH_NAME", str(exc.detail))
    before = v.match_info["name"]
    v.match_info.update(name=name, competition_class=cls, round_number=rnd, home_team=home, away_team=away)
    v.touch(f"match:{v.match.id}")
    v.lines.append({"op": "rename_match", "before": before, "after": name})


OP_HANDLERS = {"add_shot": _op_add_shot, "add_attack_lane": _op_add_lane, "update_event": _op_update_event,
               "delete_event": _op_delete_event, "set_period_start": _op_set_period_start, "shift_events": _op_shift,
               "set_possession_team": _op_possession_team, "move_possession_boundary": _op_possession_boundary,
               "rename_match": _op_rename}


def _current_snapshot(v: _Virtual, key: str) -> dict | None:
    kind, ident = key.split(":", 1)
    if kind == "event":
        row = v.events.get(ident)
        return _snap(row, EVENT_COLS) if row is not None else None
    if kind == "marker":
        row = v.markers.get(ident)
        return _snap(row, MARKER_COLS) if row is not None else None
    if kind == "possession":
        row = v.segments.get(ident)
        return _snap(row, SEGMENT_COLS) if row is not None else None
    return dict(v.match_info)


def _db_snapshot(db: Session, match_obj: Match, key: str) -> dict | None:
    kind, ident = key.split(":", 1)
    if kind == "match":
        meta = match_obj.metadata_json if isinstance(match_obj.metadata_json, dict) else {}
        return {"name": match_obj.name, "competition_class": match_obj.competition_class,
                "round_number": match_obj.round_number, "home_team": meta.get("home_team"), "away_team": meta.get("away_team")}
    model, cols = {"event": (Event, EVENT_COLS), "marker": (MatchMarker, MARKER_COLS),
                   "possession": (PossessionSegment, SEGMENT_COLS)}[kind]
    row = db.get(model, UUID(ident))
    if row is None or str(row.match_id) != str(match_obj.id):
        return None
    return _snap(row, cols)


def _follow_ups(v: _Virtual, items: list[dict], score_before: dict, score_after: dict) -> list[dict]:
    touched_goal = any((it["before"] or {}).get("is_goal") or (it["after"] or {}).get("is_goal")
                       for it in items if it["kind"] == "event")
    touched_shot = any(((it["before"] or {}).get("type") or (it["after"] or {}).get("type")) == "XG"
                       for it in items if it["kind"] == "event")
    out = [{"what": "결과·요약·우세도·CSV·협업사 API·FinePlay 어드민 조회", "auto": True,
            "note": "요청할 때 계산하므로 바로(최대 3초) 반영됩니다."}]
    if v.live:
        out.append({"what": "방송 점수판·오버레이", "auto": True, "note": "3초 안에 바뀝니다."})
        out.append({"what": "중계 그래픽 PNG(실시간 latest)", "auto": True, "note": "다음 60초 갱신 때 바뀝니다."})
        out.append({"what": "중계 그래픽 PNG(15·30·45분 등 이미 만든 보관본)", "auto": False,
                    "todo": "이미 만들어진 시점 그림은 그대로 남습니다. 필요하면 관리자에게 다시 만들어 달라고 하세요."})
    else:
        out.append({"what": "중계 그래픽 PNG(보관된 경기)", "auto": False,
                    "todo": "보관 때 확정된 그림은 자동으로 안 바뀝니다. 필요하면 관리자에게 '중계 그래픽 다시 만들기(finalize)'를 요청하세요."})
    if touched_goal:
        out.append({"what": "골 xG 샷맵 PNG(골마다 1장)", "auto": False,
                    "todo": "골마다 한 번 만들어져 고정됩니다. 고친·지운 골의 그림은 그대로 남으니 관리자에게 알리세요."})
        out.append({"what": "녹화 영상 중계 그래픽 편집(오버레이 프로젝트)", "auto": False,
                    "todo": "이 골이 큐로 들어간 프로젝트가 있으면 편집 화면에서 확인하세요."})
    if touched_shot:
        out.append({"what": "FCM 골키퍼 카드", "auto": False,
                    "todo": "슈팅·유효슈팅 수가 카드에 들어갑니다. 이미 만든 카드는 다시 만드세요."})
    out.append({"what": "FHL(하이라이트 PC 앱) 하이라이트 로그", "auto": False,
                "todo": "이미 내려받은 로그 파일은 그대로입니다. 다시 내려받으세요."})
    out.append({"what": "협업사 웹훅", "auto": False, "todo": "수정은 웹훅으로 나가지 않습니다(협업사가 다시 조회하면 반영)."})
    out.append({"what": "FinePlay 전송(분석 결과·대회 인입)", "auto": True,
                "note": "FLA 기록을 보내지 않으므로 영향이 없습니다(클립·FPA 기준)."})
    return out


def _build_plan(db: Session, match_obj: Match, ops: list) -> dict:
    v = _Virtual(db, match_obj)
    errors = []
    for index, op in enumerate(ops):
        try:
            OP_HANDLERS[op.op](v, op)
        except RuleError as exc:
            errors.append({"op_index": index, "op": op.op, **exc.as_dict()})
            break  # 앞 단계가 틀리면 뒤 단계 결과는 의미가 없다
    if errors:
        return {"ok": False, "errors": errors}
    items = []
    for key in v.touched:
        before, after = v.orig.get(key), _current_snapshot(v, key)
        if before == after:
            continue
        kind = key.split(":", 1)[0]
        action = "create" if before is None else "delete" if after is None else "update"
        items.append({"key": key, "kind": kind, "action": action, "before": before, "after": after,
                      "before_fp": _fp(before), "after_fp": _fp(after)})
    if not items:
        return {"ok": False, "errors": [{"code": "NOTHING_TO_CHANGE", "message": "바뀌는 것이 없습니다."}]}
    if len(items) > MAX_ITEMS:
        return {"ok": False, "errors": [{"code": "TOO_MANY_ITEMS", "message": f"한 번에 {MAX_ITEMS}건까지 바꿀 수 있습니다(이번 {len(items)}건). 범위를 나누세요."}]}
    new_events = list(v.events.values())
    score_before, score_after = _score(v.orig_events), _score(new_events)
    stats_before, stats_after = _shot_stats(v.orig_events), _shot_stats(new_events)
    poss_before = _possession_pct(v.orig_segments, v.current_clock)
    poss_after = _possession_pct(list(v.segments.values()), v.current_clock)
    broadcast = _core()._broadcast_state(match_obj)
    if score_before != score_after:
        msg = f"점수가 {score_before['HOME']}:{score_before['AWAY']} → {score_after['HOME']}:{score_after['AWAY']} 로 바뀝니다."
        if v.live:
            v.warn("LIVE_BROADCAST_SCORE", "방송 점수판에 바로 나갑니다. " + msg + " 운영자와 먼저 말을 맞춘 뒤 apply 하세요.")
        else:
            v.warn("SCORE_CHANGE", msg)
        if broadcast.get("home_score") is not None or broadcast.get("away_score") is not None:
            v.warn("BROADCAST_MANUAL_SCORE", f"점수판은 수동 점수({broadcast.get('home_score')}:{broadcast.get('away_score')})를 쓰고 있어 이 수정으로 바뀌지 않습니다. 운영자가 점수판 점수를 직접 맞춰야 합니다.")
    if v.live and (stats_before != stats_after or poss_before != poss_after):
        v.warn("LIVE_BROADCAST_GRAPHICS", "중계 그래픽(슈팅·xG·공격방향·점유율)이 다음 갱신(최대 60초) 때 바뀝니다.")
    if v.live and match_obj.operator_id:
        v.warn("OPERATOR_ACTIVE", f"운영자 {_operator_name(db, match_obj) or ''}님이 이 경기를 입력 중입니다. 운영자 화면에 수정 알림이 뜹니다.".replace("  ", " "))
    labels = [line.get("after") or line.get("before") for line in v.lines]
    summary = _summary(v, items, labels)
    return {"ok": True, "live": v.live, "items": items, "lines": v.lines, "warnings": v.warnings, "summary": summary,
            "score": {"before": score_before, "after": score_after}, "stats": {"before": stats_before, "after": stats_after},
            "possession": {"before": poss_before, "after": poss_after},
            "follow_ups": _follow_ups(v, items, score_before, score_after),
            "current_clock": v.ctx().describe(v.current_clock)["label"] if v.live else None}


def _summary(v: _Virtual, items: list[dict], labels: list[str]) -> str:
    counts: dict[str, int] = {}
    for line in v.lines:
        name = {"add_shot": "슈팅 추가", "add_attack_lane": "공격방향 추가", "update_event": "기록 수정",
                "delete_event": "기록 삭제", "set_period_start": "하프 시작 시각", "shift_events": "시각 일괄 이동",
                "set_possession_team": "점유 팀", "move_possession_boundary": "점유 경계", "rename_match": "경기 이름"}[line["op"]]
        counts[name] = counts.get(name, 0) + 1
    head = " · ".join(f"{k} {n}건" for k, n in counts.items())
    first = next((l for l in labels if l), "")
    when = re.search(r"\b(1H|2H|ET1|ET2) [0-9+:]+", first or "")
    return (head + (f" · {when.group(0)}" if when else ""))[:300]


def _daily_writes(db: Session, token_id: str, day_start: datetime) -> int:
    applied = db.query(func.count(AgentFlaChange.id)).filter(AgentFlaChange.token_id == token_id,
                                                              AgentFlaChange.applied_at >= day_start).scalar() or 0
    reverted = db.query(func.count(AgentFlaChange.id)).filter(AgentFlaChange.reverted_by_token == token_id,
                                                               AgentFlaChange.reverted_at >= day_start).scalar() or 0
    return int(applied) + int(reverted)


def _check_daily_write(db: Session, principal: AgentPrincipal):
    used = _daily_writes(db, principal.token.id, _kst_day_start_utc())
    if used >= DAILY_WRITES:
        raise HTTPException(429, f"오늘 수정 한도({DAILY_WRITES}회)를 다 썼습니다. 급하면 관리자에게 문의하세요.")


def _require_writable(match_obj: Match):
    if str(match_obj.sport or "").upper() != "FOOTBALL":
        raise HTTPException(409, "풋살 경기 기록은 에이전트로 고치지 않습니다(대표에게 문의).")


def _forbidden_op_check(raw_ops) -> None:
    if not isinstance(raw_ops, list):
        return
    for op in raw_ops:
        name = op.get("op") if isinstance(op, dict) else None
        if isinstance(name, str) and name in FORBIDDEN_OPS:
            raise HTTPException(403, f"토큰으로는 할 수 없는 일입니다: {FORBIDDEN_OPS[name]}. 운영자·관리자에게 요청하세요.")


def _change_view(row: AgentFlaChange, *, full: bool = False) -> dict:
    out = {"change_id": row.id, "plan_id": row.id, "match_id": str(row.match_id), "status": row.status, "live": row.live,
           "actor_name": row.actor_name, "summary": row.summary, "request_summary": row.request_summary,
           "created_at": _kst(row.created_at), "expires_at": _kst(row.expires_at) if row.status == "planned" else None,
           "applied_at": _kst(row.applied_at), "reverted_at": _kst(row.reverted_at)}
    if full:
        out.update({"ops": row.ops, "items": row.items, **{k: row.preview.get(k) for k in (
            "lines", "warnings", "score", "stats", "possession", "follow_ups")}})
    return out


@router.post("/api/agent/fla/matches/{match_id}/plan")
def agent_plan(match_id: UUID, raw: dict = Body(...), principal: AgentPrincipal = Depends(write_principal),
               db: Session = Depends(get_db)):
    _forbidden_op_check(raw.get("ops") if isinstance(raw, dict) else None)
    try:
        body = PlanRequest.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(422, json.loads(exc.json(include_url=False)))
    match_obj = _load_match(db, match_id)
    _require_writable(match_obj)
    day = _kst_day_start_utc()
    plans_today = db.query(func.count(AgentFlaChange.id)).filter(AgentFlaChange.token_id == principal.token.id,
                                                                  AgentFlaChange.created_at >= day).scalar() or 0
    if plans_today >= DAILY_PLANS:
        raise HTTPException(429, f"오늘 plan 한도({DAILY_PLANS}회)를 다 썼습니다.")
    result = _build_plan(db, match_obj, body.ops)
    db.rollback()  # 작업판은 DB 에 붙지 않지만, 혹시 남은 변경이 있어도 버린다
    if not result["ok"]:
        _audit(db, principal, "AGENT_FLA_PLAN_REJECTED", match_id=match_id, severity="INFO",
               details={"request_summary": body.request_summary, "errors": result["errors"]})
        db.commit()
        raise HTTPException(422, {"message": "규칙에 맞지 않아 plan 을 만들지 않았습니다.", "errors": result["errors"]})
    now = _utcnow()
    row = AgentFlaChange(token_id=principal.token.id, user_id=principal.user.id, actor_name=principal.user.name,
                         match_id=match_id, status="planned", live=result["live"], request_summary=body.request_summary,
                         summary=result["summary"], ops=[op.model_dump(mode="json") for op in body.ops],
                         items=result["items"], preview={k: result[k] for k in (
                             "lines", "warnings", "score", "stats", "possession", "follow_ups", "current_clock")},
                         created_at=now, expires_at=now + timedelta(seconds=PLAN_TTL_SECONDS))
    db.add(row)
    db.commit()
    return _envelope({"plan_id": row.id, "expires_at": _kst(row.expires_at), "live": row.live, "summary": row.summary,
                      "changes": result["lines"], "item_count": len(result["items"]),
                      "items": [{"key": it["key"], "action": it["action"], "before": it["before"], "after": it["after"]}
                                for it in result["items"]],
                      "score": result["score"], "stats": result["stats"], "possession": result["possession"],
                      "warnings": result["warnings"], "follow_ups": result["follow_ups"],
                      "next": "직원에게 changes·score·warnings 를 보여 주고 '적용할까요?' 확인을 받은 뒤 apply 하세요."})


def _write_snapshot(db: Session, match_obj: Match, key: str, snapshot: dict | None, change_id: str):
    kind, ident = key.split(":", 1)
    if kind == "match":
        meta = dict(match_obj.metadata_json or {})
        meta["home_team"], meta["away_team"] = snapshot["home_team"], snapshot["away_team"]
        match_obj.name = snapshot["name"]
        match_obj.competition_class = snapshot["competition_class"]
        match_obj.round_number = snapshot["round_number"]
        match_obj.metadata_json = meta
        return
    model, cols = {"event": (Event, EVENT_COLS), "marker": (MatchMarker, MARKER_COLS),
                   "possession": (PossessionSegment, SEGMENT_COLS)}[kind]
    row = db.get(model, UUID(ident))
    if snapshot is None:
        if row is not None:
            db.delete(row)
            if kind == "event" and db.get(AgentFlaTombstone, UUID(ident)) is None:
                db.add(AgentFlaTombstone(event_id=UUID(ident), match_id=match_obj.id, change_id=change_id))
        return
    values = {c: _restore_value(c, snapshot[c]) for c in cols}
    if row is None:
        db.add(model(**values))
        if kind == "event":
            stone = db.get(AgentFlaTombstone, UUID(ident))
            if stone is not None:
                db.delete(stone)
    else:
        for c in cols:
            if c not in ("id", "match_id", "created_at"):
                setattr(row, c, values[c])


def _finish_write(db: Session, match_obj: Match):
    core = _core()
    db.flush()
    core._rebuild_match_projections(match_obj.id, db)
    core._match_response_cache.clear()
    core._dominance_response_cache.clear()
    core._broadcast_snapshot_cache.clear()


def _stale(db: Session, match_obj: Match, items: list[dict], side: str) -> list[dict]:
    stale = []
    for it in items:
        current = _fp(_db_snapshot(db, match_obj, it["key"]))
        if current != it[f"{side}_fp"]:
            stale.append({"key": it["key"], "expected": it[f"{side}_fp"], "current": current})
    return stale


def _new_input_clashes(db: Session, row: AgentFlaChange) -> list[dict]:
    targets = [it["after"] for it in row.items if it["kind"] == "event" and it["after"] is not None
               and (it["before"] is None or any(it["before"].get(k) != it["after"].get(k) for k in ("clock_ms", "team", "lane", "is_goal")))]
    if not targets:
        return []
    touched = {it["key"].split(":", 1)[1] for it in row.items}
    fresh = db.query(Event).filter(Event.match_id == row.match_id, Event.created_at > row.created_at).all()
    out = []
    for t in targets:
        for e in fresh:
            if str(e.id) in touched or e.type != t["type"] or e.team != t["team"]:
                continue
            if abs(e.clock_ms - t["clock_ms"]) <= DUPLICATE_WINDOW_MS and (t["type"] == "XG" or e.lane == t["lane"]):
                out.append({"planned": t["id"], "new_input": str(e.id), "clock_ms": e.clock_ms})
    return out


@router.post("/api/agent/fla/plans/{plan_id}/apply")
def agent_apply(plan_id: str, principal: AgentPrincipal = Depends(write_principal), db: Session = Depends(get_db)):
    row = db.query(AgentFlaChange).filter(AgentFlaChange.id == plan_id).with_for_update().first()
    if row is None or row.token_id != principal.token.id:
        raise HTTPException(404, "plan 을 찾을 수 없습니다(본인 토큰으로 만든 plan 만 적용할 수 있습니다).")
    if row.status != "planned":
        raise HTTPException(409, f"이미 처리된 plan 입니다(status={row.status}).")
    if row.expires_at <= _utcnow():
        row.status = "expired"
        db.commit()
        raise HTTPException(409, "plan 유효시간이 지났습니다. 다시 plan 하세요.")
    _check_daily_write(db, principal)
    match_obj = _load_match(db, row.match_id, for_update=True)  # 운영자 입력과 같은 잠금 — 순서대로 처리된다
    _require_writable(match_obj)
    if (not match_obj.archived) != row.live:
        raise HTTPException(409, "plan 뒤에 경기 보관 상태가 바뀌었습니다. 다시 plan 하세요.")
    stale = _stale(db, match_obj, row.items, "before")
    if stale:
        _audit(db, principal, "AGENT_FLA_APPLY_REJECTED", match_id=row.match_id, target_id=row.id, severity="WARN",
               details={"reason": "stale_plan", "stale": stale})
        db.commit()
        raise HTTPException(409, {"reason": "stale_plan", "message": "plan 뒤에 고치려던 기록이 바뀌었습니다. 다시 plan 하세요.", "stale": stale})
    # plan 뒤에 들어온 운영자 기록이 이번에 넣는(옮기는) 기록과 겹치면 거부한다. 상관없는 새 입력은 통과.
    clashes = _new_input_clashes(db, row)
    if clashes:
        _audit(db, principal, "AGENT_FLA_APPLY_REJECTED", match_id=row.match_id, target_id=row.id, severity="WARN",
               details={"reason": "new_input_clash", "clashes": clashes})
        db.commit()
        raise HTTPException(409, {"reason": "new_input_clash", "message": "plan 뒤에 운영자가 넣은 기록과 겹칩니다(중복 의심). 다시 plan 하세요.",
                                  "clashes": clashes})
    for it in row.items:
        _write_snapshot(db, match_obj, it["key"], it["after"], row.id)
    _finish_write(db, match_obj)
    row.status = "applied"
    row.applied_at = _utcnow()
    _audit(db, principal, "AGENT_FLA_APPLY", match_id=row.match_id, target_id=row.id, severity="WARN",
           details={"change_id": row.id, "live": row.live, "summary": row.summary, "request_summary": row.request_summary,
                    "lines": row.preview.get("lines"), "score": row.preview.get("score"),
                    "items": [{"key": it["key"], "action": it["action"], "before": it["before"], "after": it["after"]}
                              for it in row.items]})
    db.commit()
    return _envelope({"change_id": row.id, "status": row.status, "summary": row.summary, "live": row.live,
                      "changes": row.preview.get("lines"), "score": row.preview.get("score"),
                      "warnings": row.preview.get("warnings"), "follow_ups": row.preview.get("follow_ups"),
                      "revert": f"되돌리려면 POST /api/agent/fla/changes/{row.id}/revert (그 뒤 같은 기록이 또 바뀌었으면 거부)"})


@router.post("/api/agent/fla/changes/{change_id}/revert")
def agent_revert(change_id: str, principal: AgentPrincipal = Depends(write_principal), db: Session = Depends(get_db)):
    row = db.query(AgentFlaChange).filter(AgentFlaChange.id == change_id).with_for_update().first()
    if row is None or row.token_id != principal.token.id:
        raise HTTPException(404, "변경 묶음을 찾을 수 없습니다(본인 토큰의 변경만 되돌릴 수 있습니다).")
    if row.status != "applied":
        raise HTTPException(409, f"적용된 변경만 되돌릴 수 있습니다(status={row.status}).")
    _check_daily_write(db, principal)
    match_obj = _load_match(db, row.match_id, for_update=True)
    stale = _stale(db, match_obj, row.items, "after")
    if stale:
        db.rollback()
        _audit(db, principal, "AGENT_FLA_REVERT_REJECTED", match_id=row.match_id, target_id=row.id, severity="WARN",
               details={"stale": stale})
        db.commit()
        raise HTTPException(409, {"reason": "changed_after_apply", "message": "적용 뒤에 같은 기록이 또 바뀌어 되돌리지 않습니다. 지금 기록을 보고 새로 plan 하세요.",
                                  "stale": stale})
    for it in reversed(row.items):
        _write_snapshot(db, match_obj, it["key"], it["before"], row.id)
    _finish_write(db, match_obj)
    row.status = "reverted"
    row.reverted_at = _utcnow()
    row.reverted_by_token = principal.token.id
    _audit(db, principal, "AGENT_FLA_REVERT", match_id=row.match_id, target_id=row.id, severity="WARN",
           details={"change_id": row.id, "summary": row.summary, "live": row.live})
    db.commit()
    return _envelope({"change_id": row.id, "status": row.status, "summary": row.summary})


@router.get("/api/agent/fla/changes")
def agent_changes(match_id: UUID | None = None, limit: int = Query(default=30, ge=1, le=200),
                  principal: AgentPrincipal = Depends(read_principal), db: Session = Depends(get_db)):
    query = db.query(AgentFlaChange).filter(AgentFlaChange.token_id == principal.token.id)
    if match_id:
        query = query.filter(AgentFlaChange.match_id == match_id)
    rows = query.order_by(AgentFlaChange.created_at.desc()).limit(limit).all()
    return _envelope([_change_view(r) for r in rows])


@router.get("/api/agent/fla/changes/{change_id}")
def agent_change(change_id: str, principal: AgentPrincipal = Depends(read_principal), db: Session = Depends(get_db)):
    row = db.get(AgentFlaChange, change_id)
    if row is None or row.token_id != principal.token.id:
        raise HTTPException(404, "변경 묶음을 찾을 수 없습니다.")
    return _envelope(_change_view(row, full=True))


# ── 콘솔(세션) 라우트: 운영자 알림 · 관리자 토큰/감사 ────────────────────────────

@router.get("/api/matches/{match_id}/agent-edits")
def console_agent_edits(match_id: UUID, since: str | None = None, db: Session = Depends(get_db),
                        _user: User = Depends(require_session_user)):
    """매치 컨트롤 화면 알림용. 최근 60분 안에 적용·되돌린 에이전트 수정."""
    floor = _utcnow() - timedelta(minutes=60)
    if since:
        try:
            parsed = datetime.fromisoformat(since.replace("Z", "+00:00"))
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
            floor = max(floor, parsed)
        except ValueError:
            raise HTTPException(422, "since 는 ISO 시각입니다.")
    rows = (db.query(AgentFlaChange).filter(AgentFlaChange.match_id == match_id,
                                            or_(AgentFlaChange.applied_at >= floor, AgentFlaChange.reverted_at >= floor))
            .order_by(AgentFlaChange.applied_at.desc()).limit(20).all())
    out = []
    for r in rows:
        if r.applied_at and r.applied_at >= floor:
            out.append({"id": r.id + ":applied", "change_id": r.id, "kind": "applied", "actor_name": r.actor_name,
                        "summary": r.summary, "at": r.applied_at.isoformat() + "Z",
                        "message": f"{r.actor_name}님이 기록을 고쳤습니다({r.summary})"})
        if r.reverted_at and r.reverted_at >= floor:
            out.append({"id": r.id + ":reverted", "change_id": r.id, "kind": "reverted", "actor_name": r.actor_name,
                        "summary": r.summary, "at": r.reverted_at.isoformat() + "Z",
                        "message": f"{r.actor_name}님이 고친 기록을 되돌렸습니다({r.summary})"})
    out.sort(key=lambda x: x["at"], reverse=True)
    return {"items": out, "server_now": _utcnow().isoformat() + "Z"}


class TokenIssueRequest(_Strict):
    person_name: str = Field(min_length=1, max_length=40, description="직원 실명(감사에 남는 이름)")
    user_id: str | None = Field(default=None, max_length=80, description="이미 있는 users 행에 묶을 때(관리자 계정 등)")
    scopes: list[Literal["fla:read", "fla:write"]] = Field(default_factory=lambda: ["fla:read", "fla:write"], min_length=1)
    expires_days: int = Field(default=TOKEN_DEFAULT_DAYS, ge=1, le=TOKEN_DEFAULT_DAYS)
    label: str = Field(default="", max_length=120)


def _token_view(db: Session, row: AgentFlaToken) -> dict:
    user = db.get(User, row.user_id)
    creator = db.get(User, row.created_by) if row.created_by else None
    now = _utcnow()
    state = "revoked" if row.revoked_at else "expired" if row.expires_at <= now else "active"
    return {"id": row.id, "display_prefix": row.display_prefix, "person_name": user.name if user else None,
            "user_id": row.user_id, "label": row.label, "scopes": row.scopes, "state": state,
            "created_by": creator.name if creator else None, "created_at": _kst(row.created_at),
            "expires_at": _kst(row.expires_at), "revoked_at": _kst(row.revoked_at), "last_used_at": _kst(row.last_used_at)}


@router.get("/api/admin/agent-fla/tokens")
def admin_list_tokens(response: Response, db: Session = Depends(get_db), _admin: User = Depends(require_admin)):
    response.headers["Cache-Control"] = "no-store"
    rows = db.query(AgentFlaToken).order_by(AgentFlaToken.created_at.desc()).all()
    return {"items": [_token_view(db, r) for r in rows]}


@router.post("/api/admin/agent-fla/tokens")
def admin_issue_token(body: TokenIssueRequest, response: Response, db: Session = Depends(get_db),
                      admin: User = Depends(require_admin)):
    response.headers["Cache-Control"] = "no-store"
    name = body.person_name.strip()
    if body.user_id:
        user = db.get(User, body.user_id)
        if user is None or user.role not in {"SUPERADMIN", "STAFF"}:
            raise HTTPException(400, "관리자 계정이나 직원(STAFF) 행에만 묶을 수 있습니다.")
    else:
        user_id = "staff-" + fingerprint(normalize_login(name))[:24]
        user = db.get(User, user_id)
        if user is None:
            # 로그인할 수 없는 사람 행(STAFF) — 감사에 실명으로 남기기 위한 것. 세션은 SUPERADMIN·OPERATOR 만 만들 수 있다.
            user = User(id=user_id, name=name, role="STAFF")
            db.add(user)
            db.flush()
    now = _utcnow()
    active = db.query(AgentFlaToken).filter(AgentFlaToken.user_id == user.id, AgentFlaToken.revoked_at.is_(None),
                                            AgentFlaToken.expires_at > now).first()
    if active is not None:
        raise HTTPException(409, f"{user.name}님은 이미 쓰는 토큰이 있습니다({active.display_prefix}…). 먼저 폐기하세요.")
    plain = TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = AgentFlaToken(token_hash=fingerprint(plain), display_prefix=plain[:13], user_id=user.id,
                        label=body.label.strip(), scopes=sorted(set(body.scopes)), created_by=admin.id, created_at=now,
                        expires_at=now + timedelta(days=body.expires_days))
    db.add(row)
    db.flush()
    db.add(AuditLog(actor_id=admin.id, actor_name=admin.name, actor_role=admin.role, action="AGENT_FLA_TOKEN_ISSUED",
                    target_type="agent_fla_token", target_id=row.id, severity="WARN",
                    details={"person": user.name, "user_id": user.id, "scopes": row.scopes,
                             "expires_at": _kst(row.expires_at), "display_prefix": row.display_prefix}))
    db.commit()
    return {"token": plain, "shown_once": True, **_token_view(db, row)}


@router.post("/api/admin/agent-fla/tokens/{token_id}/revoke")
def admin_revoke_token(token_id: str, response: Response, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    response.headers["Cache-Control"] = "no-store"
    row = db.get(AgentFlaToken, token_id)
    if row is None:
        raise HTTPException(404, "토큰이 없습니다.")
    if row.revoked_at is None:
        row.revoked_at = _utcnow()
        row.revoked_by = admin.id
        db.query(AgentFlaChange).filter(AgentFlaChange.token_id == row.id, AgentFlaChange.status == "planned") \
            .update({AgentFlaChange.status: "expired"}, synchronize_session=False)
        db.add(AuditLog(actor_id=admin.id, actor_name=admin.name, actor_role=admin.role, action="AGENT_FLA_TOKEN_REVOKED",
                        target_type="agent_fla_token", target_id=row.id, severity="WARN",
                        details={"display_prefix": row.display_prefix}))
        db.commit()
    return _token_view(db, row)


@router.get("/api/admin/agent-fla/changes")
def admin_list_changes(response: Response, match_id: UUID | None = None, status: str | None = None,
                       limit: int = Query(default=100, ge=1, le=500), db: Session = Depends(get_db),
                       _admin: User = Depends(require_admin)):
    response.headers["Cache-Control"] = "no-store"
    query = db.query(AgentFlaChange).filter(AgentFlaChange.status.in_([status] if status else ["applied", "reverted"]))
    if match_id:
        query = query.filter(AgentFlaChange.match_id == match_id)
    rows = query.order_by(AgentFlaChange.created_at.desc()).limit(limit).all()
    names = {m.id: m.name for m in db.query(Match).filter(Match.id.in_({r.match_id for r in rows})).all()} if rows else {}
    return {"items": [{**_change_view(r), "match_name": names.get(r.match_id), "token_id": r.token_id,
                       "lines": (r.preview or {}).get("lines"), "score": (r.preview or {}).get("score")} for r in rows]}


@router.get("/api/admin/agent-fla/changes/{change_id}")
def admin_change(change_id: str, response: Response, db: Session = Depends(get_db), _admin: User = Depends(require_admin)):
    response.headers["Cache-Control"] = "no-store"
    row = db.get(AgentFlaChange, change_id)
    if row is None:
        raise HTTPException(404, "변경 묶음이 없습니다.")
    return {**_change_view(row, full=True), "token_id": row.token_id}
