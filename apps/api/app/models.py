import uuid
from datetime import datetime
from sqlalchemy import String, Integer, Boolean, DateTime, ForeignKey, Float, BigInteger, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)


class Match(Base):
    __tablename__ = "matches"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    hls_url: Mapped[str | None] = mapped_column(String, nullable=True)
    metadata_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    operator_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


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
    dominance: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


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
