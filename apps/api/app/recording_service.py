"""Authenticated recording sidecar; existing FLA/broadcast API stays untouched."""
from contextlib import asynccontextmanager
import fcntl
import os
from pathlib import Path
from uuid import UUID
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session
from .auth import require_session_user
from .db import get_db
from .models import Match, User
from .recording_engine import Recorder, ArchiveStore

recorder = None


@asynccontextmanager
async def lifespan(app):
    global recorder
    os.umask(0o077)
    root = Path(os.getenv('RECORDING_ROOT', '/recordings'))
    root.mkdir(parents=True, exist_ok=True)
    guard = (root / '.worker.lock').open('w')
    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    recorder = Recorder(root, ArchiveStore(), os.environ['RECORDING_RTMP_PULL_BASE'],
                        os.environ['RECORDING_RTMP_PUBLIC_BASE'])
    recorder.recover()
    yield
    recorder.close()
    guard.close()


app = FastAPI(title='FPC Basketball Recordings', lifespan=lifespan)


def match_access(match_id: UUID, request: Request, db: Session, user: User):
    match = db.get(Match, match_id)
    if not match or match.sport != 'BASKETBALL':
        raise HTTPException(404, '농구 경기를 찾을 수 없습니다.')
    if request.method != 'GET':
        origin = request.headers.get('origin')
        if origin:
            from urllib.parse import urlsplit
            trusted = {value.strip().rstrip('/') for value in os.getenv(
                'RECORDING_ALLOWED_ORIGINS', 'https://console.fineludens.kr').split(',') if value.strip()}
            if origin.rstrip('/') not in trusted and urlsplit(origin).netloc != request.headers.get('host'):
                raise HTTPException(403, '허용되지 않은 요청입니다.')
        if match.archived and not request.url.path.endswith('/stop'):
            raise HTTPException(409, '보관된 경기에서는 녹화를 변경할 수 없습니다.')
        if user.role != 'SUPERADMIN' and match.operator_id and match.operator_id != user.id:
            raise HTTPException(403, '이 경기의 운영권이 필요합니다.')
    return match


def public_state(state):
    sid = state['id']
    base = f"/api/recordings/matches/{state['match_id']}/{sid}"
    return {k: state[k] for k in ('id', 'status', 'desired', 'created_at', 'updated_at', 'stopped_at',
                                 'preview_at', 'error', 'interruptions')} | {
        'server_url': recorder.public_base,
        'stream_key': state['stream_key'] if state['desired'] else None,
        'duration': sum(p['duration'] for p in state['parts']),
        'bytes': sum(p['bytes'] for p in state['parts']),
        'preview_url': base + '/preview' if state['preview_at'] else None,
        'full_url': base + '/files/full' if state['full_key'] else None,
        'parts': [dict(number=i + 1, duration=p['duration'], bytes=p['bytes'], saved_at=p['saved_at'],
                       url=base + f'/files/{i}') for i, p in enumerate(state['parts'])],
    }


def get_state(match_id, sid):
    try:
        state = recorder.load(str(sid))
    except FileNotFoundError:
        raise HTTPException(404, '녹화본을 찾을 수 없습니다.')
    if state['match_id'] != str(match_id):
        raise HTTPException(404, '녹화본을 찾을 수 없습니다.')
    return state


@app.get('/health')
def health():
    return {'ok': recorder is not None}


@app.get('/api/recordings/matches/{match_id}')
def recordings(match_id: UUID, request: Request, db: Session = Depends(get_db), user: User = Depends(require_session_user)):
    match_access(match_id, request, db, user)
    return {'recordings': [public_state(s) for s in recorder.states(str(match_id))]}


@app.post('/api/recordings/matches/{match_id}/start')
def start(match_id: UUID, request: Request, db: Session = Depends(get_db), user: User = Depends(require_session_user)):
    match_access(match_id, request, db, user)
    try:
        # Starting the ingest host is idempotent; never stop/restart it here.
        if os.getenv('MEDIA_CONTROL_URL') and not any(s['desired'] for s in recorder.states(str(match_id))):
            import json
            import urllib.request
            payload = json.dumps({'action': 'start', 'instance_id': os.getenv('MEDIA_INSTANCE_ID') or None,
                                  'instance_name': os.getenv('MEDIA_INSTANCE_NAME', 'live-admin-media')}).encode()
            req = urllib.request.Request(os.environ['MEDIA_CONTROL_URL'], data=payload,
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.getenv('MEDIA_CONTROL_TOKEN', '')})
            with urllib.request.urlopen(req, timeout=15) as response:
                if not json.load(response).get('ok'):
                    raise RuntimeError('ingest host start failed')
        state = recorder.start(str(match_id))
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    except Exception:
        raise HTTPException(503, '영상 저장소에 연결하지 못했습니다. 녹화 준비를 다시 시도하세요.')
    return public_state(state)


@app.post('/api/recordings/matches/{match_id}/{sid}/stop')
def stop(match_id: UUID, sid: UUID, request: Request, db: Session = Depends(get_db), user: User = Depends(require_session_user)):
    match_access(match_id, request, db, user)
    state = get_state(match_id, sid)
    return public_state(recorder.stop(str(sid)) if state['desired'] else state)


@app.post('/api/recordings/matches/{match_id}/{sid}/retry')
def retry(match_id: UUID, sid: UUID, request: Request, db: Session = Depends(get_db), user: User = Depends(require_session_user)):
    match_access(match_id, request, db, user)
    state = get_state(match_id, sid)
    if state['status'] != 'error':
        raise HTTPException(409, '저장 오류가 있는 녹화만 재시도할 수 있습니다.')
    recorder.retry(str(sid))
    return {'ok': True}


@app.get('/api/recordings/matches/{match_id}/{sid}/preview')
def preview(match_id: UUID, sid: UUID, request: Request, db: Session = Depends(get_db), user: User = Depends(require_session_user)):
    match_access(match_id, request, db, user)
    get_state(match_id, sid)
    path = recorder.path(str(sid)) / 'preview.jpg'
    if not path.exists():
        raise HTTPException(404, '첫 영상 구간을 기다리고 있습니다.')
    return FileResponse(path, media_type='image/jpeg', headers={'Cache-Control': 'private, no-store'})


@app.get('/api/recordings/matches/{match_id}/{sid}/files/{part}')
def video(match_id: UUID, sid: UUID, part: str, request: Request, download: bool = False,
          db: Session = Depends(get_db), user: User = Depends(require_session_user)):
    match_access(match_id, request, db, user)
    state = get_state(match_id, sid)
    if part == 'full':
        key = state['full_key']
    else:
        try:
            index = int(part)
            key = state['parts'][index]['key'] if index >= 0 else None
        except (ValueError, IndexError):
            key = None
    if not key:
        raise HTTPException(404, '저장된 영상을 찾을 수 없습니다.')
    return RedirectResponse(recorder.store.url(key, download), status_code=307,
                            headers={'Cache-Control': 'private, no-store'})
