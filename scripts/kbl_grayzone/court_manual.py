"""Explicit frame-bound court review, using the existing geometry checks."""
import math
import threading

import broadcast_court
import case_store
from broadcast_geometry import FLOOR_POINTS, estimate_manual_court
from job_store import digest, lease

LOCK = threading.RLock()


def save(case_id, event_id, payload):
    if not isinstance(payload, dict) or payload.get('confirmed') is not True:
        raise ValueError('같은 골대와 기준점을 직접 확인해 주세요.')
    raw = payload.get('landmarks')
    if not isinstance(raw, list) or not 6 <= len(raw) <= len(FLOOR_POINTS):
        raise ValueError('서로 다른 코트 기준점을 6개 이상 지정하세요.')
    points, seen = [], set()
    for point in raw:
        if not isinstance(point, dict):
            raise ValueError('기준점 형식을 확인하세요.')
        key, x, y = point.get('class_id'), point.get('x'), point.get('y')
        if (type(key) is not int or key not in FLOOR_POINTS or key in seen or
            type(x) not in (int, float) or type(y) not in (int, float) or
            not math.isfinite(x) or not math.isfinite(y) or x < 0 or y < 0):
            raise ValueError('중복되거나 영상 범위를 벗어난 기준점이 있습니다.')
        seen.add(key)
        points.append(dict(class_id=key, x=float(x), y=float(y), confidence=1.0))
    # Serialize the revision check and save across worker processes sharing a
    # store, not just threads within one process.
    lock_path=case_store.ROOT/'outputs/kbl-locks/manual-court'/(digest([case_id,event_id])+'.lock')
    with LOCK, lease(lock_path) as acquired:
        if not acquired:
            raise RuntimeError('다른 사용자가 코트 기준점을 저장 중입니다. 잠시 후 다시 시도하세요.')
        case = case_store.load_case(case_id)
        event = next((x for x in case['events'] if x['id'] == event_id), None)
        if event is None:
            raise ValueError('판독 장면을 찾을 수 없습니다.')
        # The browser sees the object-review dataset ID; the court is bound to
        # the underlying detector dataset, before object/multiview decoration.
        current = case_store.broadcast_packet(case_id, event_id)
        packet = case_store.broadcast_packet(case_id, event_id, include_objects=False, include_multiview=False)
        width, height = packet.get('width'), packet.get('height')
        if (type(width) is not int or type(height) is not int or width <= 0 or height <= 0 or
            any(p['x'] >= width or p['y'] >= height for p in points)):
            raise ValueError('영상 범위를 벗어난 기준점이 있습니다.')
        index = case_store.broadcast_index(event, packet['fps'])
        frame = next(x for x in packet['frames'] if x['frameIndex'] == index)
        if (payload.get('frameIndex') != index or payload.get('datasetId') != current['datasetId'] or
            payload.get('inputSha256') != packet['inputSha256'] or
            payload.get('previousRevision') != frame.get('courtRevision')):
            raise RuntimeError('프레임 또는 코트 보정이 바뀌었습니다. 새로고침 후 다시 확인하세요.')
        court = estimate_manual_court(points, packet['width'], packet['height'])
        if not court.get('imageToCourt'):
            raise ValueError('이 기준점들로는 코트 평면을 계산할 수 없습니다. 서로 떨어진 코트 선의 교차점을 확인하세요.')
        provenance = {'method': 'operator-frame-landmarks', 'label': '작업자 수동 코트 기준점',
                      'uncertainty': '미측정', 'orientation': 'operator-confirmed-basket',
                      'operatorConfirmed': True}
        record = broadcast_court.save_reviewed(case_id, event_id, index, points, provenance,
                                               packet['datasetId'], packet['inputSha256'])
        return {'saved': True, 'frameIndex': index, 'revision': record['revision'],
                'note': '수동 기준점 전체로 계산했습니다. 공간 위치와 방향은 원본과 대조해 주세요.'}
