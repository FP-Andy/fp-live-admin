"""Owned upload library and browser-to-S3 multipart transfer."""
import math
import re
import time
import uuid
from pathlib import PurePath

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .auth import require_session_user
from .db import get_db
from .models import FpaCvResource, User
from .fpa_cv import owned, body_json, register, remote, MAX_UPLOAD
from .fpa_cv_storage import storage

router=APIRouter()
PART_SIZE=32*1024**2
EXTENSIONS={'.mp4','.mov','.m4v','.avi','.mkv','.webm'}

def store():
    value=storage()
    if value is None:raise HTTPException(503,'S3 업로드 설정이 필요합니다.')
    return value

def public(row):
    return {k:v for k,v in row.payload.items() if k not in {'key','multipartId'}}

@router.get('/uploads')
def listing(user: User=Depends(require_session_user),db: Session=Depends(get_db)):
    query=db.query(FpaCvResource).filter_by(kind='upload')
    if user.role!='SUPERADMIN':query=query.filter_by(owner_id=user.id)
    return {'uploads':sorted((public(row) for row in query.all() if row.payload.get('storage')=='s3'),key=lambda x:x.get('createdAt',0),reverse=True)}

@router.post('/uploads/multipart',status_code=201)
async def begin(request: Request,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
    value=await body_json(request);size=value.get('size');name=str(value.get('name','')).replace('\\','/').split('/')[-1]
    name=re.sub(r'[\x00-\x1f\x7f]','',name)[:180];suffix=PurePath(name).suffix.lower()
    if type(size) is not int or not 0<size<=MAX_UPLOAD or suffix not in EXTENSIONS:raise HTTPException(400,'20GB 이하 영상 파일을 선택하세요.')
    uid=uuid.uuid4().hex;key=f'fpa-cv/uploads/{uid}/source{suffix}'
    multipart=await run_in_threadpool(store().begin,key,'video/mp4' if suffix in {'.mp4','.m4v'} else 'application/octet-stream')
    payload={'id':uid,'name':name,'size':size,'file':'source'+suffix,'key':key,'multipartId':multipart,'storage':'s3','status':'uploading','partSize':PART_SIZE,'createdAt':time.time()}
    try:register(db,payload,'upload',user)
    except Exception:
        await run_in_threadpool(store().abort,key,multipart);raise
    return public(owned(db,uid,user,'upload'))

@router.post('/uploads/{uid}/parts')
async def parts(uid: str,request: Request,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
    row=owned(db,uid,user,'upload');p=row.payload;value=await body_json(request);numbers=value.get('parts')
    if p.get('status')!='uploading':raise HTTPException(409,'전송 가능한 업로드가 아닙니다.')
    total=math.ceil(p['size']/p['partSize'])
    if not isinstance(numbers,list) or not 1<=len(numbers)<=10 or any(type(n) is not int or not 1<=n<=total for n in numbers):raise HTTPException(400,'업로드 조각을 확인하세요.')
    return {'parts':[{'number':n,'url':store().part_url(p['key'],p['multipartId'],n)} for n in numbers]}

@router.post('/uploads/{uid}/complete')
async def complete(uid: str,request: Request,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
    row=owned(db,uid,user,'upload',lock=True);p=dict(row.payload)
    if p.get('status')=='uploaded':return public(row)
    if p.get('status')!='uploading':raise HTTPException(409,'전송 상태를 확인하세요.')
    value=await body_json(request);parts=value.get('parts',[]);total=math.ceil(p['size']/p['partSize'])
    if not isinstance(parts,list) or len(parts)!=total or any(not isinstance(x,dict) for x in parts):raise HTTPException(400,'영상 전송이 아직 완료되지 않았습니다.')
    if [x.get('PartNumber') for x in parts]!=list(range(1,total+1)) or any(not isinstance(x.get('ETag'),str) or not re.fullmatch(r'"?[a-fA-F0-9]{32}(?:-\d+)?"?',x['ETag']) for x in parts):raise HTTPException(400,'업로드 조각이 일치하지 않습니다.')
    s=store()
    # Retry after a lost completion response may find an already-created object.
    try:await run_in_threadpool(s.finish,p['key'],p['multipartId'],parts)
    except Exception as error:
        if getattr(error,'response',{}).get('Error',{}).get('Code')!='NoSuchUpload':raise
    head=await run_in_threadpool(s.head,p['key'])
    if head['ContentLength']!=p['size']:raise HTTPException(409,'저장된 영상 크기를 확인하지 못했습니다.')
    p.update(status='uploaded',uploadedAt=time.time());row.payload=p;db.commit()
    return public(row)

@router.get('/uploads/{uid}/source')
def source(uid: str,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
    p=owned(db,uid,user,'upload').payload
    if p.get('status')!='uploaded':raise HTTPException(409,'업로드 완료 후 영상을 열 수 있습니다.')
    return RedirectResponse(store().url(p['key']),headers={'Cache-Control':'private, no-store'})

@router.post('/uploads/{uid}/remove')
async def remove(uid: str,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
    row=owned(db,uid,user,'upload',lock=True);p=row.payload
    from .futsal_fla_video import video_references
    if video_references(db,uid):raise HTTPException(409,'FLA 경기에 연결된 원본 영상은 삭제할 수 없습니다.')
    refs=[r for r in db.query(FpaCvResource).filter_by(kind='job').all() if r.payload.get('uploadId')==uid]
    if any(r.payload.get('kind')!='preparation' for r in refs):raise HTTPException(409,'연결된 분석을 삭제한 분석에서 먼저 영구 삭제하세요.')
    if any(r.payload.get('status') in {'queued','starting','running','cancelling'} for r in refs):raise HTTPException(409,'초기 장면 검출이 끝난 후 삭제하세요.')
    # Check/remove worker references before deleting the durable source.
    if refs:await remote(f'uploads/{uid}/remove','POST',json={})
    s=store()
    if p.get('status')=='uploading':
        try:await run_in_threadpool(s.abort,p['key'],p['multipartId'])
        except Exception as e:
            if getattr(e,'response',{}).get('Error',{}).get('Code')!='NoSuchUpload':raise
    await run_in_threadpool(s.delete,p['key'])
    for r in refs:db.delete(r)
    db.delete(row);db.commit()
    return {'removed':True,'id':uid}


@router.post('/batch/start')
async def start_batch(request: Request,user: User=Depends(require_session_user),db: Session=Depends(get_db)):
    ids=(await body_json(request)).get('ids')
    if not isinstance(ids,list) or not 1<=len(ids)<=100 or any(not isinstance(uid,str) for uid in ids) or len(set(ids))!=len(ids):raise HTTPException(400,'분석할 경기를 선택하세요.')
    rows={uid:owned(db,uid,user) for uid in ids}
    result=await remote('batch/start','POST',json={'ids':ids})
    for value in result['jobs']:rows[value['id']].payload=value
    db.commit()
    return result
