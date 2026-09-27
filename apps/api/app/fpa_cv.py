"""Authenticated FPC gateway to the private, persistent FPA GPU service."""
import json
import os
import re
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .auth import require_session_user
from .db import get_db
from .models import FpaCvResource, User

MAX_UPLOAD = 20 * 1024**3
ID = re.compile(r"^[a-f0-9]{32}$")
OPERATIONS = {'cancel', 'retry', 'delete', 'restore', 'purge'}
ASSETS = {'tracks.json', 'preview.mp4', 'source', 'detections.json', 'frame.png', 'initial-review.json'}


def same_origin(request: Request):
    origin = request.headers.get('origin')
    # CloudFront replaces Host with the EC2 origin hostname. Trust explicitly
    # configured public origins, never a client-supplied X-Forwarded-Host.
    trusted = {value.strip() for value in os.getenv('FPA_CV_ALLOWED_ORIGINS', '').split(',') if value.strip()}
    if origin and origin not in trusted and urlsplit(origin).netloc != request.headers.get('host'):
        raise HTTPException(403, '같은 FPC 화면에서 요청하세요.')


router = APIRouter(prefix='/api/tracking', dependencies=[Depends(same_origin)])


def connection():
    base = os.getenv('FPA_CV_WORKER_URL', '').rstrip('/')
    token = os.getenv('FPA_CV_WORKER_TOKEN', '')
    if not base or not token:
        raise HTTPException(503, 'AWS 분석 연결 준비 중입니다. 연결 완료 후 새 분석을 시작할 수 있습니다.')
    return base, {'Authorization': 'Bearer ' + token}


def owned(db, key, user, kind='job', lock=False):
    if not ID.fullmatch(key):
        raise HTTPException(404, '분석을 찾지 못했습니다.')
    query = db.query(FpaCvResource).filter_by(id=key, kind=kind)
    if lock:
        query = query.with_for_update()
    row = query.first()
    if not row or (row.owner_id != user.id and user.role != 'SUPERADMIN'):
        raise HTTPException(404, '분석을 찾지 못했습니다.')
    return row


async def body_json(request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 16 * 1024**2:
            raise HTTPException(413, '저장 내용은 최대 16MB입니다.')
    try:
        value = json.loads(raw or b'{}')
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise HTTPException(400, '요청 형식을 확인하세요.')


async def remote(path, method='GET', **kwargs):
    base, headers = connection()
    headers.update(kwargs.pop('headers', {}))
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=5)) as client:
            response = await client.request(method, base + '/api/tracking/' + path, headers=headers, **kwargs)
        value = response.json()
        if not response.is_success:
            raise HTTPException(response.status_code, value.get('detail', '분석 서버 요청 실패'))
        return value
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, 'AWS 분석 서버에 연결하지 못했습니다. GPU 상태를 확인하세요.')


def register(db, value, kind, user):
    if not ID.fullmatch(str(value.get('id', ''))):
        raise HTTPException(502, '분석 서버 응답을 확인하세요.')
    db.add(FpaCvResource(id=value['id'], kind=kind, owner_id=user.id, payload=value))
    db.commit()
    return value


@router.get('/capabilities')
async def capabilities(user: User = Depends(require_session_user)):
    try:
        result = await remote('capabilities')
    except HTTPException as error:
        result = {'ready': False, 'checking': False, 'error': error.detail, 'gpu': None}
    return {**result, 'execution': 'aws', 'reviewStorage': 'server', 'model': 'YOLO26s', 'maxUploadBytes': MAX_UPLOAD}


@router.post('/uploads', status_code=201)
async def upload(request: Request, name: str, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    try:
        size = int(request.headers.get('content-length', '0'))
    except ValueError:
        size = 0
    if not 0 < size <= MAX_UPLOAD:
        raise HTTPException(413, '영상은 20GB 이하로 선택하세요.')
    # Stream directly to GPU storage; never buffer a match on the app disk.
    value = await remote('uploads', 'POST', params={'name': name}, content=request.stream(),
                         headers={'Content-Length': str(size), 'Content-Type': 'application/octet-stream'})
    return register(db, value, 'upload', user)


@router.post('/uploads/check')
async def check_upload(user: User = Depends(require_session_user)):
    # Reject auth/origin/worker failures before the browser sends gigabytes.
    result = await remote('capabilities')
    if not result.get('ready'):
        raise HTTPException(503, result.get('error') or 'AWS 분석 서버를 준비하고 있습니다. 잠시 후 다시 시도하세요.')
    return {'ready': True}


@router.get('/jobs')
async def jobs(user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    query = db.query(FpaCvResource).filter_by(kind='job')
    if user.role != 'SUPERADMIN':
        query = query.filter_by(owner_id=user.id)
    rows = {row.id: row for row in query.all()}
    try:
        listing = await remote('jobs')
        for key in ('jobs', 'deleted'):
            for item in listing.get(key, []):
                if item['id'] in rows:
                    rows[item['id']].payload = item
        db.commit()
        return {key: [j for j in listing.get(key, []) if j['id'] in rows] for key in ('jobs', 'deleted')}
    except HTTPException:
        values = [r.payload for r in rows.values() if r.payload.get('kind') != 'preparation']
        return {'jobs': [j for j in values if not j.get('deletedAt')], 'deleted': [j for j in values if j.get('deletedAt')], 'offline': True}


@router.post('/{kind}', status_code=202)
async def create(kind: str, request: Request, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    if kind not in {'jobs', 'preparations'}:
        raise HTTPException(404)
    value = await body_json(request)
    owned(db, str(value.get('uploadId', '')), user, 'upload')
    if kind == 'jobs':
        owned(db, str((value.get('setup') or {}).get('preparationId', '')), user)
    return register(db, await remote(kind, 'POST', json=value), 'job', user)


@router.get('/jobs/{job_id}')
async def job(job_id: str, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    row = owned(db, job_id, user)
    value = await remote('jobs/' + job_id)
    row.payload = value
    db.commit()
    return {**value, 'reviewStorage': 'server'}


@router.get('/jobs/{job_id}/review')
def read_review(job_id: str, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    row = owned(db, job_id, user)
    return {'version': row.review_version, 'review': row.review}


@router.put('/jobs/{job_id}/review')
async def save_review(job_id: str, request: Request, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    value = await body_json(request)
    row = owned(db, job_id, user, lock=True)
    review = value.get('review')
    if not isinstance(review, dict) or not row.payload.get('datasetId') or review.get('datasetId') != row.payload['datasetId']:
        raise HTTPException(400, '이 분석의 검수 데이터만 저장할 수 있습니다.')
    if value.get('version') != row.review_version:
        raise HTTPException(409, '다른 창에서 검수를 수정했습니다. 작업 백업 후 다시 열어 주세요.')
    row.review = review
    row.review_version += 1
    db.commit()
    return {'version': row.review_version}


@router.post('/jobs/{job_id}/{operation}')
async def action(job_id: str, operation: str, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    if operation not in OPERATIONS:
        raise HTTPException(404)
    row = owned(db, job_id, user)
    value = await remote(f'jobs/{job_id}/{operation}', 'POST', json={})
    if operation == 'purge':
        # Row and server review are deleted together only after files are gone.
        if value.get('sourceDeleted'):
            upload_id=row.payload.get('uploadId')
            for related in db.query(FpaCvResource).all():
                if related.id == upload_id or (related.payload.get('uploadId') == upload_id and related.payload.get('kind') == 'preparation'):
                    db.delete(related)
        db.delete(row)
        db.commit()
    elif operation == 'retry':
        register(db, value, 'job', user)
    else:
        row.payload = value
        db.commit()
    return value


@router.get('/jobs/{job_id}/{asset}')
async def asset(job_id: str, asset: str, request: Request, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    owned(db, job_id, user)
    if asset not in ASSETS:
        raise HTTPException(404)
    base, headers = connection()
    if request.headers.get('range'):
        headers['Range'] = request.headers['range']
    client = httpx.AsyncClient(timeout=httpx.Timeout(120, connect=5))
    try:
        response = await client.send(client.build_request('GET', f'{base}/api/tracking/jobs/{job_id}/{asset}', headers=headers), stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(503, 'AWS 분석 결과를 불러오지 못했습니다.')
    async def chunks():
        try:
            async for chunk in response.aiter_raw():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()
    allowed = {'content-type', 'content-length', 'content-range', 'accept-ranges'}
    return StreamingResponse(chunks(), status_code=response.status_code,
                             headers={**{k: v for k, v in response.headers.items() if k in allowed}, 'Cache-Control': 'private, no-store'})
