import math


def is_in_penalty_area(x: float, y: float) -> bool:
    return (x > 88.5) and (13.84 < y < 54.16)


def normalize_shot_x(team: str, attack_lr: str, start_x: float) -> float:
    home_dir = attack_lr
    away_dir = "R2L" if attack_lr == "L2R" else "L2R"
    team_dir = home_dir if team == "HOME" else away_dir
    return start_x if team_dir == "L2R" else 105.0 - start_x


def estimate_xg(
    team: str,
    attack_lr: str,
    start_x: float,
    start_y: float,
    is_header: bool,
    is_weak_foot: bool,
) -> dict[str, float | bool]:
    shot_x_adj = normalize_shot_x(team, attack_lr, start_x)
    shot_y_adj = start_y

    goal_x, goal_y = 105.0, 34.0
    goal_post_left = 30.34
    goal_post_right = 37.66

    distance = math.sqrt((goal_x - shot_x_adj) ** 2 + (goal_y - shot_y_adj) ** 2)

    dx_left = goal_x - shot_x_adj
    dy_left = goal_post_left - shot_y_adj
    dx_right = goal_x - shot_x_adj
    dy_right = goal_post_right - shot_y_adj
    angle_left = math.atan2(dy_left, dx_left)
    angle_right = math.atan2(dy_right, dx_right)
    angle = abs(angle_left - angle_right)
    is_head = 1 if is_header else 0
    is_weak = 1 if is_weak_foot else 0
    angle_log = math.log1p(angle)
    goal_line_dist = goal_x - shot_x_adj
    endline_penalty = 1.5 if goal_line_dist < 1.0 else 0.0

    # 2026-07 재보정: 실측 기반 모델(StatsBomb류) 스케일에 맞춤 —
    # 탭인 0.90, 6야드 정면 0.47, PK 지점 0.18, 박스 정면 0.08, 20m 0.05, 35m 0.01
    exponent = (
        0.081 * distance
        - 3.384 * angle_log
        + 0.77 * is_head
        + 0.40 * is_weak
        + 2.291
        + endline_penalty
    )
    xg = 1.0 / (1.0 + math.exp(exponent))

    is_outside_goal_frame = shot_y_adj < goal_post_left or shot_y_adj > goal_post_right
    if is_outside_goal_frame and shot_x_adj >= 104.5:
        penalty_scale = max(0.1, min(goal_line_dist / 1.0, 1.0))
        xg *= penalty_scale

    xg = max(0.0, min(1.0, xg))

    return {
        "xg": round(xg, 3),
        "distance": round(distance, 2),
        "angle_rad": round(angle, 4),
        "is_in_box": bool(is_in_penalty_area(shot_x_adj, shot_y_adj)),
        "normalized_x": round(shot_x_adj, 2),
        "normalized_y": round(shot_y_adj, 2),
    }
