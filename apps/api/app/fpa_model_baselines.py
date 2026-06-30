from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

import pandas as pd

from .xg import estimate_xg

FIELD_W = 105.0
FIELD_H = 68.0
DEFAULT_XFP_REFERENCE_DIR = Path(os.getenv("XFP_REFERENCE_DIR", "/Users/andy/Project/xFP"))

CANONICAL_ACTION_CATALOG: list[dict[str, str]] = [
    {"action_id": "A01", "action_key": "Shot/OPP/Direct/Goal", "engine": "fp_xG", "notes": "Direct shot goal threat"},
    {"action_id": "A02", "action_key": "Pass/OPP/Indirect/Goal", "engine": "fp_xG link", "notes": "Assist-credit pass before shot"},
    {"action_id": "A03", "action_key": "Cross/OPP/Indirect/Goal", "engine": "fp_xG link", "notes": "Assist-credit cross before shot"},
    {"action_id": "A04", "action_key": "Pass/OWN/Direct/Progression", "engine": "fp_EPV delta", "notes": "Own-half passing progression"},
    {"action_id": "A05", "action_key": "Pass/OPP/Indirect/Progression", "engine": "fp_EPV link", "notes": "Opposition-half pass enabling progression"},
    {"action_id": "A06", "action_key": "Cross/OPP/Direct/Progression", "engine": "fp_EPV delta", "notes": "Cross progression value"},
    {"action_id": "A07", "action_key": "Dribble/OWN/Direct/Progression", "engine": "fp_EPV delta", "notes": "Own-half carry progression"},
    {"action_id": "A08", "action_key": "Dribble/OPP/Direct/Progression", "engine": "fp_EPV delta", "notes": "Opposition-half carry progression"},
    {"action_id": "A09", "action_key": "Penetration/OPP/Direct/Progression", "engine": "fp_EPV delta", "notes": "Reception/space penetration value"},
    {"action_id": "A10", "action_key": "Penetration/OPP/Indirect/Progression", "engine": "fp_EPV link", "notes": "Space occupation enabling progression"},
    {"action_id": "A11", "action_key": "Pass/OWN/Direct/Possession", "engine": "Pitch Control delta", "notes": "Own-half pass possession security"},
    {"action_id": "A12", "action_key": "Pass/OPP/Direct/Possession", "engine": "Pitch Control delta", "notes": "Opposition-half pass possession security"},
    {"action_id": "A13", "action_key": "Dribble/OWN/Direct/Possession", "engine": "Pitch Control delta", "notes": "Own-half carry possession security"},
    {"action_id": "A14", "action_key": "Dribble/OPP/Direct/Possession", "engine": "Pitch Control delta", "notes": "Opposition-half carry possession security"},
    {"action_id": "A15", "action_key": "Defense/OWN/Direct/Possession", "engine": "Pitch Control delta", "notes": "Own-half direct regain/interception"},
    {"action_id": "A16", "action_key": "Defense/OWN/Indirect/Possession", "engine": "Pitch Control delta", "notes": "Own-half defensive support"},
    {"action_id": "A17", "action_key": "Defense/OPP/Direct/Possession", "engine": "Pitch Control delta", "notes": "High direct regain/interception"},
    {"action_id": "A18", "action_key": "Defense/OPP/Indirect/Possession", "engine": "Pitch Control delta", "notes": "High defensive support"},
    {"action_id": "A19", "action_key": "Press/OPP/Direct/Possession", "engine": "Pitch Control delta", "notes": "Direct pressing regain/control swing"},
    {"action_id": "A20", "action_key": "Press/OPP/Indirect/Possession", "engine": "Pitch Control delta", "notes": "Indirect pressing value"},
    {"action_id": "A21", "action_key": "Duel/OWN/Direct/Possession", "engine": "Pitch Control delta", "notes": "Own-half primary duel"},
    {"action_id": "A22", "action_key": "Duel/OPP/Direct/Possession", "engine": "Pitch Control delta", "notes": "Opposition-half primary duel"},
    {"action_id": "A23", "action_key": "Duel/OWN/Indirect/Possession", "engine": "Pitch Control delta", "notes": "Own-half supporting duel"},
    {"action_id": "A24", "action_key": "Duel/OPP/Indirect/Possession", "engine": "Pitch Control delta", "notes": "Opposition-half supporting duel"},
]

ACTION_KEY_TO_CANONICAL_ID = {item["action_key"]: item["action_id"] for item in CANONICAL_ACTION_CATALOG}

LEGACY_ALIAS_TO_CANONICAL_ID: dict[str, str] = {
    **{f"MF_A{index:02d}": f"A{index:02d}" for index in range(1, 25)},
    "FW_A01": "A01",
    "FW_A02": "A02",
    "FW_A03": "A03",
    "FW_A04": "A08",
    "FW_A05": "A09",
    "FW_A06": "A10",
    "FW_A07": "A12",
    "FW_A08": "A14",
    "FW_A09": "A17",
    "FW_A10": "A18",
    "FW_A11": "A19",
    "FW_A12": "A20",
    "FW_A13": "A22",
    "FW_A14": "A24",
    "DF_A01": "A04",
    "DF_A02": "A07",
    "DF_A03": "A11",
    "DF_A04": "A13",
    "DF_A05": "A15",
    "DF_A06": "A16",
    "DF_A07": "A17",
    "DF_A08": "A18",
    "DF_A09": "A19",
    "DF_A10": "A20",
    "DF_A11": "A21",
    "DF_A12": "A23",
    "DF_A13": "A22",
    "DF_A14": "A06",
    "DF_A15": "A03",
    "DF_A16": "A12",
    "DF_A17": "A08",
    "DF_A18": "A14",
    "DF_A19": "A05",
    "DF_A20": "A02",
}

POSITION_ACTION_SCOPE: list[dict[str, Any]] = [
    {
        "position_group": "FW",
        "enabled_action_ids": ["A01", "A02", "A03", "A08", "A09", "A10", "A12", "A14", "A17", "A18", "A19", "A20", "A22", "A24"],
        "excluded_by_default": ["A04", "A05", "A06", "A07", "A11", "A13", "A15", "A16", "A21", "A23"],
    },
    {
        "position_group": "MF",
        "enabled_action_ids": [f"A{index:02d}" for index in range(1, 25)],
        "excluded_by_default": [],
    },
    {
        "position_group": "DF",
        "enabled_action_ids": ["A02", "A03", "A04", "A05", "A06", "A07", "A08", "A11", "A12", "A13", "A14", "A15", "A16", "A17", "A18", "A19", "A20", "A21", "A22", "A23"],
        "excluded_by_default": ["A01", "A09", "A10", "A24"],
    },
]


def _json_ready(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_ready(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_ready(item) for item in value]
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if hasattr(value, "item"):
        return value.item()
    return value


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return _json_ready(json.loads(path.read_text(encoding="utf-8")))
    except Exception:
        return {}


def _read_csv_records(path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        frame = pd.read_csv(path)
        if limit is not None:
            frame = frame.head(limit)
        return _json_ready(frame.to_dict(orient="records"))
    except Exception:
        return []


def _canonical_action_id(row: dict[str, Any]) -> str:
    action_id = str(row.get("action_id") or "").strip()
    if action_id:
        return action_id
    action_key = str(row.get("action_key") or "").strip()
    if action_key in ACTION_KEY_TO_CANONICAL_ID:
        return ACTION_KEY_TO_CANONICAL_ID[action_key]
    legacy_code = str(row.get("legacy_action_code") or row.get("action_code") or "").strip()
    return LEGACY_ALIAS_TO_CANONICAL_ID.get(legacy_code, legacy_code)


def _with_canonical_action_id(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_rows: list[dict[str, Any]] = []
    for row in rows:
        normalized = dict(row)
        legacy_code = str(normalized.get("legacy_action_code") or normalized.get("action_code") or "").strip()
        if legacy_code:
            normalized["legacy_action_code"] = legacy_code
        normalized["action_id"] = _canonical_action_id(normalized)
        normalized_rows.append(normalized)
    return normalized_rows


def _legacy_alias_map_rows() -> list[dict[str, str]]:
    rows = []
    for legacy_action_code, action_id in sorted(LEGACY_ALIAS_TO_CANONICAL_ID.items()):
        rows.append(
            {
                "legacy_action_code": legacy_action_code,
                "position_group": legacy_action_code.split("_", 1)[0],
                "action_id": action_id,
                "action_key": next(
                    (item["action_key"] for item in CANONICAL_ACTION_CATALOG if item["action_id"] == action_id),
                    "",
                ),
            }
        )
    return rows


def canonicalize_xfp_weights_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload)
    configs = dict(normalized.get("configs") or {})
    source_rows = normalized.get("rows")
    if not isinstance(source_rows, list):
        source_rows = configs.get("role_weight_config") if isinstance(configs.get("role_weight_config"), list) else []

    role_weights = _with_canonical_action_id(source_rows)
    for row in role_weights:
        if "value" not in row:
            row["value"] = row.get("weight")

    radar_axis_config = configs.get("radar_axis_config") if isinstance(configs.get("radar_axis_config"), list) else []
    position_action_config = configs.get("position_action_config") if isinstance(configs.get("position_action_config"), list) else []

    configs.update(
        {
            "action_catalog": CANONICAL_ACTION_CATALOG,
            "position_action_scope": POSITION_ACTION_SCOPE,
            "legacy_alias_map": _legacy_alias_map_rows(),
            "role_weight_config": role_weights,
            "radar_axis_config": _with_canonical_action_id(radar_axis_config),
            "position_action_config": _with_canonical_action_id(position_action_config),
        }
    )
    configs.setdefault("legacy_role_weight_config", source_rows)

    normalized.update(
        {
            "schema": "fineplay.model_room.baseline.v0.2",
            "slot": "xfp_weights",
            "model_kind": "xfp_canonical_action_config_pack",
            "model_name": "xFP canonical action/role weight pack",
            "score_formula": "NormalizedActionScore(action_id) * RoleWeight, with role/radar differences applied above shared A01-A24 actions",
            "rows": role_weights,
            "configs": configs,
        }
    )
    return normalized


def _artifact(filename: str, label: str, notes: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "filename": filename,
        "label": label,
        "notes": notes,
        "file_bytes": json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"),
    }


def _float_grid_values(max_value: float, step: float) -> list[float]:
    values: list[float] = []
    current = 0.0
    while current <= max_value + 1e-9:
        values.append(round(current, 3))
        current += step
    if values[-1] != max_value:
        values.append(max_value)
    return values


def _pitch_grid(x_step: float = 2.5, y_step: float = 2.0) -> list[tuple[float, float]]:
    xs = _float_grid_values(FIELD_W, x_step)
    ys = _float_grid_values(FIELD_H, y_step)
    return [(x, y) for x in xs for y in ys]


def _goalmouth_grid(x_step: float = 0.02, y_step: float = 0.04) -> list[tuple[float, float]]:
    xs = _float_grid_values(1.0, x_step)
    ys = _float_grid_values(1.0, y_step)
    return [(x, y) for x in xs for y in ys]


def _xgot_value(
    xg: float,
    goalmouth_x: float,
    goalmouth_y: float,
    *,
    under_pressure: bool = False,
    one_on_one: bool = False,
    is_header: bool = False,
    is_weak_foot: bool = False,
) -> float:
    clipped_xg = max(0.0, min(1.0, xg))
    gx = max(0.0, min(1.0, goalmouth_x))
    gy = max(0.0, min(1.0, goalmouth_y))
    lateral_offset = abs(gx - 0.5) / 0.5
    height_factor = gy
    corner_factor = min(1.0, math.sqrt((lateral_offset**2 + height_factor**2) / 2.0))
    placement_factor = 0.65 * lateral_offset + 0.35 * height_factor
    score = (
        clipped_xg * 0.58
        + corner_factor * 0.24
        + placement_factor * 0.14
        + (0.05 if one_on_one else 0.0)
        - (0.04 if under_pressure else 0.0)
        - (0.03 if is_header else 0.0)
        - (0.02 if is_weak_foot else 0.0)
    )
    return round(max(0.0, min(1.0, score)), 4)


def _build_xg_baseline(metrics: dict[str, Any]) -> dict[str, Any]:
    points = []
    for x, y in _pitch_grid():
        estimate = estimate_xg("HOME", "L2R", x, y, False, False)
        points.append(
            {
                "x": x,
                "y": y,
                "value": estimate["xg"],
                "xg": estimate["xg"],
                "distance": estimate["distance"],
                "angle_rad": estimate["angle_rad"],
            }
        )
    return {
        "schema": "fineplay.model_room.baseline.v0.1",
        "slot": "xg",
        "model_kind": "code_formula",
        "model_name": "FinePlay current xG estimator",
        "runtime": "apps/api/app/xg.py::estimate_xg",
        "formula": {
            "exponent": "1.00*log1p(distance) - 2.00*log1p(angle) + 0.70*header + 0.40*weak_foot + 0.30*log1p(distance)*header - 1.10 + endline_penalty",
            "xg": "1 / (1 + exp(exponent))",
            "field": "105x68",
            "goal": {"x": 105.0, "y": 34.0, "posts_y": [30.34, 37.66]},
        },
        "features": ["start_x", "start_y", "distance_to_goal", "angle_to_goal", "is_header", "is_weak_foot"],
        "xfp_v02_metrics": metrics.get("fp_xG"),
        "source_references": [
            "/Users/andy/Project/xFP/reference/fp_xg_epv_pitch_control_v01.md",
            "/Users/andy/Project/xFP/outputs/fp_models/fp_xg_statsbomb_teacher_hgb_v02.joblib",
        ],
        "points": points,
    }


def _build_xgot_baseline() -> dict[str, Any]:
    points = []
    for x, y in _pitch_grid():
        xg = float(estimate_xg("HOME", "L2R", x, y, False, False)["xg"])
        far_corner_x = max(0.05, min(0.95, 0.5 + ((y - 34.0) / 34.0) * 0.42))
        upper_bias_y = max(0.15, min(0.92, 0.42 + ((x - 70.0) / 35.0) * 0.28))
        xgot = _xgot_value(xg, far_corner_x, upper_bias_y)
        points.append(
            {
                "x": x,
                "y": y,
                "value": xgot,
                "xgot": xgot,
                "assumed_xg": xg,
                "goalmouth_x": round(far_corner_x, 3),
                "goalmouth_y": round(upper_bias_y, 3),
            }
        )
    goalmouth_points = []
    reference_xg = 0.16
    for goalmouth_x, goalmouth_y in _goalmouth_grid():
        xgot = _xgot_value(reference_xg, goalmouth_x, goalmouth_y)
        goalmouth_points.append(
            {
                "x": goalmouth_x,
                "y": goalmouth_y,
                "value": xgot,
                "xgot": xgot,
                "reference_xg": reference_xg,
                "goal_width_m": round(30.34 + goalmouth_x * 7.32, 3),
                "goal_height_m": round(goalmouth_y * 2.44, 3),
            }
        )
    return {
        "schema": "fineplay.model_room.baseline.v0.1",
        "slot": "xgot",
        "model_kind": "code_formula",
        "model_name": "FinePlay current xGOT estimator",
        "runtime": "apps/api/app/main.py::_estimate_xgot",
        "formula": {
            "xgot": "clip(xG*0.58 + corner_factor*0.24 + placement_factor*0.14 + context_adjustments, 0, 1)",
            "pace": "MID fixed baseline",
            "preview": "goal mouth points use a representative xG=0.16 to show final ball placement value",
        },
        "features": [
            "xg",
            "goalmouth_x",
            "goalmouth_y",
            "is_goal",
            "is_header",
            "is_weak_foot",
            "under_pressure",
            "one_on_one",
        ],
        "source_references": ["apps/api/app/main.py::_estimate_xgot"],
        "points": points,
        "goalmouth_points": goalmouth_points,
    }


def _build_epv_baseline(metrics: dict[str, Any]) -> dict[str, Any]:
    points = []
    for x, y in _pitch_grid():
        progress = max(0.0, min(1.0, x / FIELD_W))
        centrality = max(0.0, 1.0 - abs(y - 34.0) / 34.0)
        box_boost = 0.012 if x >= 88.5 and 13.84 < y < 54.16 else 0.0
        value = 0.006 + 0.011 * progress + 0.038 * (progress**2.35) * (0.45 + 0.55 * centrality) + box_boost
        points.append({"x": x, "y": y, "value": round(min(0.085, value), 4), "epv": round(min(0.085, value), 4)})
    return {
        "schema": "fineplay.model_room.baseline.v0.1",
        "slot": "epv",
        "model_kind": "xfp_reference_proxy",
        "model_name": "FinePlay EPV state value baseline",
        "formula": {
            "state_value": "V(x, y, pressure) = expected remaining shot-xG in current possession",
            "delta": "fp_EPV_delta = V(end_x, end_y, pressure) - V(start_x, start_y, pressure)",
            "preview_proxy": "0.006 + 0.011*progress + 0.038*progress^2.35*centrality_mix + penalty_box_boost",
        },
        "features": ["state_x", "state_y", "state_under_pressure"],
        "xfp_v02_metrics": metrics.get("fp_EPV"),
        "source_references": [
            "/Users/andy/Project/xFP/reference/fp_xg_epv_pitch_control_v01.md",
            "/Users/andy/Project/xFP/outputs/fp_models/fp_epv_state_hgb_regressor_v02.joblib",
        ],
        "points": points,
    }


def _team_control_at(x: float, y: float, allies: list[tuple[float, float]], opponents: list[tuple[float, float]]) -> float:
    reaction_time = 0.7
    max_speed = 5.5
    tau = 1.15

    def control(players: list[tuple[float, float]]) -> float:
        total = 0.0
        for px, py in players:
            distance = math.sqrt((px - x) ** 2 + (py - y) ** 2)
            intercept_time = reaction_time + distance / max_speed
            total += math.exp(-intercept_time / tau)
        return total

    ally_control = control(allies)
    opponent_control = control(opponents)
    denominator = ally_control + opponent_control
    return round(ally_control / denominator if denominator else 0.5, 4)


def _build_pitch_control_baseline() -> dict[str, Any]:
    allies = [(45.0, 34.0), (61.0, 22.0), (61.0, 46.0), (76.0, 34.0), (84.0, 26.0)]
    opponents = [(66.0, 34.0), (74.0, 22.0), (74.0, 46.0), (89.0, 34.0), (94.0, 42.0)]
    points = []
    for x, y in _pitch_grid():
        pc = _team_control_at(x, y, allies, opponents)
        points.append({"x": x, "y": y, "value": pc, "pitch_control": pc})
    return {
        "schema": "fineplay.model_room.baseline.v0.1",
        "slot": "pitch_control",
        "model_kind": "code_formula_proxy",
        "model_name": "FinePlay freeze-frame pitch control proxy",
        "formula": {
            "time_to_intercept": "T_i(z) = reaction_time + distance(player_i, z) / max_speed + orientation_penalty",
            "player_control": "control_i(z) = exp(-T_i(z) / tau)",
            "team_control": "sum(control_i for team) / sum(control_j for all players)",
            "delta": "PC_after(target_zone_or_ball_zone) - PC_before(source_zone_or_ball_zone)",
        },
        "parameters": {"reaction_time": 0.7, "max_speed": 5.5, "tau": 1.15, "orientation_penalty": 0.0},
        "sample_state": {"allies": allies, "opponents": opponents},
        "source_references": ["/Users/andy/Project/xFP/reference/fp_xg_epv_pitch_control_v01.md"],
        "points": points,
    }


def _build_xfp_weights_baseline(xfp_dir: Path) -> dict[str, Any]:
    output_dir = xfp_dir / "outputs" / "xfp_v02"
    legacy_role_weights = _read_csv_records(output_dir / "xfp_role_weight_config.csv")
    role_weights = _with_canonical_action_id(legacy_role_weights)
    for row in role_weights:
        row["value"] = row.get("weight")
    fallback_rows = [
        {"role_group": "FW", "role_name": "Winger", "legacy_action_code": "FW_A03", "action_id": "A03", "action_key": "Cross/OPP/Indirect/Goal", "weight": 5, "value": 5},
        {"role_group": "MF", "role_name": "Playmaker", "legacy_action_code": "MF_A04", "action_id": "A04", "action_key": "Pass/OWN/Direct/Progression", "weight": 5, "value": 5},
        {"role_group": "DF", "role_name": "Ball-Playing Defender", "legacy_action_code": "DF_A01", "action_id": "A04", "action_key": "Pass/OWN/Direct/Progression", "weight": 5, "value": 5},
    ]
    radar_axis_config = _with_canonical_action_id(_read_csv_records(output_dir / "xfp_radar_axis_config.csv"))
    position_action_config = _with_canonical_action_id(_read_csv_records(output_dir / "xfp_position_action_config.csv"))
    return canonicalize_xfp_weights_payload({
        "schema": "fineplay.model_room.baseline.v0.2",
        "slot": "xfp_weights",
        "model_kind": "xfp_canonical_action_config_pack",
        "model_name": "xFP canonical action/role weight pack",
        "score_formula": "NormalizedActionScore(action_id) * RoleWeight, with role/radar differences applied above shared A01-A24 actions",
        "reference_population": "six_league_pro_2025_26_outfield",
        "rows": role_weights or fallback_rows,
        "configs": {
            "action_catalog": CANONICAL_ACTION_CATALOG,
            "position_action_scope": POSITION_ACTION_SCOPE,
            "legacy_alias_map": _legacy_alias_map_rows(),
            "role_weight_config": role_weights or fallback_rows,
            "legacy_role_weight_config": legacy_role_weights,
            "radar_axis_config": radar_axis_config,
            "position_action_config": position_action_config,
            "score_calibration_config": _read_csv_records(output_dir / "xfp_score_calibration_config.csv"),
            "role_position_fit_config": _read_csv_records(output_dir / "xfp_role_position_fit_config.csv"),
            "role_production_bonus_config": _read_csv_records(output_dir / "xfp_role_production_bonus_config.csv"),
            "action_summary": _read_csv_records(output_dir / "xfp_action_summary.csv"),
        },
        "source_references": [
            "/Users/andy/Project/xFP/reference/xfp_v02_6league_evaluation_summary.md",
            "/Users/andy/Project/xFP/outputs/xfp_v02",
        ],
    })


def build_fpa_model_room_baseline_artifacts(xfp_reference_dir: Path | None = None) -> dict[str, dict[str, Any]]:
    xfp_dir = xfp_reference_dir or DEFAULT_XFP_REFERENCE_DIR
    metrics = _read_json(xfp_dir / "outputs" / "fp_models" / "fp_model_metrics_v02.json")
    return {
        "xg": _artifact(
            "fineplay_xg_code_formula_v0_1.json",
            "Current xG Formula Baseline",
            "Generated from live admin xG code and xFP v0.2 teacher metrics.",
            _build_xg_baseline(metrics),
        ),
        "xgot": _artifact(
            "fineplay_xgot_code_formula_v0_1.json",
            "Current xGOT Formula Baseline",
            "Generated from live admin xGOT placement formula.",
            _build_xgot_baseline(),
        ),
        "epv": _artifact(
            "fineplay_epv_xfp_reference_v0_1.json",
            "xFP EPV Reference Baseline",
            "Generated from xFP EPV state-value design and v0.2 metrics.",
            _build_epv_baseline(metrics),
        ),
        "pitch_control": _artifact(
            "fineplay_pitch_control_proxy_v0_1.json",
            "Pitch Control Proxy Baseline",
            "Generated from xFP freeze-frame pitch control interface.",
            _build_pitch_control_baseline(),
        ),
        "xfp_weights": _artifact(
            "fineplay_xfp_weights_canonical_v0_2_config_pack.json",
            "xFP Canonical Weight Config Pack",
            "Generated from xFP v0.2 configs with shared A01-A24 canonical action ids and legacy alias mapping.",
            _build_xfp_weights_baseline(xfp_dir),
        ),
    }
