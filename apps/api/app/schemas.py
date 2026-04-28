from typing import Any, Literal
from uuid import UUID
from pydantic import BaseModel, Field

Team = Literal["HOME", "AWAY"]
PossessionTeam = Literal["HOME", "AWAY", "NONE"]
Lane = Literal["LEFT", "CENTER", "RIGHT"]
AttackLR = Literal["L2R", "R2L"]
IngestProtocol = Literal["SRT", "RTMP"]
StreamMode = Literal["STREAM", "MANUAL"]
WebhookEventKind = Literal["STATE", "EVENT"]
UserRole = Literal["OPERATOR", "SUPERADMIN"]
MarkerType = Literal["HALFTIME_START"]
TimelineItemKind = Literal["EVENT", "MARKER"]
EditableEventType = Literal["ATTACK_LANE", "XG", "HALFTIME_START"]


class CreateMatchRequest(BaseModel):
    name: str
    competition_class: str = Field(default="K3", min_length=1, max_length=20)
    round_number: int = Field(default=1, ge=1, le=99)
    stream_mode: StreamMode = "STREAM"
    assign_operator: bool = True
    ingest_protocol: IngestProtocol | None = None
    ingest_url: str | None = None
    srt_url: str | None = None
    hls_url: str | None = None
    metadata: dict[str, Any] | None = None


class MatchResponse(BaseModel):
    id: UUID
    name: str
    competition_class: str
    round_number: int
    first_half_minutes: int
    second_half_minutes: int
    archived: bool
    archived_at: str | None = None
    created_at: str
    hls_url: str | None
    metadata: dict[str, Any] | None = None
    operator_id: str | None


class CompetitionClassCreateRequest(BaseModel):
    code: str = Field(min_length=1, max_length=20)
    name: str = Field(min_length=1, max_length=60)
    first_half_minutes: int = Field(default=45, ge=1, le=120)
    second_half_minutes: int = Field(default=45, ge=1, le=120)


class CompetitionClassResponse(BaseModel):
    code: str
    name: str
    first_half_minutes: int
    second_half_minutes: int
    created_at: str


class FcmSubmissionUpsertRequest(BaseModel):
    team_side: Literal["HOME", "AWAY"] = "HOME"
    player_id: str = Field(min_length=1, max_length=40)
    player_name: str = Field(min_length=1, max_length=80)
    team_name: str = Field(default="", max_length=80)
    selected_stats: list[str] = Field(min_length=1, max_length=5)


class FcmSubmissionResponse(BaseModel):
    id: UUID
    match_id: UUID
    competition_class: str
    round_number: int
    team_side: Literal["HOME", "AWAY"]
    team_name: str = ""
    player_id: str
    player_name: str = ""
    selected_stats: list[str]
    submitted_by: str | None = None
    created_at: str
    updated_at: str


class FcmTemplateResponse(BaseModel):
    id: UUID
    name: str
    match_regex: str
    image_url: str
    priority: int
    active: bool
    created_at: str
    updated_at: str


class ArchiveMatchRequest(BaseModel):
    archived: bool = True
    stop_stream: bool = True


class UpdateArchivedMatchRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class AcquireLockRequest(BaseModel):
    user_id: str | None = None
    admin_takeover: bool = False


class ReleaseLockRequest(BaseModel):
    user_id: str | None = None
    admin_takeover: bool = False


class StateRequest(BaseModel):
    state_id: UUID
    clock_ms: int = Field(ge=0)
    running: bool
    possession_team: PossessionTeam
    selected_team: Team
    attack_lr: AttackLR
    allow_clock_rewind: bool = False
    user_id: str | None = None


class AttackLaneEventRequest(BaseModel):
    event_id: UUID
    clock_ms: int | None = Field(default=None, ge=0)
    team: Team
    lane: Lane
    user_id: str | None = None


class XGEventRequest(BaseModel):
    event_id: UUID
    clock_ms: int | None = Field(default=None, ge=0)
    team: Team
    xg: float = Field(ge=0)
    is_goal: bool = False
    is_on_target: bool = False
    shot_x: float | None = Field(default=None, ge=0, le=105)
    shot_y: float | None = Field(default=None, ge=0, le=68)
    goalmouth_x: float | None = Field(default=None, ge=0, le=1)
    goalmouth_y: float | None = Field(default=None, ge=0, le=1)
    is_header: bool = False
    is_weak_foot: bool = False
    under_pressure: bool = False
    one_on_one: bool = False
    shot_pace_band: Literal["LOW", "MID", "HIGH"] = "MID"
    user_id: str | None = None


class XGEstimateRequest(BaseModel):
    team: Team
    attack_lr: AttackLR
    start_x: float = Field(ge=0, le=105)
    start_y: float = Field(ge=0, le=68)
    is_header: bool = False
    is_weak_foot: bool = False


class XGOTEstimateRequest(BaseModel):
    xg: float = Field(ge=0, le=1)
    is_on_target: bool = False
    goalmouth_x: float | None = Field(default=None, ge=0, le=1)
    goalmouth_y: float | None = Field(default=None, ge=0, le=1)
    is_goal: bool = False
    is_header: bool = False
    is_weak_foot: bool = False
    under_pressure: bool = False
    one_on_one: bool = False
    shot_pace_band: Literal["LOW", "MID", "HIGH"] = "MID"


class MatchMarkerRequest(BaseModel):
    clock_ms: int | None = Field(default=None, ge=0)
    marker_type: MarkerType = "HALFTIME_START"
    user_id: str | None = None


class AttachSrtRequest(BaseModel):
    srt_url: str


class AttachIngestRequest(BaseModel):
    ingest_protocol: IngestProtocol | None = None
    ingest_url: str | None = None
    srt_url: str | None = None


class PossessionResetRequest(BaseModel):
    user_id: str | None = None


class EventsResetRequest(BaseModel):
    user_id: str | None = None


class TimelineEditorUpsertRequest(BaseModel):
    kind: TimelineItemKind
    type: EditableEventType
    clock_ms: int = Field(ge=0)
    team: Team | None = None
    lane: Lane | None = None
    xg: float | None = Field(default=None, ge=0)
    is_goal: bool = False
    is_on_target: bool = False
    shot_x: float | None = Field(default=None, ge=0, le=105)
    shot_y: float | None = Field(default=None, ge=0, le=68)
    goalmouth_x: float | None = Field(default=None, ge=0, le=1)
    goalmouth_y: float | None = Field(default=None, ge=0, le=1)
    is_header: bool = False
    is_weak_foot: bool = False
    under_pressure: bool = False
    one_on_one: bool = False
    shot_pace_band: Literal["LOW", "MID", "HIGH"] = "MID"


class TimelineEditorListItem(BaseModel):
    item_id: str
    kind: TimelineItemKind
    type: EditableEventType
    clock_ms: int
    team: Team | None = None
    lane: Lane | None = None
    xg: float | None = None
    xgot: float | None = None
    is_goal: bool = False
    is_on_target: bool = False
    shot_x: float | None = None
    shot_y: float | None = None
    goalmouth_x: float | None = None
    goalmouth_y: float | None = None
    is_header: bool = False
    is_weak_foot: bool = False
    under_pressure: bool = False
    one_on_one: bool = False
    shot_pace_band: Literal["LOW", "MID", "HIGH"] | None = None
    created_at: str


class TimelineEditorListResponse(BaseModel):
    items: list[TimelineEditorListItem]
    total: int
    limit: int
    offset: int


class WebhookSubscriptionCreateRequest(BaseModel):
    callback_url: str
    events: list[WebhookEventKind] = Field(default_factory=lambda: ["STATE", "EVENT"])
    secret: str | None = None
    active: bool = True


class LoginRequest(BaseModel):
    name: str = Field(min_length=2, max_length=40)
    access_key: str = Field(min_length=4, max_length=200)


class SessionUserResponse(BaseModel):
    id: str
    name: str
    role: UserRole


class WebhookSubscriptionResponse(BaseModel):
    id: UUID
    callback_url: str
    events: list[WebhookEventKind]
    active: bool
    created_at: str
    updated_at: str


class MatchResultPossession(BaseModel):
    homePct: float
    awayPct: float


class MatchResultXg(BaseModel):
    home: float
    away: float


class MatchResultResponse(BaseModel):
    matchId: str
    name: str
    status: str
    clockMs: int
    possession: MatchResultPossession
    xg: MatchResultXg
    playedAt: str
