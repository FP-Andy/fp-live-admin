"""Validated, versioned substitution logs, independent of possession segments."""
from copy import deepcopy
from typing import Literal
from uuid import UUID
from fastapi import HTTPException
from pydantic import BaseModel, Field


class Video(BaseModel):
    name: str = Field(min_length=1, max_length=1000)
    duration: float = Field(gt=0, allow_inf_nan=False)
    from_: float = Field(alias='from', ge=0, allow_inf_nan=False)
    to: float = Field(gt=0, allow_inf_nan=False)


class Player(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    team: Literal['home', 'away']
    name: str = Field(min_length=1, max_length=80)
    jersey: str = Field(pattern=r'^(?:\d{1,3})?$')
    sourceSlotId: str | None = Field(default=None, max_length=160)


class TrackingResolution(BaseModel):
    snapshotId: str = Field(pattern=r'^[a-f0-9]{32}$')
    outPersonId: str = Field(min_length=1, max_length=160)
    outTrackId: int = Field(ge=0, strict=True)
    inTrackId: int = Field(ge=0, strict=True)


class Substitution(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    time: float = Field(ge=0, allow_inf_nan=False)
    team: Literal['home', 'away']
    outId: str | None = Field(default=None, min_length=1, max_length=160)
    inId: str | None = Field(default=None, min_length=1, max_length=160)
    note: str = Field(default='', max_length=500)
    tracking: TrackingResolution | None = None


class Log(BaseModel):
    schema_name: Literal['fpa-substitution-log/v1','fpa-substitution-log/v2'] = Field(alias='schema')
    video: Video
    players: list[Player] = Field(max_length=100)
    initialPlayers: list[str] = Field(max_length=100)
    substitutions: list[Substitution] = Field(max_length=10000)


class SaveSubstitutions(BaseModel):
    request_id: UUID
    client_id: UUID
    revision: int = Field(ge=0)
    log: Log


def saved_substitutions(match):
    value=(match.metadata_json or {}).get('fla_substitutions', {})
    return {'revision':value.get('revision',0), 'log':deepcopy(value.get('log'))}


def clear_substitutions(match):
    current=saved_substitutions(match)
    match.metadata_json={**(match.metadata_json or {}), 'fla_substitutions':{'revision':current['revision']+1,'log':None}}


def validate_log(log, state, upload_name, *, review_only=False, saved_video=None):
    def require(ok, message):
        if not ok: raise HTTPException(400,message)
    video=log.video
    configured=bool(state.get('duration_ms',0)>0 and state.get('configured',True))
    require(configured or review_only, '경기 영상과 시작 시각을 먼저 저장하세요.')
    # Dashboard-completed games may have no FLA video clock. Capture source time
    # independently, locking the media duration on the first log save.
    duration=state['duration_ms']/1000 if configured else (saved_video or {}).get('duration',video.duration)
    start=state.get('offset_ms',0)/1000 if configured else 0
    require(video.name==upload_name and abs(video.duration-duration)<1e-6
            and abs(video.from_-start)<1e-6 and abs(video.to-video.duration)<1e-6,
            '현재 경기 영상·시작 기준과 다른 타임로그입니다.')
    require(video.from_<video.to, '영상 범위를 확인하세요.')
    people={p.id:p for p in log.players}
    require(len(people)==len(log.players), '선수 ID가 중복되었습니다.')
    jerseys=set()
    for p in log.players:
        require(bool(p.name.strip()), '선수 식별명을 입력하세요.')
        key=(p.team,int(p.jersey)) if p.jersey else None
        require(key is None or key not in jerseys, '같은 팀의 등번호가 중복되었습니다.')
        if key:jerseys.add(key)
    active=set(log.initialPlayers)
    require(len(active)==len(log.initialPlayers) and active<=people.keys(), '경기 시작 출전 명단을 확인하세요.')
    events=sorted(log.substitutions,key=lambda e:e.time)
    ids=set();participants=set();previous=None;uncertain_teams=set();marker_times=set()
    for e in events:
        require(review_only or (state.get('started') and e.time*1000<=state['offset_ms']+state.get('frontier_ms',0)+.001),
                '재생하여 확인한 시각에 교체를 기록하세요.')
        require(video.from_<=e.time<video.to, '교체 시각이 영상 범위 밖입니다.')
        require(e.id not in ids, '교체 ID가 중복되었습니다.')
        if e.tracking:
            require(e.tracking.outTrackId != e.tracking.inTrackId, '입장·퇴장은 서로 다른 객체를 선택하세요.')
        paired=e.outId is not None and e.inId is not None
        require(paired or (e.outId is None and e.inId is None and log.schema_name=='fpa-substitution-log/v2'),
                'OUT·IN 연결은 두 선수 모두 지정하거나 비워두세요.')
        ids.add(e.id)
        if not paired:
            key=(e.team,e.time)
            require(key not in marker_times, '같은 팀·시각의 교체 로그가 이미 있습니다.')
            marker_times.add(key);uncertain_teams.add(e.team)
            continue
        require(e.outId in people and e.inId in people and e.outId!=e.inId
                and people[e.outId].team==e.team and people[e.inId].team==e.team,
                'OUT·IN은 같은 팀의 서로 다른 선수여야 합니다.')
        if e.time!=previous:participants=set()
        require(e.outId not in participants and e.inId not in participants, '같은 선수를 동일 시각에 두 번 교체할 수 없습니다.')
        require(e.team in uncertain_teams or e.outId in active, 'OUT 선수가 출전 중이 아닙니다. 시작 명단과 앞선 교체 기록을 확인하세요.')
        require(e.team in uncertain_teams or e.inId not in active, 'IN 선수가 이미 출전 중입니다.')
        active.discard(e.outId);active.add(e.inId);ids.add(e.id);participants.update((e.outId,e.inId));previous=e.time
    result=log.model_dump(by_alias=True,exclude_none=True)
    result['substitutions']=[e.model_dump(exclude_none=True) for e in events]
    return result
