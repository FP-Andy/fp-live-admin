"""Immutable, operator-confirmed analysis sources for FCM reports.

Coordinates live in S3; the database holds a small, searchable version manifest.
No existing snapshot is updated when a review or a report draft changes.
"""
import hashlib
import json
import math
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from .auth import require_session_user
from .db import get_db
from .models import FpaCvResource, Match, User
from .fpa_cv import owned, same_origin
from .fpa_cv_storage import storage
from .heatmap_augmentation import validate_augmentation

router = APIRouter(prefix='/api/futsal/analysis-snapshots', dependencies=[Depends(same_origin)])
INPUTS = ('segments', 'roster', 'uniforms', 'setup', 'autoReconnect', 'rejections', 'checkpoints')


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_source(heat, job, version):
    review = job.review or {}
    if job.payload.get('status') != 'completed' or not review.get('setup'):
        raise HTTPException(409, '분석과 초기 설정을 완료하세요.')
    if type(version) is not int or version != job.review_version:
        raise HTTPException(409, '검수 내용이 변경되었습니다. 저장 후 다시 확정하세요.')
    batch = review.get('batch') or {}
    applied = batch.get('applied')
    if (not applied or any(review.get(k) != applied.get(k) for k in INPUTS)
            or review.get('shadowCorrection', False) != applied.get('shadowCorrection', False)):
        raise HTTPException(409, '미반영 검수가 있습니다. 검수 반영 후 히트맵을 다시 만드세요.')
    if not isinstance(heat, dict) or heat.get('schema') != 'fpa-heatmaps/v1' or heat.get('datasetId') != job.payload.get('datasetId'):
        raise HTTPException(400, '이 분석의 히트맵을 선택하세요.')
    if heat.get('resultVersion') != batch.get('round', 0) + 1:
        raise HTTPException(409, '이전 차수의 히트맵입니다. 다시 생성하세요.')
    start, end = heat.get('from'), heat.get('to')
    if not finite(start) or not finite(end) or end <= start:
        raise HTTPException(400, '히트맵 분석 구간을 확인하세요.')
    video = job.payload.get('video') or {}
    if start < max(review['setup']['time'], video.get('clipStart', start)) - .002 or end > video.get('clipEnd', end) + .002:
        raise HTTPException(400, '원본 분석 구간을 벗어난 히트맵입니다.')
    width, height = heat.get('width'), heat.get('height')
    if type(width) is not int or type(height) is not int or not 0 < width * height <= 20000 or width < 1 or height < 1 or not finite(heat.get('scale')) or heat['scale'] <= 0:
        raise HTTPException(400, '히트맵 눈금을 확인하세요.')
    roster = {p['id']: p for p in review.get('roster', []) if p.get('group') in ('home', 'away')}
    players = heat.get('players')
    if not isinstance(players, list) or not players or len(players) != len(roster) or {p.get('id') for p in players if isinstance(p, dict)} != set(roster):
        raise HTTPException(400, '필드 선수 명단을 확인하세요.')
    qualities = []
    for p in players:
        if p.get('group') != roster[p['id']]['group'] or str(p.get('jersey')) != str(roster[p['id']]['jersey']):
            raise HTTPException(400, '선수 번호가 변경되었습니다. 히트맵을 다시 만드세요.')
        grid, positions = p.get('grid'), p.get('positions')
        if not isinstance(grid, list) or len(grid) != width * height or not all(finite(v) and v >= 0 for v in grid) or not isinstance(positions, list) or len(positions) > 1000000:
            raise HTTPException(400, '히트맵 좌표를 확인하세요.')
        observed, until, gap = 0, start, 0
        for point in positions:
            if not isinstance(point, dict) or not all(finite(point.get(k)) for k in ('t', 'x', 'y', 'seconds')) or not 0 <= point['x'] <= 1 or not 0 <= point['y'] <= 1 or point['seconds'] <= 0 or point['t'] < until - .002 or point['t'] + point['seconds'] > end + .002:
                raise HTTPException(400, '유효 관측 시간과 좌표를 확인하세요.')
            gap = max(gap, point['t'] - until)
            until = point['t'] + point['seconds']
            observed += point['seconds']
        if abs(sum(grid) - observed) > max(.05, observed * .00001):
            raise HTTPException(400, '히트맵과 관측 시간의 합계가 다릅니다.')
        qualities.append({'id': p['id'], 'group': p['group'], 'jersey': str(p['jersey']), 'coverage': min(1, observed / (end - start)), 'longestMissing': max(gap, end - until)})
    validate_augmentation(heat)
    if heat.get('augmentation'):
        for quality, player in zip(qualities, players):
            quality['estimatedCoverage'] = player['augmentation']['inferredSeconds'] / (end - start)
    return qualities


@router.get('')
def list_snapshots(job_id: str | None = None, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    query = db.query(FpaCvResource).filter_by(kind='analysis_snapshot')
    if user.role != 'SUPERADMIN':
        query = query.filter_by(owner_id=user.id)
    rows = [r.payload for r in query.all() if not job_id or r.payload.get('jobId') == job_id]
    return {'snapshots': sorted(rows, key=lambda p: p['createdAt'], reverse=True)}


@router.post('', status_code=201)
async def create_snapshot(request: Request, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 64 * 1024**2:
            raise HTTPException(413, '스냅샷은 64MB 이하로 저장하세요.')
    try:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, '스냅샷 형식을 확인하세요.')
    job = owned(db, str(value.get('jobId', '')), user, lock=True)
    # Caller-generated ID makes a lost response/retry safe without overwriting.
    snapshot_id = str(value.get('requestId', ''))
    from .fpa_cv import ID
    if not ID.fullmatch(snapshot_id):
        raise HTTPException(400, '저장 요청 번호를 확인하세요.')
    previous = db.get(FpaCvResource, snapshot_id)
    request_hash = hashlib.sha256(raw).hexdigest()
    if previous:
        if previous.kind != 'analysis_snapshot' or previous.owner_id != user.id or previous.payload.get('jobId') != job.id:
            raise HTTPException(409, '저장 요청 번호가 이미 사용되었습니다.')
        if previous.payload.get('requestHash') != request_hash:
            raise HTTPException(409, '요청 내용이 변경되었습니다. 새 완료 판정으로 저장하세요.')
        return previous.payload
    if value.get('confirmed') is not True:
        raise HTTPException(400, '분석 결과를 확인한 뒤 완료 판정하세요.')
    heat = value.get('heatmap')
    quality = validate_source(heat, job, value.get('reviewVersion'))
    store = storage()
    if not store:
        raise HTTPException(503, '스냅샷 S3 저장소가 연결되지 않았습니다.')
    review = job.review
    fpa = {**((review.get('fpa') or {}).get('metadata') or {}), 'sport': 'FUTSAL',
           'rows': [e['row'] for e in review.get('events', [])], 'logs': [e.get('log', '') for e in review.get('events', [])]}
    matches = [m for m in db.query(Match).filter_by(sport='FUTSAL').all()
               if (m.metadata_json or {}).get('fla_video', {}).get('upload_id') == job.payload.get('uploadId')]
    match = matches[0] if len(matches) == 1 else None
    versions = [r.payload.get('version', 0) for r in db.query(FpaCvResource).filter_by(kind='analysis_snapshot').all() if r.payload.get('jobId') == job.id]
    manifest = {'id': snapshot_id, 'jobId': job.id, 'datasetId': heat['datasetId'], 'uploadId': job.payload.get('uploadId'),
                'title': job.payload.get('name') or heat.get('video', '분석'), 'version': max(versions, default=0) + 1,
                'createdAt': datetime.now(timezone.utc).isoformat(), 'createdBy': user.name, 'reviewVersion': job.review_version,
                'resultVersion': heat['resultVersion'], 'matchId': str(match.id) if match else None,
                'eventCount': len(fpa['rows']), 'quality': quality, 'meanCoverage': sum(p['coverage'] for p in quality) / len(quality),
                'minCoverage': min(p['coverage'] for p in quality), 'from': heat['from'], 'to': heat['to'],
                'approval': 'operator-confirmed', 'substitutionsApplied': False}
    if heat.get('augmentation'):
        manifest['augmentation'] = heat['augmentation']
        manifest['meanEstimatedCoverage'] = sum(p['estimatedCoverage'] for p in quality) / len(quality)
    metadata = (match.metadata_json or {}) if match else {}
    document = {'schema': 'fpc-analysis-snapshot/v1', **manifest, 'heatmap': heat, 'fpa': fpa,
                'roster': review.get('roster', []), 'matchName': match.name if match else '',
                'homeName': metadata.get('home_team', fpa.get('teamid_h', '')), 'awayName': metadata.get('away_team', fpa.get('teamid_a', '')),
                'review': review}
    content = json.dumps(document, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    digest = hashlib.sha256(content).hexdigest()
    key = f'fpa-cv/snapshots/{snapshot_id}/result.json'
    try:
        store.client.put_object(Bucket=store.bucket, Key=store.key(key), Body=content, ContentType='application/json', IfNoneMatch='*')
    except Exception as error:
        raise HTTPException(503, '스냅샷 저장에 실패했습니다. 다시 시도하세요.') from error
    db.add(FpaCvResource(id=snapshot_id, kind='analysis_snapshot', owner_id=user.id, payload={**manifest, 'key': key, 'sha256': digest, 'requestHash': request_hash}))
    db.commit()
    return {**manifest, 'sha256': digest}


@router.get('/{snapshot_id}')
def read_snapshot(snapshot_id: str, user: User = Depends(require_session_user), db: Session = Depends(get_db)):
    row = owned(db, snapshot_id, user, 'analysis_snapshot')
    store = storage()
    if not store:
        raise HTTPException(503, '스냅샷 저장소가 연결되지 않았습니다.')
    try:
        content = store.client.get_object(Bucket=store.bucket, Key=store.key(row.payload['key']))['Body'].read()
        if hashlib.sha256(content).hexdigest() != row.payload['sha256']:
            raise ValueError('checksum')
    except Exception as error:
        raise HTTPException(503, '저장된 스냅샷을 읽지 못했습니다.') from error
    return Response(content, media_type='application/json', headers={'Cache-Control': 'private, no-store'})
