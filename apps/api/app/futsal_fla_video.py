"""Futsal video coding: media time and monotonic possession progress are separate."""
from copy import deepcopy
import json
import math
import os
import re
import time
import unicodedata
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid5, NAMESPACE_URL

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from .auth import require_session_user
from .db import get_db
from .models import Match, User, Event, State, PossessionSegment, FpaCvResource, DominanceBin
from .services import apply_possession_segment, apply_attack_event, apply_xg_event, recompute_dominance
from .xgot import estimate_xgot
from .fpa_cv import same_origin
from .fpa_cv_storage import storage

FIXTURES = json.loads((Path(__file__).parent/'data/queen-cup-fla-2026.json').read_text())
PREFIX = '/api/futsal/fla-video'
Team = Literal['HOME', 'AWAY', 'NONE']


def video_state(match):
    return deepcopy((match.metadata_json or {}).get('fla_video', {}))


def video_references(db, upload_id):
    return [str(m.id) for m in db.query(Match).filter(Match.sport=='FUTSAL').all()
            if video_state(m).get('upload_id') == upload_id]


def match_id(key):
    return uuid5(NAMESPACE_URL, 'fineplay:queen-cup-2026:fla:'+key)


def normalize_name(name):
    name = unicodedata.normalize('NFC', name).lower()
    return re.sub(r'\s+', '', name).replace('서울이랜드', '서울e').replace('김천상무','김천')


def candidates(fixture, uploads):
    found=[]
    for upload in uploads:
        name=normalize_name(upload.payload.get('name',''))
        is_final='파이널' in name
        if is_final != (fixture['stage']=='파이널'):continue
        parsed=re.search(r'(\d+)경기(.+?)(?:vs\.?|_)(.+?)\.(?:mp4|mov|m4v)$', name)
        if not parsed:
            # Some supplied filenames omit "vs"; exact ordered team pair only.
            parsed=re.search(r'(\d+)경기(.+)\.(?:mp4|mov|m4v)$', name)
            if parsed and int(parsed[1])==fixture['round'] and parsed[2]==normalize_name(fixture['home']+fixture['away']):found.append(upload.id)
        elif int(parsed[1])==fixture['round'] and parsed[2]==normalize_name(fixture['home']) and parsed[3]==normalize_name(fixture['away']):found.append(upload.id)
    return found


def get_match(db, id, user, write=False):
    query=db.query(Match).filter(Match.id==id)
    if write:query=query.with_for_update()
    match=query.first()
    if not match or match.sport!='FUTSAL':raise HTTPException(404,'풋살 경기를 찾지 못했습니다.')
    if write and (match.archived or (match.operator_id and match.operator_id!=user.id and user.role!='SUPERADMIN')):
        raise HTTPException(403,'이 경기의 기록 권한을 확인하세요.')
    return match


def public_upload(row):
    return {'id':row.id,'name':row.payload.get('name'),'size':row.payload.get('size'),'legacy':not row.payload.get('storage') and not row.payload.get('status')}


def upload_ready(row):
    # Legacy uploads were registered only after the private worker received the
    # complete source. Keep them selectable without guessing their fixture.
    p=row.payload
    return p.get('status')=='uploaded' or (not p.get('storage') and not p.get('status') and bool(p.get('size')))


def allowed_upload(db, id, user):
    row=db.query(FpaCvResource).filter_by(id=id,kind='upload').first()
    if not row or not upload_ready(row) or (user.role!='SUPERADMIN' and row.owner_id!=user.id):
        raise HTTPException(404,'접근 가능한 업로드 영상을 선택하세요.')
    return row


def serialize(db, match, dominance_builder=None):
    state=video_state(match)
    totals={'HOME':0,'AWAY':0,'NONE':0}
    segments=db.query(PossessionSegment).filter_by(match_id=match.id).order_by(PossessionSegment.start_ms).all()
    for s in segments:
        if s.end_ms is not None and s.team in totals:totals[s.team]+=max(0,s.end_ms-s.start_ms)
    events=db.query(Event).filter_by(match_id=match.id).order_by(Event.clock_ms.desc(),Event.created_at.desc()).all()
    keys=('type','clock_ms','team','lane','xg','xgot','shot_x','shot_y','is_goal','is_own_goal','player_number','player_name','is_on_target','goalmouth_x','goalmouth_y')
    meta=match.metadata_json or {}
    # The writer token is scoped to one tab; never publish it to other tabs.
    state.pop('writer',None);state.pop('writer_at',None);state.pop('last_request',None)
    return {'match':{'id':str(match.id),'name':match.name,'home':meta.get('home_team','Home'),'away':meta.get('away_team','Away'),
                     'fixture':meta.get('fla_fixture'),'lineups':meta.get('lineups',{}),'archived':match.archived},
            'state':state,'possession':totals,
            'segments':[{'start_ms':s.start_ms,'end_ms':s.end_ms,'team':s.team} for s in segments],
            'events':[dict(id=str(e.id),created_at=e.created_at.isoformat(),**{k:getattr(e,k) for k in keys}) for e in events],
            'flow':dominance_builder(match.id,60,db)['bins'] if dominance_builder else []}


class VideoLink(BaseModel):
    upload_id: str
    version: int = Field(ge=0)


class Config(VideoLink):
    offset_ms: int = Field(ge=0)
    duration_ms: int = Field(gt=0)


class Segment(BaseModel):
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    team: Team


class Update(BaseModel):
    request_id: UUID
    client_id: UUID
    version: int = Field(ge=0)
    action: Literal['start','save','finish'] = 'save'
    cursor_ms: int = Field(ge=0)
    frontier_ms: int = Field(ge=0)
    possession_team: Team
    selected_team: Literal['HOME','AWAY']
    direction: Literal['L2R','R2L']
    rate: float = Field(ge=.25,le=4,allow_inf_nan=False)
    segments: list[Segment] = Field(default_factory=list,max_length=500)


class VideoEvent(BaseModel):
    event_id: UUID
    client_id: UUID
    type: Literal['ATTACK_LANE','XG']
    clock_ms: int = Field(ge=0)
    team: Literal['HOME','AWAY']
    lane: Literal['LEFT','CENTER','RIGHT'] | None = None
    shot_x: float | None = Field(default=None,ge=20,le=40,allow_inf_nan=False)
    shot_y: float | None = Field(default=None,ge=0,le=20,allow_inf_nan=False)
    xg: float | None = Field(default=None,ge=0,le=1,allow_inf_nan=False)
    goalmouth_x: float | None = Field(default=None,ge=0,le=1,allow_inf_nan=False)
    goalmouth_y: float | None = Field(default=None,ge=0,le=1,allow_inf_nan=False)
    is_goal: bool = False
    is_own_goal: bool = False
    player_number: str = Field(default='',max_length=12)
    player_name: str = Field(default='',max_length=100)


class Reset(BaseModel):
    request_id: UUID
    client_id: UUID
    version: int = Field(ge=0)
    kind: Literal['possession','events','recording']


def claim(state, client_id):
    now=time.time()
    if state.get('writer') not in (None,str(client_id)) and now-state.get('writer_at',0)<30:
        raise HTTPException(409,'다른 창에서 기록 중입니다. 해당 창을 닫고 30초 후 다시 연결하세요.')
    state.update(writer=str(client_id),writer_at=now)


def save_metadata(match,state):
    match.metadata_json={**(match.metadata_json or {}),'fla_video':state}


def update_recording(db, match, body):
    state=video_state(match)
    if not state.get('upload_id'):raise HTTPException(409,'영상과 경기 시작 장면을 먼저 저장하세요.')
    if state.get('configured') is False or not state.get('duration_ms'):raise HTTPException(409,'경기 시작 시각을 먼저 확인하고 저장하세요.')
    if state.get('last_request')==str(body.request_id):return
    if state.get('version',0)!=body.version:raise HTTPException(409,'다른 변경이 저장되었습니다. 새로고침 후 이어서 기록하세요.')
    claim(state,body.client_id)
    frontier=state.get('frontier_ms',0)
    if body.action=='start':
        if state.get('started'):raise HTTPException(409,'이미 시작한 경기입니다.')
        if body.frontier_ms or body.cursor_ms or body.segments:raise HTTPException(400,'시작 장면부터 기록하세요.')
        state['started']=True
    elif not state.get('started'):raise HTTPException(409,'경기 시작을 눌러 주세요.')
    if body.frontier_ms<frontier or body.cursor_ms>body.frontier_ms or body.frontier_ms>state['duration_ms']-state['offset_ms']:
        raise HTTPException(400,'영상 기록 범위를 확인하세요.')
    if state.get('ended') and (body.frontier_ms!=frontier or body.segments):raise HTTPException(409,'종료한 경기의 점유 기록은 확정되었습니다.')
    # A heartbeat cannot turn a seek into minutes of possession. A stopped
    # browser retains its cursor instead of extrapolating elapsed wall time.
    budget=max(0,time.time()-state.get('saved_at',time.time()))*4000+2500
    if body.frontier_ms-frontier>budget:raise HTTPException(400,'앞으로 건너뛴 구간은 점유 기록에 포함할 수 없습니다.')
    cursor=frontier
    for seg in body.segments:
        if seg.start_ms!=cursor or seg.end_ms<=seg.start_ms:raise HTTPException(400,'점유 구간은 중복 없이 이어져야 합니다.')
        cursor=seg.end_ms
    if cursor!=body.frontier_ms:raise HTTPException(400,'점유 구간이 누락되었습니다.')
    for seg in body.segments:
        db.add(PossessionSegment(match_id=match.id,team=seg.team,start_ms=seg.start_ms,end_ms=seg.end_ms))
        apply_possession_segment(db,match.id,seg.team,seg.start_ms,seg.end_ms)
    state.update(version=body.version+1,frontier_ms=body.frontier_ms,cursor_ms=body.cursor_ms,
                 possession_team=body.possession_team,selected_team=body.selected_team,direction=body.direction,rate=body.rate,
                 last_request=str(body.request_id),saved_at=time.time(),ended=state.get('ended',False) or body.action=='finish')
    save_metadata(match,state)
    # Existing FLA summaries use this monotonic clock; replay never rewinds it.
    db.add(State(id=body.request_id,match_id=match.id,clock_ms=body.frontier_ms,running=False,
                 possession_team='NONE',selected_team=body.selected_team,attack_lr=body.direction))


def create_router(dominance_builder=None):
    router=APIRouter(prefix=PREFIX,dependencies=[Depends(same_origin)])

    @router.get('/fixtures')
    def fixtures(user: User=Depends(require_session_user),db: Session=Depends(get_db)):
        uploads=db.query(FpaCvResource).filter_by(kind='upload').all()
        uploads=[u for u in uploads if upload_ready(u) and (user.role=='SUPERADMIN' or u.owner_id==user.id)]
        matches=db.query(Match).filter_by(sport='FUTSAL').all()
        result=[]
        for f in FIXTURES:
            existing=next((m for m in matches if (m.metadata_json or {}).get('fla_fixture',{}).get('key')==f['key']),None)
            result.append({**f,'match_id':str(existing.id) if existing else None,'video':video_state(existing) if existing else {},'candidates':candidates(f,uploads)})
        for f in result:
            for key in ('writer','writer_at','last_request'):f['video'].pop(key,None)
        return {'fixtures':result,'uploads':[public_upload(u) for u in uploads],'can_create':user.role=='SUPERADMIN'}

    @router.post('/fixtures/create')
    def create_fixtures(user: User=Depends(require_session_user),db: Session=Depends(get_db)):
        if user.role!='SUPERADMIN':raise HTTPException(403,'경기 생성은 관리자만 가능합니다.')
        # Deterministic IDs prevent duplicate fixtures. Concurrent retries are safe.
        created=[]
        for f in FIXTURES:
            id=match_id(f['key'])
            if db.get(Match,id):continue
            existing=next((m for m in db.query(Match).filter_by(sport='FUTSAL').all() if (m.metadata_json or {}).get('fla_fixture',{}).get('key')==f['key']),None)
            if existing:continue
            db.add(Match(id=id,name=f"[{f['stage']} {f['round']}경기 · {f['court']}구장] {f['home']} vs {f['away']}",sport='FUTSAL',
                         competition_class='FUTSAL-QUEENCUP',round_number=f['round'],first_half_minutes=15,second_half_minutes=0,
                         metadata_json={'period_mode':'SINGLE','match_minutes':15,'stream_mode':'MANUAL','home_team':f['home'],'away_team':f['away'],
                                        'match_date':f['date'],'kickoff_time':f['time'],'fla_fixture':f}))
            created.append(str(id))
        try:db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409,'다른 창에서 경기를 생성했습니다. 목록을 새로고침하세요.')
        return {'created':created}

    @router.get('/matches/{id}')
    def get(id: UUID,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
        m=get_match(db,id,user)
        return {**serialize(db,m,dominance_builder),'can_write':not m.archived and (not m.operator_id or m.operator_id==user.id or user.role=='SUPERADMIN')}

    @router.put('/matches/{id}/config')
    def configure(id: UUID,body: Config,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
        m=get_match(db,id,user,True);state=video_state(m)
        if state.get('started'):raise HTTPException(409,'기록을 시작한 뒤 영상과 시작 기준을 바꿀 수 없습니다.')
        if state.get('version',0)!=body.version:raise HTTPException(409,'다른 창의 설정을 먼저 불러오세요.')
        if db.query(State).filter_by(match_id=id).first() or db.query(Event).filter_by(match_id=id).first():raise HTTPException(409,'기존 FLA 기록이 있는 경기에는 새 시간 기준을 적용할 수 없습니다.')
        allowed_upload(db,body.upload_id,user)
        if body.offset_ms>=body.duration_ms:raise HTTPException(400,'영상 안의 시작 장면을 선택하세요.')
        save_metadata(m,{'version':body.version+1,'upload_id':body.upload_id,'offset_ms':body.offset_ms,'duration_ms':body.duration_ms,'configured':True,
                         'cursor_ms':0,'frontier_ms':0,'started':False,'ended':False,'possession_team':'NONE','selected_team':'HOME','direction':'L2R','rate':1})
        db.commit();return serialize(db,m,dominance_builder)

    @router.put('/matches/{id}/video')
    def link_video(id: UUID,body: VideoLink,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
        m=get_match(db,id,user,True);state=video_state(m)
        if state.get('started') or db.query(State).filter_by(match_id=id).first() or db.query(Event).filter_by(match_id=id).first():
            raise HTTPException(409,'기록이 있는 경기의 영상 연결은 변경할 수 없습니다.')
        if state.get('version',0)!=body.version:raise HTTPException(409,'다른 창의 설정을 먼저 불러오세요.')
        allowed_upload(db,body.upload_id,user)
        # Match a source without guessing kickoff. The operator must save the
        # actual media start frame before this game can begin recording.
        save_metadata(m,{'version':body.version+1,'upload_id':body.upload_id,'offset_ms':0,'duration_ms':0,'configured':False,
                         'cursor_ms':0,'frontier_ms':0,'started':False,'ended':False,'possession_team':'NONE','selected_team':'HOME','direction':'L2R','rate':1})
        db.commit();return serialize(db,m,dominance_builder)

    @router.get('/uploads/{id}/source')
    def source(id: str,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
        upload=allowed_upload(db,id,user)
        if public_upload(upload)['legacy']:
            job=next((j for j in db.query(FpaCvResource).filter_by(kind='job').all()
                      if j.payload.get('uploadId')==id and j.payload.get('status')=='completed'
                      and j.payload.get('result',{}).get('original') and (user.role=='SUPERADMIN' or j.owner_id==user.id)),None)
            if not job:raise HTTPException(404,'기존 분석의 원본 영상을 찾지 못했습니다.')
            return RedirectResponse(f'/api/tracking/jobs/{job.id}/source',headers={'Cache-Control':'private, no-store'})
        store=storage()
        if not store:raise HTTPException(503,'영상 저장소 설정을 확인하세요.')
        return RedirectResponse(store.url(upload.payload['key']),headers={'Cache-Control':'private, no-store'})

    @router.post('/matches/{id}/recording')
    def recording(id: UUID,body: Update,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
        m=get_match(db,id,user,True);update_recording(db,m,body);db.commit()
        return serialize(db,m,dominance_builder)

    @router.post('/matches/{id}/reset')
    def reset(id: UUID,body: Reset,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
        m=get_match(db,id,user,True);state=video_state(m)
        if state.get('last_reset_request')==str(body.request_id):return serialize(db,m,dominance_builder)
        if state.get('version',0)!=body.version:raise HTTPException(409,'다른 변경을 불러온 후 다시 시도하세요.')
        claim(state,body.client_id)
        if body.kind in ('possession','recording'):
            db.query(PossessionSegment).filter_by(match_id=id).delete(synchronize_session=False)
            state['possession_team']='NONE'
        if body.kind in ('events','recording'):
            db.query(Event).filter_by(match_id=id).delete(synchronize_session=False)
            m.metadata_json={**(m.metadata_json or {}),'fla_video_event_sources':{}}
        for b in db.query(DominanceBin).filter_by(match_id=id).all():
            if body.kind in ('possession','recording'):b.home_poss_ms=b.away_poss_ms=0
            if body.kind in ('events','recording'):b.home_xg=b.away_xg=b.home_attack_score=b.away_attack_score=0
            recompute_dominance(b)
        if body.kind=='recording':
            db.query(State).filter_by(match_id=id).delete(synchronize_session=False)
            state.update(started=False,ended=False,cursor_ms=0,frontier_ms=0)
        state.update(version=body.version+1,last_reset_request=str(body.request_id))
        state.pop('last_request',None)
        save_metadata(m,state);db.commit()
        return serialize(db,m,dominance_builder)

    @router.post('/matches/{id}/events')
    def event(id: UUID,body: VideoEvent,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
        m=get_match(db,id,user,True);state=video_state(m)
        old=db.get(Event,body.event_id)
        if old:
            if old.match_id!=id:raise HTTPException(409,'다른 경기의 기록 ID입니다.')
            return serialize(db,m,dominance_builder)
        if not state.get('started') or body.clock_ms>state.get('frontier_ms',0):raise HTTPException(400,'재생하여 확인한 시각에 기록하세요.')
        claim(state,body.client_id)
        fields={}
        if body.type=='ATTACK_LANE':
            if not body.lane:raise HTTPException(400,'공격 위치를 선택하세요.')
            fields['lane']=body.lane
            apply_attack_event(db,id,body.team,body.clock_ms)
        else:
            if (body.shot_x is None)!=(body.shot_y is None):raise HTTPException(400,'슈팅 좌표를 확인하세요.')
            if body.is_own_goal and body.shot_x is None:raise HTTPException(400,'피치에서 자책골 위치를 선택하세요.')
            if body.is_own_goal:threat=0
            elif body.xg is not None:threat=body.xg
            elif body.shot_x is not None:
                dx=max(.001,40-body.shot_x);dy=body.shot_y-10
                angle=abs(math.atan2(1.5-dy,dx)-math.atan2(-1.5-dy,dx))
                threat=min(.8,.8*math.exp(-.1*math.hypot(dx,dy))*(angle/math.pi)**.55)
            else:raise HTTPException(400,'위협도 또는 슈팅 위치를 입력하세요.')
            if body.is_goal and not body.is_own_goal and (body.goalmouth_x is None or body.goalmouth_y is None):
                raise HTTPException(400,'골문에서 슈팅 도착 위치를 선택하세요.')
            gx=None if body.is_own_goal else body.goalmouth_x
            gy=None if body.is_own_goal else body.goalmouth_y
            target=body.is_goal and not body.is_own_goal
            xgot=estimate_xgot(threat,is_on_target=target,goalmouth_x=gx,goalmouth_y=gy,is_goal=target,
                               is_header=False,is_weak_foot=False,under_pressure=False,one_on_one=False,shot_pace_band='MID')['xgot']
            fields.update(xg=threat,xgot=xgot,shot_x=body.shot_x,shot_y=body.shot_y,goalmouth_x=gx,goalmouth_y=gy,
                          is_goal=body.is_goal or body.is_own_goal,is_on_target=target,is_own_goal=body.is_own_goal,
                          player_number=(body.player_number or None) if not body.is_own_goal else None,
                          player_name=(body.player_name or None) if not body.is_own_goal else None)
            apply_xg_event(db,id,body.team,body.clock_ms,threat*(float(os.getenv('DOM_GOAL_XG_MULTIPLIER','2.5')) if body.is_goal else 1))
        db.add(Event(id=body.event_id,match_id=id,type=body.type,clock_ms=body.clock_ms,team=body.team,**fields))
        sources=deepcopy((m.metadata_json or {}).get('fla_video_event_sources',{}))
        sources[str(body.event_id)]={'upload_id':state['upload_id'],'video_ms':state['offset_ms']+body.clock_ms}
        m.metadata_json={**(m.metadata_json or {}),'fla_video_event_sources':sources,'fla_video':state}
        db.commit();return serialize(db,m,dominance_builder)

    return router
