"""Shared FPC xGOT calculation for the API and local CV workbench."""
import math


def estimate_xgot(
    xg: float,
    *,
    is_on_target: bool,
    goalmouth_x: float | None,
    goalmouth_y: float | None,
    is_goal: bool,
    is_header: bool,
    is_weak_foot: bool,
    under_pressure: bool,
    one_on_one: bool,
    shot_pace_band: str,
) -> dict:
    clipped_xg = max(0.0, min(1.0, xg))
    if not is_on_target or goalmouth_x is None or goalmouth_y is None:
        return {
            "xgot": 0.0,
            "corner_factor": 0.0,
            "placement_factor": 0.0,
            "height_factor": 0.0,
            "pace_factor": 0.0,
            "delta": round(-clipped_xg, 3),
            "label": "off-target",
        }

    gx = max(0.0, min(1.0, goalmouth_x))
    gy = max(0.0, min(1.0, goalmouth_y))
    lateral_offset = abs(gx - 0.5) / 0.5
    height_factor = gy
    corner_factor = min(1.0, math.sqrt((lateral_offset ** 2 + height_factor ** 2) / 2.0))
    placement_factor = 0.65 * lateral_offset + 0.35 * height_factor

    # Speed should not boost keeper-zone shots uniformly.
    # Weight speed by a fan-shaped distribution radiating from the center-bottom
    # of the goalmouth so upper corners benefit more than central low shots.
    radial_distance = min(1.0, math.sqrt((lateral_offset ** 2 + height_factor ** 2) / 2.0))
    fan_weight = min(1.0, 0.55 * height_factor + 0.25 * lateral_offset + 0.20 * radial_distance)
    pace_lookup = {"LOW": -0.03, "MID": 0.0, "HIGH": 0.05}
    pace_factor = pace_lookup.get(shot_pace_band, 0.0) * fan_weight

    score = (
        clipped_xg * 0.58
        + corner_factor * 0.24
        + placement_factor * 0.14
        + pace_factor
        + (0.05 if one_on_one else 0.0)
        - (0.04 if under_pressure else 0.0)
        - (0.03 if is_header else 0.0)
        - (0.02 if is_weak_foot else 0.0)
    )
    if is_goal:
        score += 0.03

    xgot = max(0.0, min(1.0, score))
    label = "central"
    if corner_factor >= 0.78:
        label = "top-corner threat"
    elif placement_factor >= 0.6:
        label = "well-placed"
    elif gy <= 0.25 and lateral_offset <= 0.2:
        label = "keeper-zone"

    return {
        "xgot": round(xgot, 3),
        "corner_factor": round(corner_factor, 3),
        "placement_factor": round(placement_factor, 3),
        "height_factor": round(height_factor, 3),
        "fan_weight": round(fan_weight, 3),
        "pace_factor": round(pace_factor, 3),
        "delta": round(xgot - clipped_xg, 3),
        "label": label,
    }
