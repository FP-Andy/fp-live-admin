"""Keep inferred occupancy separate and bounded when freezing report sources."""
import math
from fastapi import HTTPException


def finite(v):
    return type(v) in (int, float) and math.isfinite(v)


def validate_augmentation(heat):
    def fail():
        raise HTTPException(400, '히트맵 활동 분포와 시간 합계를 확인하세요.')
    policy = heat.get('augmentation')
    if policy is None:
        if any(p.get('augmentation') is not None for p in heat['players']):
            fail()
        return
    if not isinstance(policy, dict) or policy.get('enabled') is not True or policy.get('algorithm') != 'personal-activity-density/v1' or policy.get('targetBasis') != 'duration' or policy.get('use') != 'heatmap-only' or policy.get('targetRatio') not in (.2, .3):
        fail()
    duration, tol = heat['to'] - heat['from'], .002
    for p in heat['players']:
        a = p.get('augmentation')
        observed = sum(o['seconds'] for o in p['positions'])
        if not isinstance(a, dict) or a.get('schema') != 'fpa-heatmap-augmentation/v1' or a.get('algorithm') != policy['algorithm'] or a.get('from') != heat['from'] or a.get('to') != heat['to']:
            fail()
        seconds, grid, gaps = a.get('inferredSeconds'), a.get('estimatedGrid'), a.get('gaps')
        if not finite(seconds) or seconds < 0 or seconds > min(duration - observed, duration * policy['targetRatio']) + tol or not isinstance(grid, list) or len(grid) != heat['width'] * heat['height'] or not all(finite(n) and n >= 0 for n in grid) or abs(sum(grid) - seconds) > tol or not isinstance(gaps, list) or len(gaps) > 1000000:
            fail()
        unavailable = [{'from': o['t'], 'to': o['t'] + o['seconds']} for o in p['positions']]
        for key in ('blockedIntervals', 'inactiveIntervals'):
            blocks = p.get(key, [])
            if not isinstance(blocks, list):
                fail()
            for b in blocks:
                if not isinstance(b, dict) or not finite(b.get('from')) or not finite(b.get('to')) or b['to'] <= b['from']:
                    fail()
                if key == 'inactiveIntervals' or b.get('reason') in ('outside', 'substitution', 'bench', 'inactive', 'automaticFiltered'):
                    unavailable.append(b)
        unavailable.sort(key=lambda b: b['from'])
        for g in gaps:
            if not isinstance(g, dict) or not all(finite(g.get(k)) for k in ('from', 'to', 'inferredSeconds')):
                fail()
        cursor, index, mass = heat['from'], 0, 0
        for g in sorted(gaps, key=lambda g: g['from']):
            if g['from'] < cursor - tol or g['to'] <= g['from'] or g['to'] > heat['to'] + tol or g['inferredSeconds'] <= 0 or g['inferredSeconds'] > g['to'] - g['from'] + tol or g.get('kind') not in ('shortMotion', 'movementDensity', 'activityPattern'):
                fail()
            while index < len(unavailable) and unavailable[index]['to'] <= g['from'] + tol:
                index += 1
            if index < len(unavailable) and unavailable[index]['from'] < g['to'] - tol:
                fail()
            cursor = g['to']
            mass += g['inferredSeconds']
        if abs(mass - seconds) > tol:
            fail()
