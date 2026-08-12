"""수비콘 반영 xG — 슛 지점에서 골문으로 뻗는 각도 중 수비수가 가린 몫을 뺀다.

배경
----
현행 `xg.estimate_xg` 는 거리·각도·헤딩·약발만 본다. 수비수 위치는 입력에조차 없다.
`fpa.build_model_config_sheet` 의 shot_formula 메타데이터에는 `b4*pressure` 항이
적혀 있으나 구현에는 없다 — 문서만 앞서 있던 상태다.

dual 태깅은 before/after 프레임에 **양 팀 선수 좌표**를 갖고 있다(피치컨트롤이 이미
이 좌표를 쓴다). 그래서 슛 지점에서 골문을 향한 시야가 얼마나 막혔는지를 실제로
계산할 수 있다.

무엇을 재나
----------
슛 지점 S 에서 두 골포스트로 뻗는 각도 구간이 '열린 골문'이다. 그 사이에 선 수비수는
자기 몸 너비만큼의 각도 구간을 가린다. 가려진 구간들의 **합집합**이 전체 각도에서
차지하는 비율이 `blocked_fraction` 이고, 남은 각도로 xG 를 다시 계산한다.

    effective_angle = angle × (1 − blocked_fraction)

합집합을 쓰는 이유는 겹쳐 선 수비수 둘이 각도를 두 번 깎으면 안 되기 때문이다.

골키퍼를 세지 않는 이유
---------------------
`estimate_xg` 의 계수는 실측 스케일로 재보정돼 있다(탭인 0.90 · 박스 정면 0.08 ·
20m 0.05). 그 값들은 **정상적으로 골키퍼가 서 있는 상황**의 득점률이다. 여기에
골키퍼의 차단 각도를 또 빼면 이중계산이 된다. 그래서 기본값은 필드 플레이어만
센다. 키퍼가 크게 나와 있는 상황을 반영하려면 include_gk 로 켜되, 그때는 기저
계수 재보정이 함께 필요하다.

이 모듈은 `xg.py` 를 건드리지 않는다 — 기존 슛 채점(G1)의 값을 흔들지 않고
어시스트 산식에서 먼저 시험하기 위해서다.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

from .xg import estimate_xg, normalize_shot_x

GOAL_X = 105.0
GOAL_POST_LEFT = 30.34
GOAL_POST_RIGHT = 37.66

# 수비수 한 명이 가리는 몸 너비의 절반(m). 선 자세로 다리를 벌려 막는 폭을 가정한다.
DEFENDER_HALF_WIDTH_M = 0.4
# 골키퍼를 셀 때의 절반 너비 — 다이빙 범위까지 본다. include_gk 가 True 일 때만 쓰인다.
GK_HALF_WIDTH_M = 1.2
# 이보다 가까운 수비수는 사실상 시야를 통째로 막는다(각도 계산이 발산하는 구간 보호).
MIN_DEFENDER_DIST_M = 0.35


def _angle_to(sx: float, sy: float, tx: float, ty: float) -> float:
    return math.atan2(ty - sy, tx - sx)


def _union_length(intervals: list[tuple[float, float]]) -> float:
    """구간 합집합의 총 길이 — 겹쳐 선 수비수를 두 번 세지 않기 위해."""
    if not intervals:
        return 0.0
    merged: list[list[float]] = []
    for lo, hi in sorted(intervals):
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return sum(hi - lo for lo, hi in merged)


def _normalized_points(
    team: str, attack_lr: str, points: Iterable[Any]
) -> list[tuple[float, float, bool]]:
    """수비수 좌표를 슛 좌표와 같은 공격방향으로 정규화 → (x, y, is_gk)."""
    out: list[tuple[float, float, bool]] = []
    for p in points or []:
        if isinstance(p, dict):
            raw_x, raw_y = p.get("x"), p.get("y")
            is_gk = str(p.get("role") or "").strip().lower() == "gk" or bool(p.get("gk"))
        else:
            try:
                raw_x, raw_y = p[0], p[1]
            except (TypeError, IndexError):
                continue
            is_gk = False
        try:
            x = float(raw_x)
            y = float(raw_y)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        out.append((normalize_shot_x(team, attack_lr, x), y, is_gk))
    return out


def goal_block_fraction(
    shot_x_adj: float,
    shot_y: float,
    defenders_adj: list[tuple[float, float, bool]],
    *,
    include_gk: bool = False,
) -> float:
    """열린 골문 각도 중 수비수가 가린 비율(0~1). 정규화된 좌표를 받는다."""
    a_left = _angle_to(shot_x_adj, shot_y, GOAL_X, GOAL_POST_LEFT)
    a_right = _angle_to(shot_x_adj, shot_y, GOAL_X, GOAL_POST_RIGHT)
    goal_lo, goal_hi = min(a_left, a_right), max(a_left, a_right)
    total = goal_hi - goal_lo
    if total <= 1e-9:
        return 0.0

    # '앞에 있다'를 x 좌표로 판정하면 안 된다 — 골라인 근처 측면에서는 골문이 옆에
    # 있어서, 실제로 시야를 막는 수비수가 슈터보다 x 가 작을 수 있다(컷백 상황).
    # 골문까지의 거리보다 가까우면 막을 수 있는 것으로 보고, 방향은 아래 각도 구간
    # 교집합이 걸러낸다(슈터 뒤쪽은 각도가 골 구간과 겹치지 않는다).
    goal_dist = math.hypot(GOAL_X - shot_x_adj, (GOAL_POST_LEFT + GOAL_POST_RIGHT) / 2 - shot_y)

    blocked: list[tuple[float, float]] = []
    for dx, dy, is_gk in defenders_adj:
        if is_gk and not include_gk:
            continue
        dist = math.hypot(dx - shot_x_adj, dy - shot_y)
        if dist >= goal_dist:
            continue
        if dist < MIN_DEFENDER_DIST_M:
            return 1.0
        half = GK_HALF_WIDTH_M if is_gk else DEFENDER_HALF_WIDTH_M
        center = _angle_to(shot_x_adj, shot_y, dx, dy)
        spread = math.atan2(half, dist)
        lo, hi = max(center - spread, goal_lo), min(center + spread, goal_hi)
        if hi > lo:
            blocked.append((lo, hi))

    return max(0.0, min(1.0, _union_length(blocked) / total))


def estimate_xg_with_cone(
    team: str,
    attack_lr: str,
    start_x: float,
    start_y: float,
    is_header: bool,
    is_weak_foot: bool,
    defenders: Iterable[Any] | None = None,
    *,
    include_gk: bool = False,
) -> dict[str, Any]:
    """수비콘을 반영한 xG.

    수비수가 없으면(또는 아무도 시야를 안 가리면) `xg.estimate_xg` 와 **같은 값**을
    돌려준다 — 프레임이 없는 장면에서 그대로 폴백되도록 한 것이다.

    반환에 blocked/open_angle 을 함께 실어, 점수뿐 아니라 '왜 그 값인지'를 볼 수 있게 한다.
    """
    base = estimate_xg(team, attack_lr, start_x, start_y, is_header, is_weak_foot)
    shot_x_adj = float(base["normalized_x"])
    shot_y_adj = float(base["normalized_y"])
    angle = float(base["angle_rad"])

    pts = _normalized_points(team, attack_lr, defenders or [])
    blocked = goal_block_fraction(shot_x_adj, shot_y_adj, pts, include_gk=include_gk)

    open_angle = angle * (1.0 - blocked)
    if blocked <= 0.0:
        return {**base, "blocked": 0.0, "open_angle_rad": round(angle, 4),
                "xg_open": base["xg"], "defenders_counted": len(pts)}

    # 기저 모델과 동일한 로지스틱에 '열린 각도'만 갈아끼운다.
    distance = float(base["distance"])
    exponent = (
        0.081 * distance
        - 3.384 * math.log1p(open_angle)
        + 0.77 * (1 if is_header else 0)
        + 0.40 * (1 if is_weak_foot else 0)
        + 2.291
        + (1.5 if (GOAL_X - shot_x_adj) < 1.0 else 0.0)
    )
    xg_open = 1.0 / (1.0 + math.exp(exponent))
    if (shot_y_adj < GOAL_POST_LEFT or shot_y_adj > GOAL_POST_RIGHT) and shot_x_adj >= 104.5:
        xg_open *= max(0.1, min((GOAL_X - shot_x_adj) / 1.0, 1.0))

    return {
        **base,
        "blocked": round(blocked, 4),
        "open_angle_rad": round(open_angle, 4),
        "xg_open": round(max(0.0, min(1.0, xg_open)), 4),
        "defenders_counted": len(pts),
    }
