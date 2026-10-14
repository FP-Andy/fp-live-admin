"""Immutable, private redetection evidence for human substitution review."""
import hashlib
import json
import math
from datetime import datetime, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .auth import require_session_user
from .db import get_db
from .models import FpaCvResource, Match, User
from .fpa_cv import ID, owned
from .fpa_cv_storage import storage
from .fla_substitutions import saved_substitutions
from .futsal_analysis_snapshots import router

RESOURCE_KIND = 'sub_redetection'
REVIEWED_KIND = 'sub_reviewed_report'


def reviewed_manifest(db, snapshot, saved, recovery):
    """Only reuse a reviewed derivative against exactly the sources reviewed.

    The immutable analysis snapshot and the operator's substitution log remain
    unchanged. A new log revision or recovery invalidates the derivative.
    """
    rows = db.query(FpaCvResource).filter_by(kind=REVIEWED_KIND, owner_id=snapshot.owner_id).all()
    rows = [r for r in rows if r.payload.get('snapshotId') == snapshot.id]
    rows.sort(key=lambda r: r.payload.get('createdAt', ''), reverse=True)
    for row in rows:
        p = row.payload
        if (p.get('logRevision') == saved['revision']
                and p.get('matchId') == snapshot.payload.get('matchId')
                and p.get('jobId') == snapshot.payload.get('jobId')
                and p.get('redetectionId') == (recovery.id if recovery else None)
                and (not recovery or recovery.payload['logContext'] == log_context(saved['log']))):
            return row
    return None


@router.get('/{snapshot_id}/reviewed-report')
def read_reviewed_report(snapshot_id: str, review_id: str,
                         user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    snapshot = owned(db, snapshot_id, user, 'analysis_snapshot')
    saved = saved_substitutions(context_match(db, snapshot))
    recovery = select_recovery(db, snapshot, saved)
    row = reviewed_manifest(db, snapshot, saved, recovery)
    if not row or row.id != review_id:
        raise HTTPException(409, '검수 결과의 원본이 변경되었습니다. 새로 불러오세요.')
    try:
        store = storage()
        content = store.client.get_object(Bucket=store.bucket, Key=store.key(row.payload['key']))['Body'].read()
        if hashlib.sha256(content).hexdigest() != row.payload['sha256']:
            raise ValueError('checksum')
        result = json.loads(content)
        provenance = result['provenance']
        expected = {k: row.payload.get(k) for k in ('snapshotId', 'jobId', 'matchId', 'logRevision', 'redetectionId')}
        if any(provenance.get(k) != v for k, v in expected.items()) or provenance.get('reviewedReportId') != row.id:
            raise ValueError('provenance')
    except Exception as error:
        raise HTTPException(503, '저장된 검수 결과를 확인하지 못했습니다. 다시 시도하세요.') from error
    return JSONResponse(result, headers={'Cache-Control': 'private, no-store'})


def log_context(log):
    if not log:
        return None
    return {'video': {k: log['video'][k] for k in ('name', 'duration', 'from', 'to')},
            'events': sorted([{'id': e['id'], 'time': e['time'], 'team': e['team']}
                              for e in log['substitutions']], key=lambda e: e['id'])}


def context_match(db, snapshot):
    match = db.get(Match, UUID(snapshot.payload['matchId'])) if snapshot.payload.get('matchId') else None
    if not match or (match.metadata_json or {}).get('fla_video', {}).get('upload_id') != snapshot.payload.get('uploadId'):
        raise HTTPException(409, '현재 경기와 분석 영상의 연결을 확인하세요.')
    return match


def validate_recovery(value, snapshot, saved):
    finite = lambda x: type(x) in (int, float) and math.isfinite(x)
    if (not isinstance(value, dict) or value.get('schema') != 'fpa-substitution-redetection/v1'
            or not ID.fullmatch(str(value.get('id', ''))) or value.get('snapshotId') != snapshot.id
            or value.get('datasetId') != snapshot.payload.get('datasetId')
            or value.get('logContext') != log_context(saved['log'])
            or value.get('logRevision') != saved['revision']):
        raise HTTPException(409, '현재 스냅샷·교체로그에 맞는 재탐지 결과를 등록하세요.')
    context = value['logContext']
    video = value.get('video') or {}
    # Browser logs store milliseconds; decoder durations retain frame precision.
    if (not context or video.get('name') != context['video']['name']
            or not finite(video.get('duration')) or abs(video['duration']-context['video']['duration']) > .2):
        raise HTTPException(400, '재탐지 영상 정보를 확인하세요.')
    roi = value.get('roi')
    if not isinstance(roi, list) or len(roi) != 4 or any(not isinstance(p, list) or len(p) != 2 or not all(finite(x) and 0 <= x <= 1 for x in p) for p in roi):
        raise HTTPException(400, '재탐지 코트 정보를 확인하세요.')
    windows = value.get('windows')
    if not isinstance(windows, list) or not 0 < len(windows) <= 200:
        raise HTTPException(400, '재탐지 구간을 확인하세요.')
    event_ids = {e['id'] for e in context['events']}
    track_ids, window_ids, seen = set(), set(), {}
    for w in windows:
        a, z = w.get('from'), w.get('to')
        if (not finite(a) or not finite(z) or not 0 < z-a <= 80.01
                or a < snapshot.payload['from']-1e-6 or z > snapshot.payload['to']+1e-6
                or type(w.get('id')) is not int or w['id'] in window_ids
                or not w.get('eventIds') or not set(w['eventIds']) <= event_ids
                or not isinstance(w.get('frames'), list) or not 0 < len(w['frames']) <= 10000):
            raise HTTPException(400, '재탐지 구간·교체 시각을 확인하세요.')
        window_ids.add(w['id'])
        previous = -1
        for f in w['frames']:
            t, boxes = f.get('t'), f.get('boxes')
            if not finite(t) or not a-1e-6 <= t < z+1e-6 or t <= previous or not isinstance(boxes, list) or len(boxes) > 200:
                raise HTTPException(400, '재탐지 프레임을 확인하세요.')
            previous, frame_ids = t, set()
            for b in boxes:
                i, box, confidence = b.get('id'), b.get('box'), b.get('confidence')
                if (type(i) is not int or not 10**9 <= i < 2**53 or i in frame_ids
                        or (i in seen and seen[i] != w['id']) or not isinstance(box, list) or len(box) != 4
                        or not all(finite(n) and 0 <= n <= 1 for n in box)
                        or box[2] <= box[0] or box[3] <= box[1] or not finite(confidence) or not 0 <= confidence <= 1):
                    raise HTTPException(400, '재탐지 객체·좌표를 확인하세요.')
                frame_ids.add(i); track_ids.add(i); seen[i] = w['id']
    return sorted(track_ids)


def save_recovery(db, snapshot, user, value, *, trusted_parent=None, commit=True):
    match = context_match(db, snapshot)
    saved = saved_substitutions(match)
    track_ids = validate_recovery(value, snapshot, saved)
    if trusted_parent:
        if trusted_parent.payload.get('snapshotId') != snapshot.id or trusted_parent.owner_id != snapshot.owner_id:
            raise HTTPException(409,'보강 기준이 다른 분석입니다.')
        value={**value,'parentRecoveryId':trusted_parent.id,'ancestorIds':list(dict.fromkeys([trusted_parent.id,*trusted_parent.payload.get('ancestorIds',[])]))}
    elif value.get('parentRecoveryId') or value.get('ancestorIds'):
        raise HTTPException(400,'누적 보강 계보는 서버 작업에서만 생성됩니다.')
    # The uploaded evidence is immutable and remains a manual review source.
    value = {**value, 'reviewOnly': True}
    content = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    if len(content)>32*1024**2:raise HTTPException(413,'누적 보강 결과는 32MB 이하로 저장하세요.')
    digest = hashlib.sha256(content).hexdigest()
    previous = db.get(FpaCvResource, value['id'])
    if previous:
        if previous.kind != RESOURCE_KIND or previous.owner_id != snapshot.owner_id or previous.payload.get('sha256') != digest:
            raise HTTPException(409, '같은 재탐지 ID에 다른 결과가 있습니다.')
        return previous.payload
    store = storage()
    if not store:
        raise HTTPException(503, '재탐지 저장소를 확인하세요.')
    key = f"fpa-cv/snapshots/{snapshot.id}/redetection-{value['id']}.json"
    try:
        store.client.put_object(Bucket=store.bucket, Key=store.key(key), Body=content, ContentType='application/json', IfNoneMatch='*')
    except Exception as error:
        try:
            existing = store.client.get_object(Bucket=store.bucket, Key=store.key(key))['Body'].read()
            if hashlib.sha256(existing).hexdigest() != digest:
                raise ValueError('checksum')
        except Exception:
            raise HTTPException(503, '재탐지 결과 저장을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.') from error
    manifest = {'id': value['id'], 'snapshotId': snapshot.id, 'matchId': str(match.id), 'key': key,
                'sha256': digest, 'logContext': value['logContext'], 'logRevision': saved['revision'],
                'trackIds': track_ids, 'createdAt': datetime.now(timezone.utc).isoformat(), 'createdBy': user.name,
                'windowCount': len(value['windows']), 'reviewOnly': True,
                'parentRecoveryId':value.get('parentRecoveryId'),'ancestorIds':value.get('ancestorIds',[])}
    db.add(FpaCvResource(id=value['id'], kind=RESOURCE_KIND, owner_id=snapshot.owner_id, payload=manifest))
    if commit:db.commit()
    else:db.flush()
    return manifest


def check_resolution(db, user, snapshot, decision, log):
    if not decision.redetectionId:
        if max(decision.outTrackId, decision.inTrackId) >= 10**9:
            raise HTTPException(400, '재탐지 후보의 원본 버전을 함께 선택하세요.')
        return
    row = owned(db, decision.redetectionId, user, RESOURCE_KIND)
    if row.payload['snapshotId'] != snapshot.id or row.payload['logContext'] != log_context(log):
        raise HTTPException(409, '교체 시각 또는 원본이 변경되었습니다. 재탐지 후보를 다시 확인하세요.')
    if any(i >= 10**9 and i not in row.payload['trackIds'] for i in (decision.outTrackId, decision.inTrackId)):
        raise HTTPException(400, '선택한 재탐지 객체가 결과에 없습니다.')


@router.post('/{snapshot_id}/redetection', status_code=201)
async def register_redetection(snapshot_id: str, request: Request, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    snapshot = owned(db, snapshot_id, user, 'analysis_snapshot')
    from .futsal_fla_video import get_match
    get_match(db, UUID(snapshot.payload['matchId']), user, True, substitutions=True)
    if user.role not in ('SUPERADMIN', 'ADMIN', 'OPERATOR'):
        raise HTTPException(403, '재탐지 결과 등록 권한을 확인하세요.')
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 32 * 1024**2:
            raise HTTPException(413, '재탐지 결과는 32MB 이하로 등록하세요.')
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise HTTPException(400, '재탐지 JSON 형식을 확인하세요.')
    try:
        return save_recovery(db, snapshot, user, value)
    except (KeyError, TypeError, ValueError, AttributeError):
        raise HTTPException(400, '재탐지 결과의 구간·객체 형식을 확인하세요.')


def select_recovery(db, snapshot, saved, recovery_id=None):
    context=log_context(saved['log'])
    pins={e['tracking']['redetectionId'] for e in (saved['log'] or {}).get('substitutions',[]) if e.get('tracking',{}).get('snapshotId')==snapshot.id and e.get('tracking',{}).get('redetectionId')}
    rows=[r for r in db.query(FpaCvResource).filter_by(kind=RESOURCE_KIND,owner_id=snapshot.owner_id).all() if r.payload.get('snapshotId')==snapshot.id]
    rows.sort(key=lambda r:r.payload['createdAt'],reverse=True)
    compatible=lambda r:pins<={r.id,*r.payload.get('ancestorIds',[])}
    if recovery_id:
        row=next((r for r in rows if r.id==recovery_id and compatible(r)),None)
        if not row:raise HTTPException(409,'재탐지 검수 버전이 변경되었습니다. 새로 불러오세요.')
        return row
    row=next((r for r in rows if compatible(r) and r.payload['logContext']==context),None)
    if row:return row
    row=next((r for r in rows if compatible(r)),None)
    if pins and not row:raise HTTPException(409,'서로 다른 재탐지 버전의 연결이 있습니다. 동일 버전으로 검수하세요.')
    return row


@router.get('/{snapshot_id}/redetection')
def read_redetection(snapshot_id: str, metadata: bool = False, recovery_id: str | None = None,
                     user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    snapshot = owned(db, snapshot_id, user, 'analysis_snapshot')
    saved = saved_substitutions(context_match(db, snapshot))
    context = log_context(saved['log'])
    row=select_recovery(db,snapshot,saved,recovery_id)
    status = 'missing' if not row else 'ready' if row.payload['logContext'] == context else 'stale'
    reviewed = reviewed_manifest(db, snapshot, saved, row)
    result = {'status': status, 'id': row.id if row else None, 'windowCount': row.payload['windowCount'] if row else 0,
              'reviewedReportId': reviewed.id if reviewed else None}
    if not metadata and status == 'ready':
        store = storage()
        try:
            content = store.client.get_object(Bucket=store.bucket, Key=store.key(row.payload['key']))['Body'].read()
            if hashlib.sha256(content).hexdigest() != row.payload['sha256']:
                raise ValueError('checksum')
            result['recovery'] = json.loads(content)
        except Exception as error:
            raise HTTPException(503, '재탐지 후보를 불러오지 못했습니다. 다시 시도하세요.') from error
    return JSONResponse(result, headers={'Cache-Control': 'private, no-store'})
