"""Illustrative video camera from reviewed floor landmarks and saved placements.

An operator's court positions and image footpoints are approximate and may be
derived from the same floor homography. Residuals are diagnostics, not an
independent measurement of camera or position accuracy.
"""
import cv2
import numpy as np
from scipy.optimize import least_squares
from broadcast_geometry import FLOOR_POINTS


def estimate(frame, packet, scene):
    width, height = int(packet['width']), int(packet['height'])
    court = frame.get('court', {})
    landmarks = [p for p in court.get('landmarks', []) if p.get('class_id') in FLOOR_POINTS]
    if not court.get('visuallyReviewed') or len(landmarks) < 6:
        raise ValueError('2D 배치 카메라 추정에는 검토된 코트 기준점이 필요합니다.')
    boxes = {b['id']: b for b in frame.get('boxes', [])}
    points = []
    for entity in scene['state']['entities']:
        box = boxes.get(entity['id'])
        foot = box.get('footpointPixels') if box else None
        if entity.get('role') not in ('player', 'referee') or not box or box.get('imageSource', 'broadcast') != 'broadcast':
            continue
        if not isinstance(foot, (tuple, list)) or len(foot) != 2:
            continue
        try:
            x, y = float(entity['x']), float(entity['y'])
            u, v = map(float, foot)
        except (KeyError, ValueError, TypeError):
            continue
        if not np.isfinite([x, y, u, v]).all() or not (10 < u < width-10 and 10 < v < height-50):
            continue
        points.append((entity['id'], [x, y, 0.0], [u, v]))
    if len(points) < 6:
        raise ValueError('화면과 2D 위치를 연결할 수 있는 인물이 부족합니다.')
    floor = np.asarray([p[1][:2] for p in points], dtype=float)
    spread = np.linalg.svd(floor-floor.mean(axis=0), compute_uv=False)
    if len(spread) < 2 or spread[1] < 2:
        raise ValueError('2D 인물 배치가 한쪽에 치우쳐 카메라를 추정할 수 없습니다.')
    ground = np.float32([[*FLOOR_POINTS[p['class_id']], 0] for p in landmarks])
    pixels = np.float32([[p['x'], p['y']] for p in landmarks])
    focal = 1500.0 * width / 1920.0
    K = np.array([[focal, 0, width/2], [0, focal, height/2], [0, 0, 1]], dtype=float)
    flags = (cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_ASPECT_RATIO |
             cv2.CALIB_FIX_PRINCIPAL_POINT | cv2.CALIB_ZERO_TANGENT_DIST |
             cv2.CALIB_FIX_K1 | cv2.CALIB_FIX_K2 | cv2.CALIB_FIX_K3)
    try:
        error, K, _, rv, tv = cv2.calibrateCamera([ground], [pixels], (width, height), K, np.zeros(5), flags=flags)
    except cv2.error as exc:
        raise ValueError('2D 배치 카메라의 초기 방향을 계산하지 못했습니다.') from exc
    if not np.isfinite(K).all() or not np.isfinite(error) or error > 60*width/1920 or not 300*width/1920 < K[0, 0] < 10000*width/1920:
        raise ValueError('2D 배치 카메라의 초기 방향을 안정적으로 추정할 수 없습니다.')
    objects = np.asarray([p[1] for p in points], dtype=float)
    image = np.asarray([p[2] for p in points], dtype=float)
    all_objects = np.concatenate([ground, objects])
    all_image = np.concatenate([pixels, image])
    initial = np.r_[rv[0].ravel(), tv[0].ravel()]
    def residual(value):
        projected = cv2.projectPoints(all_objects, value[:3], value[3:], K, None)[0].reshape(-1, 2)
        return (projected-all_image).ravel()
    try:
        result = least_squares(residual, initial, loss='soft_l1', f_scale=35*width/1920, max_nfev=300)
    except (ValueError, cv2.error) as exc:
        raise ValueError('2D 배치 카메라를 계산하지 못했습니다.') from exc
    if not result.success or not np.isfinite(result.x).all():
        raise ValueError('2D 배치 카메라가 수렴하지 않았습니다.')
    R = cv2.Rodrigues(result.x[:3])[0]
    t = result.x[3:]
    # The application court is left-handed (map y down, height up). Keep the
    # same convention as the existing reviewed-court video camera.
    if (-R.T @ t)[2] < 0:
        R[:, 2] *= -1
    centre = -R.T @ t
    depth = (objects @ R.T + t)[:, 2]
    errors = np.linalg.norm(residual(result.x).reshape(-1, 2), axis=1)[len(landmarks):]
    inliers = errors <= 60*width/1920
    if (not np.isfinite(centre).all() or not 2 < centre[2] < 40 or np.linalg.norm(centre[:2]) > 150 or
            np.any(depth <= .1) or int(inliers.sum()) < 5 or inliers.mean() < .6 or
            np.median(errors) > 60*width/1920):
        raise ValueError('2D 위치와 중계 화면의 차이가 커 카메라를 안전하게 추정할 수 없습니다.')
    diagnostics = [{'id': p[0], 'errorPixels': round(float(err), 1)} for p, err in zip(points, errors)]
    camera = {'K': K.tolist(), 'distortion': [0.0]*5, 'worldToCamera': R.tolist(),
              'translation': t.tolist(), 'anchorRMSEPixels': float(error),
              'source': 'saved-map-and-image-footpoints', 'provisional': True}
    provenance = {'method': 'saved-map-and-image-footpoints', 'courtRevision': frame['courtRevision'],
                  'anchorRMSEPixels': round(float(error), 1), 'placementMedianPixels': round(float(np.median(errors)), 1),
                  'placementMaxPixels': round(float(np.max(errors)), 1), 'pointCount': len(points),
                  'footpointResiduals': diagnostics, 'provisional': True,
                  'note': '배치와 발 위치는 추정이며 일부 서로 의존하므로 정확도 검증이 아닙니다.'}
    return camera, provenance
