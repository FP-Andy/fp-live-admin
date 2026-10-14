"""Authenticated RF-DETR queue; immutable cumulative evidence, never snapshot edits."""
import hashlib
import json
import math
import time
import uuid
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session
from .auth import require_session_user
from .db import get_db
from .models import FpaCvResource, User
from .fpa_cv import owned, body_json, remote
from .fpa_cv_storage import storage
from .fla_substitutions import saved_substitutions
from .futsal_analysis_snapshots import router, read_snapshot
from .futsal_substitution_redetection import context_match, log_context, save_recovery, select_recovery

KIND='sub_recovery_job'
ACTIVE={'dispatching','queued','starting','running','cancelling'}


def authorized(db, sid, user, write=False):
    snap=owned(db,sid,user,'analysis_snapshot',lock=write)
    match=context_match(db,snap)
    if write:
        from .futsal_fla_video import get_match
        get_match(db,match.id,user,True,substitutions=True)
    return snap,match,saved_substitutions(match)


def load_evidence(row):
    if not row:return None
    store=storage();content=store.client.get_object(Bucket=store.bucket,Key=store.key(row.payload['key']))['Body'].read()
    if hashlib.sha256(content).hexdigest()!=row.payload['sha256']:raise HTTPException(503,'보강 원본의 체크섬을 확인하세요.')
    return json.loads(content)


def bounded_plan(value,snap,document,source,saved,base):
    if not isinstance(value,dict) or value.get('snapshotId')!=snap.id or value.get('logRevision')!=saved['revision'] or value.get('logContext')!=log_context(saved['log']):
        raise HTTPException(409,'최신 교체로그로 다시 계산한 뒤 보강하세요.')
    if value.get('baseRecoveryId')!=(base.id if base else None):raise HTTPException(409,'기존 보강 결과가 바뀌었습니다. 새로 계산하세요.')
    windows=value.get('windows');start,end=snap.payload['from'],snap.payload['to'];budget=min(80,(end-start)*.05)
    if not isinstance(windows,list) or not 1<=len(windows)<=8 or any(not isinstance(w,dict) for w in windows):raise HTTPException(400,'보강할 구간이 없습니다. 최대 8구간을 선택하세요.')
    events={e['id'] for e in (saved['log'] or {}).get('substitutions',[])}
    total=0;clean=[];last=-1
    for w in sorted(windows,key=lambda w:w.get('from',-1)):
        a,z=w.get('from'),w.get('to')
        if (type(a) not in (int,float) or type(z) not in (int,float) or not math.isfinite(a+z)
                or a<start-1e-6 or z>end+1e-6 or not 0<z-a<=80 or a<last
                or not isinstance(w.get('eventIds'),list) or not w['eventIds'] or not set(w['eventIds'])<=events):
            raise HTTPException(400,'보강 구간·대상 교체로그를 확인하세요.')
        last=z;total+=z-a
        clean.append({'from':a,'to':z,'eventIds':sorted(set(w['eventIds'])),'personIds':['sub-'+i for i in sorted(set(w['eventIds']))]})
    if total>budget+.001:raise HTTPException(400,'한 번의 보강은 영상 길이의 5%, 최대 80초까지 가능합니다.')
    roi=(source.payload.get('options') or {}).get('roi') or (document.get('review',{}).get('setup') or {}).get('roi')
    if not isinstance(roi,list) or len(roi)!=4:raise HTTPException(409,'확정된 코트 좌표가 필요합니다.')
    previous=load_evidence(base)
    first=max([w['id'] for w in (previous or {}).get('windows',[])],default=0)+1
    if first+len(clean)>=1000000 or len((previous or {}).get('windows',[]))+len(clean)>200:raise HTTPException(409,'누적 보강 구간 한도입니다. 기존 결과를 검수하세요.')
    return {'schema':'fpa-substitution-redetection/v1','purpose':'track-continuation','preferredDetector':'rfdetr','scope':'court',
            'snapshotId':snap.id,'datasetId':snap.payload['datasetId'],'logRevision':saved['revision'],'logContext':log_context(saved['log']),
            'baseRecoveryId':base.id if base else None,'video':{'name':saved['log']['video']['name'],'duration':saved['log']['video']['duration']},
            'model':'yolo26s.pt','roi':roi,'uniforms':document.get('review',{}).get('uniforms',{}),
            'windows':[{**w,'id':first+i} for i,w in enumerate(clean)],'totalSeconds':total,'maxVideoSeconds':budget}


def public(row):
    p=row.payload
    return {k:p[k] for k in ('id','snapshotId','status','stage','progress','eta','elapsed','error','createdAt','finishedAt','windowCount','totalSeconds','recoveryId','offline') if k in p}


async def dispatch(db,row,user):
    p=row.payload;upload=owned(db,p['uploadId'],user,'upload')
    if upload.payload.get('storage')!='s3' or upload.payload.get('status')!='uploaded':raise HTTPException(409,'S3 업로드가 완료된 영상을 선택하세요.')
    u=upload.payload
    await remote('uploads/register','POST',json={k:u[k] for k in ('id','name','size','file','key','storage','createdAt')})
    v=await remote('recoveries','POST',json={'id':row.id,'uploadId':upload.id,'plan':p['plan']})
    row.payload={**p,**{k:v[k] for k in ('status','stage','progress') if k in v}};db.commit()
    return public(row)


@router.post('/{snapshot_id}/recovery-jobs',status_code=202)
async def start_recovery(snapshot_id:str,request:Request,user:User=Depends(require_session_user),db:Session=Depends(get_db)):
    snap,match,saved=authorized(db,snapshot_id,user,True)
    value=await body_json(request)
    for row in db.query(FpaCvResource).filter_by(kind=KIND,owner_id=snap.owner_id).all():
        if row.payload.get('snapshotId')==snap.id and row.payload['status'] in ACTIVE:
            if row.payload['status']=='dispatching':return await dispatch(db,row,user)
            return public(row)
    base=select_recovery(db,snap,saved)
    if base and base.payload['logContext']!=log_context(saved['log']):raise HTTPException(409,'교체 시각 변경으로 이전 보강이 오래되었습니다.')
    document=json.loads(read_snapshot(snap.id,user,db).body);source=owned(db,snap.payload['jobId'],user)
    plan=bounded_plan(value.get('plan'),snap,document,source,saved,base)
    fingerprint=hashlib.sha256(json.dumps(plan,sort_keys=True).encode()).hexdigest()
    rows=db.query(FpaCvResource).filter_by(kind=KIND,owner_id=snap.owner_id).all()
    for row in rows:
        if row.payload.get('fingerprint')==fingerprint and row.payload['status']=='completed':return public(row)
    jid=uuid.uuid4().hex
    row=FpaCvResource(id=jid,kind=KIND,owner_id=snap.owner_id,payload={'id':jid,'snapshotId':snap.id,'uploadId':snap.payload['uploadId'],
        'resultId':uuid.uuid4().hex,'status':'dispatching','stage':'GPU 연결 중','progress':0,'createdAt':time.time(),'plan':plan,'fingerprint':fingerprint,
        'windowCount':len(plan['windows']),'totalSeconds':plan['totalSeconds']})
    db.add(row);db.commit()
    return await dispatch(db,row,user)


async def synchronize(db,row,snap,saved,user):
    row=db.query(FpaCvResource).filter_by(id=row.id).with_for_update().populate_existing().one()
    p=row.payload
    if p['status'] not in ACTIVE:return public(row)
    try:v=await remote('jobs/'+row.id)
    except HTTPException as e:
        if e.status_code==404 and p['status']=='dispatching':return await dispatch(db,row,user)
        return {**public(row),'offline':True,'stage':'GPU 연결 대기 · 저장된 작업 유지'}
    fields={k:v[k] for k in ('status','stage','progress','eta','elapsed','error','finishedAt') if k in v}
    if v['status']=='completed':
        if p['plan']['logContext']!=log_context(saved['log']):fields.update(status='stale',stage='교체로그 변경 · 결과 보존',error='현재 교체 시각이 달라 자동 반영하지 않았습니다.')
        else:
            base_id=p['plan'].get('baseRecoveryId');base=owned(db,base_id,user,'sub_redetection') if base_id else None
            current=select_recovery(db,snap,saved)
            if (current.id if current else None) not in (base_id,p['resultId']):
                fields.update(status='stale',stage='보강 기준 변경 · 결과 보존',error='다른 보강 결과가 먼저 반영되었습니다.')
            else:
                key=v.get('s3Assets',{}).get('recovery.json')
                if key!=f'fpa-cv/jobs/{row.id}/recovery.json':raise HTTPException(502,'보강 결과 경로를 확인하세요.')
                store=storage();content=store.client.get_object(Bucket=store.bucket,Key=store.key(key))['Body'].read()
                if len(content)>32*1024**2:raise HTTPException(413,'보강 결과가 너무 큽니다.')
                result=json.loads(content);previous=load_evidence(base)
                if result.get('id')!=row.id or result.get('windows') is None:raise HTTPException(502,'보강 결과 ID를 확인하세요.')
                # Preserve every earlier box ID so explicit human selections remain valid.
                result={**result,'id':p['resultId'],'logRevision':saved['revision'],'windows':(previous or {}).get('windows',[])+result['windows'],
                        'parentRecoveryId':base_id,'ancestorIds':list(dict.fromkeys(([base_id] if base_id else [])+(base.payload.get('ancestorIds',[]) if base else [])))}
                existing=db.get(FpaCvResource,p['resultId'])
                if not existing:save_recovery(db,snap,user,result,trusted_parent=base,commit=False)
                elif existing.kind!='sub_redetection' or existing.payload.get('snapshotId')!=snap.id:raise HTTPException(409,'보강 결과 ID 충돌입니다.')
                fields.update(status='completed',stage='보강 반영 완료',recoveryId=p['resultId'])
    row.payload={**p,**fields};db.commit();return public(row)


@router.get('/{snapshot_id}/recovery-jobs')
async def recovery_jobs(snapshot_id:str,user:User=Depends(require_session_user),db:Session=Depends(get_db)):
    snap,_,saved=authorized(db,snapshot_id,user)
    rows=[r for r in db.query(FpaCvResource).filter_by(kind=KIND,owner_id=snap.owner_id).all() if r.payload.get('snapshotId')==snap.id]
    rows.sort(key=lambda r:r.payload['createdAt'],reverse=True)
    # Polling imports completed GPU output even after the original browser closed.
    values=[]
    for row in rows[:10]:values.append(await synchronize(db,row,snap,saved,user))
    return {'jobs':values}


@router.post('/{snapshot_id}/recovery-jobs/{job_id}/cancel')
async def cancel_recovery(snapshot_id:str,job_id:str,user:User=Depends(require_session_user),db:Session=Depends(get_db)):
    snap,_,_=authorized(db,snapshot_id,user,True);row=owned(db,job_id,user,KIND)
    if row.payload['snapshotId']!=snap.id:raise HTTPException(404)
    if row.payload['status']=='dispatching':
        # An earlier enqueue timeout can mean the worker did accept it.
        try:await remote('jobs/'+row.id+'/cancel','POST',json={})
        except HTTPException as e:
            if e.status_code!=404:raise
        row.payload={**row.payload,'status':'cancelled','stage':'보강 중단','finishedAt':time.time()}
    elif row.payload['status'] in ACTIVE:
        v=await remote('jobs/'+row.id+'/cancel','POST',json={});row.payload={**row.payload,'status':v['status'],'stage':'보강 중단 중'}
    db.commit();return public(row)
