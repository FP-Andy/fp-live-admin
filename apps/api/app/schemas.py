from typing import Any, Literal
from uuid import UUID
from pydantic import BaseModel, Field

Team = Literal["HOME", "AWAY"]
PossessionTeam = Literal["HOME", "AWAY", "NONE"]
Lane = Literal["LEFT", "CENTER", "RIGHT"]
AttackLR = Literal["L2R", "R2L"]
IngestProtocol = Literal["SRT", "RTMP"]
WebhookEventKind = Literal["STATE", "EVENT"]


class CreateMatchRequest(BaseModel):
    name: str
    assign_operator: bool = True
    ingest_protocol: IngestProtocol | None = None
    ingest_url: str | None = None
    srt_url: str | None = None
    hls_url: str | None = None
    metadata: dict[str, Any] | None = None


class MatchResponse(BaseModel):
    id: UUID
    name: str
    hls_url: str | None
    metadata: dict[str, Any] | None = None
    operator_id: str | None


class AcquireLockRequest(BaseModel):
    user_id: str
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
    user_id: str | None = None


class XGEstimateRequest(BaseModel):
    team: Team
    attack_lr: AttackLR
    start_x: float = Field(ge=0, le=105)
    start_y: float = Field(ge=0, le=68)
    is_header: bool = False
    is_weak_foot: bool = False


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


class WebhookSubscriptionCreateRequest(BaseModel):
    callback_url: str
    events: list[WebhookEventKind] = Field(default_factory=lambda: ["STATE", "EVENT"])
    secret: str | None = None
    active: bool = True


class LoginRequest(BaseModel):
    name: str = Field(min_length=2, max_length=40)


class SessionUserResponse(BaseModel):
    id: str
    name: str


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
