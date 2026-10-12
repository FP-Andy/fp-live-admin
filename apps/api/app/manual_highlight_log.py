"""Portable manual work logs are files, not large blobs on every job-list query."""
import json
import math
import os
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .auth import require_admin
from .db import get_db
from .highlight_jobs import job_dir
from .highlight_render_queue import ensure_editable
from .models import HighlightJob, User

router = APIRouter()
MAX_LOG_BYTES = 100 * 1024 * 1024
TAG_KINDS = {'home_goal', 'home', 'away', 'away_goal', 'home_goal_only', 'away_goal_only',
             'substitution', 'section'} | {f'bb_{side}_{points}{suffix}' for side in ('home', 'away')
                                          for points in (1, 2, 3) for suffix in ('', '_only')}


def validate_log(payload):
    def number(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if not isinstance(payload, dict) or payload.get('format') != 'fpc-highlight-log' or payload.get('version') != 1:
        raise ValueError('지원하지 않는 하이라이트 로그입니다.')
    if payload.get('sport') not in ('FOOTBALL', 'FUTSAL', 'BASKETBALL'):
        raise ValueError('종목을 확인하세요.')
    sources = payload.get('sources')
    if not isinstance(sources, list) or not 1 <= len(sources) <= 100:
        raise ValueError('원본 영상 정보가 필요합니다.')
    for source in sources:
        if (not isinstance(source, dict) or not isinstance(source.get('name'), str)
                or not number(source.get('size')) or source['size'] <= 0
                or not number(source.get('duration')) or source['duration'] <= 0):
            raise ValueError('원본 영상 정보가 올바르지 않습니다.')
    work = payload.get('work')
    if not isinstance(work, dict) or not isinstance(work.get('tags'), list) or len(work['tags']) > 50000:
        raise ValueError('태그 목록을 확인하세요.')
    ids = set()
    total = sum(source['duration'] for source in sources)
    for tag in work['tags']:
        if (not isinstance(tag, dict) or not isinstance(tag.get('id'), str) or not tag['id'] or tag['id'] in ids
                or not number(tag.get('t')) or not 0 <= tag['t'] <= total + .1
                or tag.get('kind') is not None and tag['kind'] not in TAG_KINDS
                or any(key in tag and (not number(tag[key]) or tag[key] < 0) for key in ('before', 'after'))):
            raise ValueError('태그 시각 또는 종류가 올바르지 않습니다.')
        ids.add(tag['id'])
    for key in ('padBefore', 'padAfter'):
        if not number(work.get(key)) or work[key] < 0:
            raise ValueError('클립 앞뒤 구간을 확인하세요.')
    return payload


def require_job(db, job_id, user):
    job = db.get(HighlightJob, job_id)
    if not job or job.mode != 'manual':
        raise HTTPException(404, '수동 하이라이트 작업을 찾을 수 없습니다.')
    if user.role != 'SUPERADMIN' and job.owner_id != user.id:
        raise HTTPException(403, '본인 작업만 접근할 수 있습니다.')
    return job


@router.put('/api/highlight/manual-jobs/{job_id}/log')
def upload_log(job_id: str, file: UploadFile = File(...), db: Session = Depends(get_db),
                     user: User = Depends(require_admin)):
    job = ensure_editable(db, require_job(db, job_id, user))
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)
    temporary = folder / f'.highlight-log-{uuid.uuid4().hex}.json'
    try:
        size = 0
        with temporary.open('wb') as output:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_LOG_BYTES:
                    raise HTTPException(413, '하이라이트 로그는 100MB까지 저장할 수 있습니다.')
                output.write(chunk)
        try:
            payload = validate_log(json.loads(temporary.read_text(encoding='utf-8')))
        except (ValueError, TypeError, KeyError, UnicodeError) as exc:
            raise HTTPException(400, str(exc)) from exc
        if payload['sport'] != (job.job_metadata or {}).get('sport', 'FOOTBALL'):
            raise HTTPException(400, '작업과 JSON 로그의 종목이 다릅니다.')
        os.replace(temporary, folder / 'highlight-log.json')
        job.job_metadata = {**(job.job_metadata or {}), 'highlight_log': {
            'version': 1, 'tag_count': len(payload['work']['tags']), 'bytes': size}}
        db.commit()
        return {'ok': True, 'tag_count': len(payload['work']['tags'])}
    finally:
        temporary.unlink(missing_ok=True)
        file.file.close()


@router.get('/api/highlight/manual-jobs/{job_id}/log')
def download_log(job_id: str, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    require_job(db, job_id, user)
    path = job_dir(job_id) / 'highlight-log.json'
    if not path.exists():
        raise HTTPException(404, '이 작업에는 저장된 JSON 로그가 없습니다.')
    return FileResponse(path, media_type='application/json', filename=f'highlight-log-{job_id[:8]}.json')
