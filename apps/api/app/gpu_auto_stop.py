"""GPU(FHL) 서버 유휴 자동 종료.

GPU 서버는 System 화면 버튼으로만 켜고 끈다. 사람이 끄는 걸 잊으면 시간당 비용이
계속 나가므로, API가 5분마다 상태를 보고 "켜져 있는데 일이 없고, 마지막 일 이후
충분히 지났을 때"만 기존 제어 URL(media-control Lambda)의 stop 을 한 번 부른다.
GPU 서버에 따로 설치할 것이 없고, 종료 권한도 이미 있는 Lambda 경로를 그대로 쓴다.

"GPU 일감"의 정의 (코드 기준, 2026-11-04 `621eb52`):

1. ``highlight_jobs`` — GPU 작업자(``app.highlight_worker``)가 ``status='queued'`` 이고
   ``mode != 'operator'`` 인 행을 집어 ``processing`` 으로 바꾼 뒤 ``done``/``error`` 로 끝낸다.
   실제로 queued 로 만들어지는 모드는 ``ai``·``log_ai``·``player`` 뿐이다.
   operator 는 API가 직접 처리하고(링크 다운로드·ffmpeg 자르기), manual·fineplay·
   produce_s3 는 queued 를 쓰지 않고 앱 서버 ``highlight-render`` 가 합친다(CPU).
   → 대기·처리 중: ``status IN ('queued','processing') AND mode <> 'operator'``
   → 마지막 종료 시각: ``mode IN ('ai','log_ai','player') AND status IN ('done','error')`` 의 ``updated_at``
2. ``broadcast_overlay_projects`` — 녹화 영상 위 방송 그래픽 합성. 같은 GPU 작업자가
   ``queued`` → ``rendering`` → ``done``/``error`` 로 처리한다(앱 서버에는 이 렌더러가 없다).
3. FPA-CV — 작업 목록의 정본은 DB가 아니라 GPU 서버의 FPA 작업자 메모리/디스크다
   (``scripts/fpa_cv_jobs.py``). ``fpa_cv_resources`` 표는 화면이 조회할 때만 갱신되는 사본이라
   쓰지 않고, ``GET {FPA_CV_WORKER_URL}/api/tracking/queue`` 의 ``activeCount``·``queuedCount``
   (분석·준비·보강 전부 포함, ACTIVE = queued/starting/running/cancelling)를 본다.

GPU를 쓰지 않는 것: ``highlight_render_queue``(highlight-render, 앱 서버 CPU),
``scene_motion_queue``(scene-render, 앱 서버 CPU), ``competition_send_queue``(전송).

판단 상태는 ``gpu_auto_stop_state`` 한 행에 저장한다. API를 재시작해도 유휴 시계가
처음부터 다시 시작되거나(늦게 꺼짐), 비어 있는 기억 때문에 바로 꺼지는 일이 없게 하기 위해서다.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable

import httpx
from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.orm import Mapped, Session, mapped_column

from .db import Base
from .models import AuditLog, BroadcastOverlayProject, HighlightJob

logger = logging.getLogger("gpu_auto_stop")

STATE_ID = "fhl-gpu"
KST_OFFSET = timedelta(hours=9)

# GPU 작업자가 실제로 집어 가는 하이라이트 모드. 종료 시각 계산에만 쓴다 — 대기·처리
# 판단은 작업자와 같은 조건(mode != operator)을 써서, 새 모드가 생겨도 놓치지 않게 한다.
GPU_HIGHLIGHT_MODES = ("ai", "log_ai", "player")
HIGHLIGHT_BUSY = ("queued", "processing")
HIGHLIGHT_FINISHED = ("done", "error")
OVERLAY_BUSY = ("queued", "rendering")
OVERLAY_FINISHED = ("done", "error")


def _flag(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    enabled: bool
    idle_minutes: int
    check_seconds: int
    # 처리 중으로 남은 행이 이 시간 넘게 갱신되지 않으면 "멈춘 행"으로 본다. GPU를 손으로
    # 끈 사이 processing 으로 남은 행이 자동 종료를 영원히 막지 않게 하는 장치다.
    # 기본 12시간 = 오버레이 렌더에 주는 S3 업로드 URL 수명. 그 뒤엔 어차피 결과를 못 올린다.
    stale_hours: int
    # 재시작·장애로 관측이 이만큼 끊기면 그 사이 GPU가 꺼졌다 켜졌을 수 있으니
    # "켜진 시각"을 지금으로 다시 잡는다(늦게 끄는 쪽으로만 틀린다).
    observation_gap_minutes: int
    slack_webhook_url: str

    @classmethod
    def from_env(cls) -> "Settings":
        check_seconds = _int("GPU_AUTO_STOP_CHECK_SECONDS", 300, 30)
        return cls(
            enabled=_flag("GPU_AUTO_STOP_ENABLED", "0"),
            idle_minutes=_int("GPU_AUTO_STOP_IDLE_MINUTES", 60, 10),
            check_seconds=check_seconds,
            stale_hours=_int("GPU_AUTO_STOP_STALE_HOURS", 12, 1),
            observation_gap_minutes=max(20, (check_seconds * 3) // 60),
            slack_webhook_url=(
                os.getenv("GPU_AUTO_STOP_SLACK_WEBHOOK_URL", "").strip()
                or os.getenv("SYSTEM_MONITOR_SLACK_WEBHOOK_URL", "").strip()
            ),
        )


class GpuAutoStopState(Base):
    __tablename__ = "gpu_auto_stop_state"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    # 모든 시각은 다른 표와 같이 UTC naive(datetime.utcnow)로 저장한다.
    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    running_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_state: Mapped[str | None] = mapped_column(String, nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_stop_requested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    fpa_unreachable_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # "오늘 자동 종료 안 함" — 한국 날짜(YYYY-MM-DD). 날짜가 바뀌면 저절로 풀린다.
    skip_date: Mapped[str | None] = mapped_column(String, nullable=True)
    skip_by: Mapped[str | None] = mapped_column(String, nullable=True)
    last_decision: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


@dataclass
class GpuWork:
    highlight_jobs: int = 0
    overlay_projects: int = 0
    stale_rows: int = 0
    fpa_active: int | None = None
    fpa_queued: int | None = None
    fpa_checked: bool = False
    fpa_error: str | None = None
    last_finished_at: datetime | None = None
    detail: dict = field(default_factory=dict)

    @property
    def busy(self) -> bool:
        return bool(self.highlight_jobs or self.overlay_projects or self.fpa_active or self.fpa_queued)

    def summary(self) -> dict:
        return {
            "highlight_jobs": self.highlight_jobs,
            "overlay_projects": self.overlay_projects,
            "stale_rows": self.stale_rows,
            "fpa_cv_active": self.fpa_active,
            "fpa_cv_queued": self.fpa_queued,
            "fpa_cv_error": self.fpa_error,
        }


def kst_date(now: datetime) -> str:
    return (now + KST_OFFSET).date().isoformat()


def load_state(db: Session) -> GpuAutoStopState:
    state = db.get(GpuAutoStopState, STATE_ID)
    if state is None:
        state = GpuAutoStopState(id=STATE_ID)
        db.add(state)
        db.flush()
    return state


def fetch_fpa_queue() -> dict | None:
    """GPU 서버 FPA 작업자의 대기열 요약. 연결 설정이 없으면 None(=FPA 검사 생략)."""
    base = os.getenv("FPA_CV_WORKER_URL", "").strip().rstrip("/")
    token = os.getenv("FPA_CV_WORKER_TOKEN", "").strip()
    if not base or not token:
        return None
    with httpx.Client(timeout=httpx.Timeout(5.0, connect=3.0)) as client:
        response = client.get(base + "/api/tracking/queue", headers={"Authorization": "Bearer " + token})
        response.raise_for_status()
        value = response.json()
    if not isinstance(value, dict):
        raise ValueError("FPA 대기열 응답 형식 오류")
    return value


def slack_notifier(webhook_url: str) -> Callable[[str], None] | None:
    """기존 서버 경고와 같은 방식(웹훅에 text 한 줄)으로 보낸다. 주소는 로그에 남기지 않는다."""
    if not webhook_url:
        return None

    def send(message: str) -> None:
        with httpx.Client(timeout=5.0) as client:
            client.post(webhook_url, json={"text": message}).raise_for_status()

    return send


def collect_gpu_work(db: Session, now: datetime, settings: Settings,
                     fpa_queue: Callable[[], dict | None]) -> GpuWork:
    work = GpuWork()
    stale_before = now - timedelta(hours=settings.stale_hours)

    def busy_count(model, statuses, *extra):
        # queued 는 아직 아무도 손대지 않은 일이라 오래돼도 "일감"으로 센다. 멈춘 행으로
        # 거르는 건 작업자가 집어 간 뒤(processing/rendering) 갱신이 끊긴 행뿐이다.
        rows = db.query(model.status, model.updated_at).filter(model.status.in_(statuses), *extra).all()
        live = stale = 0
        for status, updated_at in rows:
            if status != "queued" and updated_at is not None and updated_at < stale_before:
                stale += 1
            else:
                live += 1
        return live, stale

    work.highlight_jobs, stale_h = busy_count(HighlightJob, HIGHLIGHT_BUSY, HighlightJob.mode != "operator")
    work.overlay_projects, stale_o = busy_count(BroadcastOverlayProject, OVERLAY_BUSY)
    work.stale_rows = stale_h + stale_o

    finished = [
        db.query(func.max(HighlightJob.updated_at)).filter(
            HighlightJob.mode.in_(GPU_HIGHLIGHT_MODES), HighlightJob.status.in_(HIGHLIGHT_FINISHED)).scalar(),
        db.query(func.max(BroadcastOverlayProject.updated_at)).filter(
            BroadcastOverlayProject.status.in_(OVERLAY_FINISHED)).scalar(),
    ]
    finished = [value for value in finished if value is not None and value <= now]
    work.last_finished_at = max(finished) if finished else None

    try:
        queue = fpa_queue()
        if queue is not None:
            work.fpa_checked = True
            work.fpa_active = int(queue.get("activeCount") or 0)
            work.fpa_queued = int(queue.get("queuedCount") or 0)
    except Exception as exc:  # 연결 실패는 "모름"이다. 아래 run_tick 이 보류로 처리한다.
        work.fpa_checked = True
        work.fpa_error = str(exc)[:300] or exc.__class__.__name__
    return work


@dataclass
class TickResult:
    decision: str
    stopped: bool = False
    state: str | None = None
    idle_minutes: float | None = None
    error: str | None = None
    work: dict | None = None


def _minutes(delta: timedelta) -> float:
    return round(delta.total_seconds() / 60, 1)


def run_tick(
    db: Session,
    *,
    now: datetime,
    settings: Settings,
    control: Callable[[str], dict],
    fpa_queue: Callable[[], dict | None] = fetch_fpa_queue,
    notify: Callable[[str], None] | None = None,
) -> TickResult:
    """한 번 판단한다. 예외를 밖으로 내지 않는다 — 실패는 기록하고 다음 차례에 다시 본다."""
    state = load_state(db)
    previous_check = state.last_checked_at
    state.last_checked_at = now
    state.updated_at = now

    def finish(result: TickResult) -> TickResult:
        state.last_decision = result.decision
        state.last_error = result.error
        db.commit()
        return result

    try:
        status = control("status")
        gpu_state = str(status.get("state") or "unknown").lower()
    except Exception as exc:
        logger.warning("GPU auto-stop: status check failed: %s", exc)
        return finish(TickResult("status_failed", error=f"상태 확인 실패: {str(exc)[:300]}"))

    if gpu_state != "running":
        # 꺼져 있거나(stopped) 켜지는·꺼지는 중이면 아무것도 부르지 않는다. 다음에 running 을
        # 보면 그때부터 켜진 시간을 잰다.
        state.last_state = gpu_state
        if gpu_state in {"stopped", "stopping", "terminated", "shutting-down"}:
            state.running_since = None
        return finish(TickResult("not_running", state=gpu_state))

    gap = timedelta(minutes=settings.observation_gap_minutes)
    if (state.last_state != "running" or state.running_since is None
            or previous_check is None or now - previous_check > gap):
        # 처음 보았거나 관측이 오래 끊겼다 → 지금 막 켜진 것으로 본다(일찍 끄지 않는 쪽).
        state.running_since = now
    state.last_state = "running"

    work = collect_gpu_work(db, now, settings, fpa_queue)
    if work.last_finished_at and (state.last_activity_at is None or work.last_finished_at > state.last_activity_at):
        state.last_activity_at = work.last_finished_at
    if work.busy:
        state.last_activity_at = now
        state.fpa_unreachable_since = None
        return finish(TickResult("busy", state=gpu_state, work=work.summary()))

    if work.fpa_error:
        # FPA 작업자에 닿지 않으면 그쪽이 바쁜지 알 수 없다. 켜지는 중이거나 잠깐 끊긴
        # 경우가 대부분이라 보류하고, 유휴 기준 시간만큼 계속 닿지 않을 때만 일이 없다고 본다
        # (작업자 컨테이너가 죽어 있으면 GPU도 일을 하지 않으므로).
        state.fpa_unreachable_since = state.fpa_unreachable_since or now
        if now - state.fpa_unreachable_since < timedelta(minutes=settings.idle_minutes):
            return finish(TickResult("fpa_unknown", state=gpu_state, work=work.summary(),
                                     error=f"FPA 대기열 확인 실패: {work.fpa_error}"))
    else:
        state.fpa_unreachable_since = None

    idle_from = max(value for value in (state.last_activity_at, state.running_since) if value is not None)
    idle = now - idle_from
    idle_min = _minutes(idle)
    if idle < timedelta(minutes=settings.idle_minutes):
        return finish(TickResult("idle_waiting", state=gpu_state, idle_minutes=idle_min, work=work.summary()))

    if state.skip_date == kst_date(now):
        return finish(TickResult("skipped_today", state=gpu_state, idle_minutes=idle_min, work=work.summary()))

    if state.last_stop_requested_at and now - state.last_stop_requested_at < timedelta(minutes=15):
        # 방금 stop 을 보냈는데 아직 running 으로 보이는 경우. 같은 요청을 겹쳐 보내지 않는다.
        return finish(TickResult("stop_pending", state=gpu_state, idle_minutes=idle_min, work=work.summary()))

    try:
        result = control("stop")
    except Exception as exc:
        logger.warning("GPU auto-stop: stop request failed: %s", exc)
        return finish(TickResult("stop_failed", state=gpu_state, idle_minutes=idle_min,
                                 work=work.summary(), error=f"종료 요청 실패: {str(exc)[:300]}"))

    state.last_stop_requested_at = now
    state.running_since = None
    state.last_state = str(result.get("state") or "stopping").lower() if isinstance(result, dict) else "stopping"
    db.add(AuditLog(
        action="HIGHLIGHT_WORKER_EC2_AUTO_STOP",
        target_type="system",
        target_id=str((result or {}).get("instance_id") or STATE_ID),
        actor_name="GPU 자동 종료",
        severity="WARN",
        details={
            "idle_minutes": idle_min,
            "threshold_minutes": settings.idle_minutes,
            "last_activity_at": state.last_activity_at.isoformat() if state.last_activity_at else None,
            "work": work.summary(),
            "result_state": (result or {}).get("state"),
            "detail": (result or {}).get("detail"),
        },
        created_at=now,
    ))
    outcome = finish(TickResult("stopped", stopped=True, state=gpu_state, idle_minutes=idle_min, work=work.summary()))
    if notify:
        try:
            notify(
                f"GPU 서버를 자동으로 껐습니다. 마지막 작업 이후 {int(idle_min)}분 동안 할 일이 없었습니다.\n"
                f"다시 쓰려면 System 화면에서 켜 주세요. ({(now + KST_OFFSET):%Y-%m-%d %H:%M} KST)"
            )
        except Exception as exc:  # 알림 실패가 종료 기록을 되돌리면 안 된다.
            logger.warning("GPU auto-stop: Slack notice failed: %s", exc)
    return outcome


def note_manual_start(db: Session, now: datetime) -> None:
    """사람이 켰다면 그 시각부터 유휴 시간을 다시 잰다.

    5분 사이에 껐다 켜면 상태 확인으로는 그 변화를 못 본다. 그러면 예전 "켜진 시각"이
    남아 켜자마자 꺼질 수 있어서, 시작 버튼 경로에서 직접 알려 준다.
    """
    state = load_state(db)
    state.running_since = now
    state.last_activity_at = now
    state.last_state = "running"
    state.last_stop_requested_at = None
    state.updated_at = now


def note_manual_stop(db: Session, now: datetime) -> None:
    state = load_state(db)
    state.running_since = None
    state.last_state = "stopping"
    state.updated_at = now


def set_skip_today(db: Session, now: datetime, skip: bool, actor: str | None) -> GpuAutoStopState:
    state = load_state(db)
    state.skip_date = kst_date(now) if skip else None
    state.skip_by = actor if skip else None
    state.updated_at = now
    return state


def status_payload(db: Session, now: datetime, settings: Settings) -> dict[str, Any]:
    state = db.get(GpuAutoStopState, STATE_ID)

    def iso(value: datetime | None) -> str | None:
        # 저장은 UTC naive 라 화면이 시간대를 오해하지 않게 Z 를 붙여 준다.
        return value.isoformat() + "Z" if value else None

    idle_from = None
    if state and state.last_state == "running":
        candidates = [value for value in (state.last_activity_at, state.running_since) if value is not None]
        idle_from = max(candidates) if candidates else None
    return {
        "enabled": settings.enabled,
        "idle_minutes": settings.idle_minutes,
        "check_seconds": settings.check_seconds,
        "slack_configured": bool(settings.slack_webhook_url),
        "skip_today": bool(state and state.skip_date == kst_date(now)),
        "skip_by": state.skip_by if state and state.skip_date == kst_date(now) else None,
        "last_state": state.last_state if state else None,
        "last_checked_at": iso(state.last_checked_at) if state else None,
        "last_activity_at": iso(state.last_activity_at) if state else None,
        "running_since": iso(state.running_since) if state else None,
        "idle_for_minutes": _minutes(now - idle_from) if idle_from else None,
        "last_stop_requested_at": iso(state.last_stop_requested_at) if state else None,
        "last_decision": state.last_decision if state else None,
        "last_error": state.last_error if state else None,
    }
