import uuid
from datetime import datetime
from sqlalchemy import String, Integer, Boolean, DateTime, ForeignKey, Float, BigInteger, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    role: Mapped[str] = mapped_column(String, nullable=False, default="OPERATOR")


class Match(Base):
    __tablename__ = "matches"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    sport: Mapped[str] = mapped_column(String, nullable=False, default="FOOTBALL", index=True)
    competition_class: Mapped[str] = mapped_column(String, nullable=False, default="K3")
    round_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    first_half_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=45)
    second_half_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=45)
    extra_first_half_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    extra_second_half_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    hls_url: Mapped[str | None] = mapped_column(String, nullable=True)
    metadata_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    operator_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ScheduleEntry(Base):
    __tablename__ = "schedule_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    league: Mapped[str] = mapped_column(String, nullable=False, default="", index=True)
    round_label: Mapped[str] = mapped_column(String, nullable=False, default="")
    match_date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    kickoff_time: Mapped[str] = mapped_column(String, nullable=False, index=True)
    home_team: Mapped[str] = mapped_column(String, nullable=False, default="")
    away_team: Mapped[str] = mapped_column(String, nullable=False, default="")
    fla_staff: Mapped[str] = mapped_column(String, nullable=False, default="")
    fpa_home_staff: Mapped[str] = mapped_column(String, nullable=False, default="")
    fpa_away_staff: Mapped[str] = mapped_column(String, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class ScheduleNotificationLog(Base):
    __tablename__ = "schedule_notification_logs"
    __table_args__ = (UniqueConstraint("dedupe_key", name="uq_schedule_notification_logs_dedupe_key"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    kind: Mapped[str] = mapped_column(String, nullable=False, index=True)
    dedupe_key: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    schedule_entry_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    target_date: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    message_preview: Mapped[str] = mapped_column(Text, nullable=False, default="")
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class CompetitionClass(Base):
    __tablename__ = "competition_classes"

    code: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    first_half_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=45)
    second_half_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=45)
    extra_first_half_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    extra_second_half_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    team_options: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class FcmSubmission(Base):
    __tablename__ = "fcm_submissions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    match_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("matches.id"), nullable=False, index=True)
    competition_class: Mapped[str] = mapped_column(String, nullable=False, default="K3")
    round_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    team_side: Mapped[str] = mapped_column(String, nullable=False, default="HOME")
    team_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    player_id: Mapped[str] = mapped_column(String, nullable=False)
    player_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    selected_stats: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    submitted_by: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class FcmTemplate(Base):
    __tablename__ = "fcm_templates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    competition_class: Mapped[str | None] = mapped_column(String, nullable=True)
    match_regex: Mapped[str] = mapped_column(String, nullable=False)
    image_path: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class FpaSavedLog(Base):
    __tablename__ = "fpa_saved_logs"

    match_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("matches.id"), primary_key=True)
    logs: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    rows: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    teamid_h: Mapped[str] = mapped_column(String, nullable=False, default="")
    teamid_a: Mapped[str] = mapped_column(String, nullable=False, default="")
    saved_by: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class State(Base):
    __tablename__ = "states"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    match_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("matches.id"), index=True)
    clock_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    running: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    possession_team: Mapped[str] = mapped_column(String, nullable=False, default="NONE")
    selected_team: Mapped[str] = mapped_column(String, nullable=False, default="HOME")
    attack_lr: Mapped[str] = mapped_column(String, nullable=False, default="L2R")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class PossessionSegment(Base):
    __tablename__ = "possession_segments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    match_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("matches.id"), index=True)
    team: Mapped[str] = mapped_column(String, nullable=False)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class LaneSegment(Base):
    __tablename__ = "lane_segments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    match_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("matches.id"), index=True)
    team: Mapped[str] = mapped_column(String, nullable=False)
    lane: Mapped[str] = mapped_column(String, nullable=False)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    match_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("matches.id"), index=True)
    type: Mapped[str] = mapped_column(String, nullable=False)
    clock_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    team: Mapped[str] = mapped_column(String, nullable=False)
    lane: Mapped[str | None] = mapped_column(String, nullable=True)
    xg: Mapped[float | None] = mapped_column(Float, nullable=True)
    xgot: Mapped[float | None] = mapped_column(Float, nullable=True)
    player_name: Mapped[str | None] = mapped_column(String, nullable=True)
    player_number: Mapped[str | None] = mapped_column(String, nullable=True)
    is_goal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_own_goal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_on_target: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    shot_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    shot_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    goalmouth_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    goalmouth_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_header: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_weak_foot: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    under_pressure: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    one_on_one: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    shot_pace_band: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class DominanceBin(Base):
    __tablename__ = "dominance_bins"

    match_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("matches.id"), primary_key=True)
    k: Mapped[int] = mapped_column(Integer, primary_key=True)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    home_poss_ms: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    away_poss_ms: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    home_xg: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    away_xg: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    home_attack_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    away_attack_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    dominance: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class MatchMarker(Base):
    __tablename__ = "match_markers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    match_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("matches.id"), index=True)
    marker_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    clock_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class Outbox(Base):
    __tablename__ = "outbox"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    ref_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    target_url: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class WebhookSubscription(Base):
    __tablename__ = "webhook_subscriptions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    callback_url: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    events: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    secret: Mapped[str | None] = mapped_column(String, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    actor_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    actor_name: Mapped[str | None] = mapped_column(String, nullable=True)
    actor_role: Mapped[str | None] = mapped_column(String, nullable=True)
    action: Mapped[str] = mapped_column(String, nullable=False, index=True)
    target_type: Mapped[str] = mapped_column(String, nullable=False)
    target_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    match_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    severity: Mapped[str] = mapped_column(String, nullable=False, default="INFO")
    details: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class HighlightJob(Base):
    __tablename__ = "highlight_jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="queued", index=True)
    mode: Mapped[str] = mapped_column(String, nullable=False, default="ai")
    original_filename: Mapped[str] = mapped_column(String, nullable=False, default="")
    upload_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    clips_dir: Mapped[str | None] = mapped_column(Text, nullable=True)
    export_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    job_metadata: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class HighlightClip(Base):
    """하이라이트 클립 — match–clip–action 구조의 가운데 계층.

    PK = clipKey(fpc-{rid}-NNN): FinePlay 왕복 멱등키와 동일해서 재렌더 시 upsert 된다.
    team_side 는 태깅 시점(A=홈/D=어웨이)에 확정된 클립 귀속 팀.
    """

    __tablename__ = "highlight_clips"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    job_id: Mapped[str] = mapped_column(String, ForeignKey("highlight_jobs.id"), nullable=False, index=True)
    match_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("matches.id"), nullable=True, index=True)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    team_side: Mapped[str | None] = mapped_column(String, nullable=True)  # 'home' | 'away'
    source_video_id: Mapped[str] = mapped_column(String, nullable=False, default="")
    start_sec: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    end_sec: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    main_action: Mapped[str | None] = mapped_column(String, nullable=True)
    # 운영자가 손으로 붙인 클립 제목. NULL 이면 FPA 대표 액션에서 자동 생성한
    # 제목이 그대로 나간다 — 값이 있을 때만 그 자리를 덮어쓰는 오버라이드다.
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    horizontal_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    vertical_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    thumbnail_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class HighlightClipAction(Base):
    """클립 안의 개별 액션 — FPA dual 씬 행 1개가 액션 1개로 귀속된다.

    등번호·팀은 FPA 행 기준(클립 team_side 와 다를 수 있음 — 수비 액션 등).
    fpa_* 컬럼은 원본 FPA 행 참조(fpa_saved_logs.rows 의 SceneIndex/SceneActionIndex).
    """

    __tablename__ = "highlight_clip_actions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    clip_id: Mapped[str] = mapped_column(String, ForeignKey("highlight_clips.id", ondelete="CASCADE"), nullable=False, index=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    action_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    team_side: Mapped[str | None] = mapped_column(String, nullable=True)  # 'home' | 'away'
    jersey: Mapped[str | None] = mapped_column(String, nullable=True)
    player_id: Mapped[str | None] = mapped_column(String, nullable=True)  # FinePlay lineup playerId (등번호 매칭 시)
    player_name: Mapped[str | None] = mapped_column(String, nullable=True)
    # playerId 가 숫자면 실계정 userId — 앱 개인 페이지 "내 액션" 필터가 이걸로 건다.
    # 컬럼이 없던 시절엔 재전송 페이로드에서 통째로 빠져 나갔다(에코 결락).
    user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    xg: Mapped[float | None] = mapped_column(Float, nullable=True)
    xgot: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 패스를 받은 지점의 기대득점(수비콘 반영) — 실제 슛 지점이 아니다.
    # 받은 뒤의 드리블·돌파는 슈터의 몫이므로 패서 점수에 섞지 않는다.
    # 어시스트/키패스 채점이 이 값을 쓴다 (fpa._reception_chance_xg).
    reception_xg: Mapped[float | None] = mapped_column(Float, nullable=True)
    epv: Mapped[float | None] = mapped_column(Float, nullable=True)
    pc: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 클립 내 시간 구간(초, 클립 시작=0). 기본값은 균등 분할, 운영자가 수동 수정.
    start_offset: Mapped[float | None] = mapped_column(Float, nullable=True)
    end_offset: Mapped[float | None] = mapped_column(Float, nullable=True)
    fpa_match_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    fpa_scene_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fpa_scene_action_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    extra: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # Tags, Receiver 등 부가 정보
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
