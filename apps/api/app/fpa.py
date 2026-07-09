import base64
import io
import json
import os
import re
import zipfile
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from mplsoccer import Pitch
from PIL import Image, ImageDraw, ImageFont

from .fcm_cards import render_reference_heatmap, render_reference_passmap
from .xg import estimate_xg as shared_estimate_xg

FIELD_W = 105
FIELD_H = 68
DEFAULT_FPA_REPORT_TITLE = "FPA Visual Reports"

ACTION_CODES = {
    "ddd": "Shot",
    "dd": "Shot",
    "d": "Shot",
    "db": "Shot",
    "zz": "Pass",
    "z": "Pass",
    "cc": "Cross",
    "c": "Cross",
    "ss": "Pass",
    "s": "Pass",
    "ee": "Breakthrough",
    "e": "Breakthrough",
    "pn": "Penetration",  # 오프더볼 침투 런(Off-ball Run) — xFP Event=Penetration (xFP/fpa 이식)
    "pr": "Press",  # 압박 — 팀 단위 행위라 선수 번호 없이 'pr'만 입력. 압박자=프레임에 찍힌 아군, closing 기준=상대 위치 (점수 공식은 추후)
    "rr": "Dribble",
    "r": "Dribble",
    "gp": "Gain",
    "m": "Miss",
    "aa": "Tackle",
    "q": "Intercept",
    # "qq": "Acquisition" 제거 (2026-07-08) — 수비는 before/after 위치변화로 EPV·PC 채점. 획득(possession-win) 개념 폐기.
    # 옛 데이터의 Action="Acquisition" 행은 정규화/집계에서 계속 인식(하위호환)하되 신규 입력은 불가.
    "w": "Clear",
    "ww": "Cutout",
    "qw": "Block",
    "v": "Catching",
    "vv": "Punching",
    "sv": "Save",
    "bb": "Duel",
    "b": "Duel",
    "f": "Foul",
    "ff": "Be Fouled",
    "o": "Offside",
    "touch": "Touch",
    "t": "Throw-in",
    "tt": "Throw-in",
    "st": "Sprint",
    "tr": "Throw-in",
}
TAG_CODES = {
    "k": "Key Pass",
    "a": "Assist",
    "h": "Header",
    "r": "Aerial",
    "f": "Foot",
    "w": "Weak Foot",
    "n": "In-box",
    "u": "Out-box",
    "p": "Progressive",
    "c": "Counter Attack",
    "sw": "Switch",
    "wf": "Weak Foot",
    "ft": "First Time",
    "sf": "Suffered",
    "up": "Under Pressure",
    "oo": "One-on-One",
    "1v1": "One-on-One",
    "lt": "Long Throw",
    "box": "Box Entry",
    "ret": "Possession Retained",
    "loss": "Possession Lost",
    "hc": "High Cross",
    "lc": "Low Cross",
}
TWO_DOT_ACTION_CODES = {"s", "c", "r", "e", "z", "tr", "pn"}
# 수비 액션(태클/인터셉트/차단) — 상대 '패스 공' 경로를 before 프레임에 화살표로 그림 (2026-07-09 확정).
# 화살표 start=상대 볼 출발점, end=끊은 지점. 점수 = 상대가 만든 전진위협을 막은 값 =
# '상대 공격방향' 기준 EPV(end)−EPV(start) (prevented threat). 좌표 2개(화살표)로 채점, EPV-방어만 사용.
# 제외: Duel(b/bb)=경합 포인트, Clear(w)=단독 지점.
DEFENSE_ARROW_CODES = {"aa", "q", "ww"}
# Block(qw)=슛블락 — 상대 '슛' 궤적을 before 프레임에 화살표로(start=슈터, end=블록 지점).
# 점수 = 막은 슛의 xG를 블로커에게 승계(상대 공격방향으로 슈터 위치 뒤집어 estimate_xg) × BLOCK_CREDIT. xG 컬럼 사용.
SHOT_BLOCK_CODES = {"qw"}
BLOCK_CREDIT = 1.0
SHOT_RESULT_TAGS = {"Goal", "On Target", "Off Target", "Blocked"}
SHOT_ACTIONS_LEGACY = ["Goal", "Shot On Target", "Shot", "Blocked Shot"]


def _tag_set(value: Any) -> set[str]:
    return {part.strip() for part in str(value or "").split(",") if part.strip()}


def _has_tag(value: Any, tag: str) -> bool:
    return tag in _tag_set(value)


def _is_shot_row(row: pd.Series) -> bool:
    action = _clean_scalar_text(row.get("Action", ""))
    tags = _tag_set(row.get("Tags", ""))
    return action in SHOT_ACTIONS_LEGACY or (action == "Shot" and bool(tags & SHOT_RESULT_TAGS))


def _is_goal_row(row: pd.Series) -> bool:
    action = _clean_scalar_text(row.get("Action", ""))
    return action == "Goal" or (action == "Shot" and _has_tag(row.get("Tags", ""), "Goal"))


def _is_on_target_shot_row(row: pd.Series) -> bool:
    action = _clean_scalar_text(row.get("Action", ""))
    tags = _tag_set(row.get("Tags", ""))
    return action in ["Goal", "Shot On Target"] or (action == "Shot" and bool(tags & {"Goal", "On Target"}))


def _normalize_canonical_event(action: Any, tags: Any) -> tuple[str, str, str]:
    action_text = _clean_scalar_text(action)
    tag_values = _tag_set(tags)
    if action_text == "Shot" or action_text in SHOT_ACTIONS_LEGACY:
        if action_text == "Goal" or "Goal" in tag_values:
            return "Shot", "Shot", "Goal"
        if action_text == "Shot On Target" or "On Target" in tag_values:
            return "Shot", "Shot", "On Target"
        if action_text == "Blocked Shot" or "Blocked" in tag_values:
            return "Shot", "Shot", "Blocked"
        if "Off Target" in tag_values:
            return "Shot", "Shot", "Off Target"
        return "Shot", "Shot", "Attempt"
    if action_text == "Throw-in":
        if "Retained" in tag_values or "Possession Retained" in tag_values or "Success" in tag_values:
            result = "Retained"
        elif "Lost" in tag_values or "Possession Lost" in tag_values or "Fail" in tag_values:
            result = "Lost"
        else:
            result = "Unknown"
        subtype = "Long Throw" if "Long Throw" in tag_values else "Throw-in"
        return "ThrowIn", subtype, result
    if action_text == "Pass":
        return "Pass", "Pass", "Success" if "Success" in tag_values else "Fail"
    if action_text == "Cross":
        subtype = "High Cross" if "High Cross" in tag_values else "Low Cross" if "Low Cross" in tag_values else "Cross"
        return "Cross", subtype, "Success" if "Success" in tag_values else "Fail"
    if action_text == "Dribble":
        return "Dribble", "Carry" if "Carry" in tag_values else "Dribble", "Success" if "Success" in tag_values else "Fail"
    if action_text == "Penetration":
        return "Penetration", "Off-ball Run", "Success" if "Success" in tag_values else "Unknown"
    if action_text in ["Tackle", "Intercept", "Acquisition", "Clear", "Cutout", "Block"]:
        return "Defense", action_text, "Success" if "Success" in tag_values else "Fail"
    return action_text or "Unknown", action_text or "Unknown", "Success" if "Success" in tag_values else "Fail" if "Fail" in tag_values else "Unknown"


def add_canonical_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "Tags" not in df.columns:
        df["Tags"] = ""
    canonical = df.apply(lambda row: _normalize_canonical_event(row.get("Action", ""), row.get("Tags", "")), axis=1)
    df["EventType"] = [item[0] for item in canonical]
    df["EventSubtype"] = [item[1] for item in canonical]
    df["Result"] = [item[2] for item in canonical]
    df["BodyPart"] = np.where(df["Tags"].astype(str).str.contains("Header", na=False), "Head", np.where(df["Tags"].astype(str).str.contains("Foot", na=False), "Foot", ""))
    df["FootUsage"] = np.where(df["Tags"].astype(str).str.contains("Weak Foot", na=False), "Weak Foot", "")
    df["Phase"] = np.where(df["EventType"].eq("ThrowIn"), "Restart / Quasi Set Piece", "")
    return df


def _dedupe_dataframe_columns(df: pd.DataFrame) -> pd.DataFrame:
    if df.columns.has_duplicates:
        return df.loc[:, ~df.columns.duplicated()].copy()
    return df


def _scalar_value(value: Any) -> Any:
    if isinstance(value, pd.Series):
        non_null = value.dropna()
        return non_null.iloc[0] if not non_null.empty else ""
    if isinstance(value, np.ndarray):
        flat = value.ravel()
        return flat[0] if flat.size else ""
    if isinstance(value, (list, tuple)):
        return value[0] if value else ""
    return value


def _clean_scalar_text(value: Any) -> str:
    value = _scalar_value(value)
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if text.endswith(".0") and text.replace(".", "", 1).isdigit():
        return text[:-2]
    return text


def convert_time_to_seconds(df: pd.DataFrame) -> pd.DataFrame:
    def time_to_seconds(time_str: str) -> int:
        try:
            parts = str(time_str).split(":")
            if len(parts) == 2:
                minutes, seconds = map(int, parts)
                return minutes * 60 + seconds
            if len(parts) == 3:
                hours, minutes, seconds = map(int, parts)
                return hours * 3600 + minutes * 60 + seconds
        except (TypeError, ValueError):
            return 0
        return 0

    if "Time" in df.columns:
        df["Time(s)"] = df["Time"].apply(time_to_seconds)
    return df


def is_in_final_third(x: Any) -> Any:
    return x >= 70


def is_in_penalty_area(x: Any, y: Any) -> Any:
    return (x > 88.5) & (y > 13.84) & (y < 54.16)


def is_in_either_penalty_area(x: Any, y: Any) -> Any:
    return (((x >= 0) & (x < 16.5)) | ((x > 88.5) & (x <= FIELD_W))) & (y > 13.84) & (y < 54.16)


def is_progressive_pass(start_x: Any, end_x: Any) -> Any:
    return end_x - start_x >= 10


def _format_path_points(points: list[tuple[float, float]]) -> str:
    return ";".join(f"{round(x, 2)},{round(y, 2)}" for x, y in points)


def _format_dual_points(points: list[dict[str, Any]]) -> str:
    formatted: list[str] = []
    for point in points:
        try:
            point_team = str(point.get("team") or "ally")
            team_side = str(point.get("team_side") or "").strip()
            role = str(point.get("role") or "").strip()
            number = str(point.get("number") or "").strip()
            label_parts = [part for part in [team_side or point_team, number, role] if part]
            label = "/".join(label_parts)
            formatted.append(f"{label}:{round(float(point['meter_x']), 2)},{round(float(point['meter_y']), 2)}")
        except (KeyError, TypeError, ValueError):
            continue
    return ";".join(formatted)


def _parse_dual_points(value: Any) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for x, y in _parse_path_points(value):
        points.append({"meter_x": x, "meter_y": y, "team": "ally"})
    return points


def _dual_team_counts(points: list[dict[str, Any]]) -> tuple[int, int]:
    ally_count = 0
    opponent_count = 0
    for point in points:
        if str(point.get("team") or "ally") == "opponent":
            opponent_count += 1
        else:
            ally_count += 1
    return ally_count, opponent_count


def _dual_side_counts(points: list[dict[str, Any]]) -> tuple[int, int]:
    home_count = 0
    away_count = 0
    for point in points:
        team_side = str(point.get("team_side") or "")
        if team_side == "home":
            home_count += 1
        elif team_side == "away":
            away_count += 1
    return home_count, away_count


def _dual_role_counts(points: list[dict[str, Any]]) -> tuple[int, int]:
    gk_count = 0
    numbered_count = 0
    for point in points:
        if str(point.get("role") or "") == "gk":
            gk_count += 1
        if str(point.get("number") or "").strip():
            numbered_count += 1
    return gk_count, numbered_count


def _compact_dual_pitch_state(dual_pitch: dict[str, Any] | None) -> dict[str, Any] | None:
    if not dual_pitch:
        return None

    def points_for(key: str) -> list[dict[str, Any]]:
        state = dual_pitch.get(key) or {}
        raw_points = state if isinstance(state, list) else state.get("dots") or []
        points: list[dict[str, Any]] = []
        for point in raw_points:
            try:
                point_team = str(point.get("team") or "ally")
                if point_team not in {"ally", "opponent"}:
                    point_team = "ally"
                compact_point: dict[str, Any] = {
                    "meter_x": round(float(point["meter_x"]), 2),
                    "meter_y": round(float(point["meter_y"]), 2),
                    "team": point_team,
                }
                for source_key, target_key in [
                    ("team_side", "team_side"),
                    ("teamSide", "team_side"),
                    ("role", "role"),
                    ("layer", "layer"),
                    ("number", "number"),
                    ("id", "id"),
                ]:
                    value = str(point.get(source_key) or "").strip()
                    if value:
                        compact_point[target_key] = value
                points.append(compact_point)
            except (KeyError, TypeError, ValueError):
                continue
        return points

    before_points = points_for("before")
    after_points = points_for("after")
    if not before_points and not after_points:
        return None
    return {
        "schema": "fpa_dual_pitch_state.v0.2",
        "input_tier": str(dual_pitch.get("input_tier") or "minimal"),
        "actor_team": str(dual_pitch.get("actor_team") or ""),
        "primary_row_index": dual_pitch.get("primary_row_index"),
        "before": before_points,
        "after": after_points,
    }


def _actor_present_in_after(dual_pitch: dict[str, Any] | None, player_number: str) -> bool:
    """dual after 프레임에 행위자(같은 번호·아군) 점이 있으면 True. 소유 획득(possession-win) 판정용."""
    if not dual_pitch or not player_number:
        return False
    after = dual_pitch.get("after") or {}
    raw_points = after if isinstance(after, list) else after.get("dots") or []
    for point in raw_points:
        try:
            number = str(point.get("number") or "").strip()
            point_team = str(point.get("team") or "ally")
        except AttributeError:
            continue
        if number == str(player_number) and point_team in {"ally", ""}:
            return True
    return False


def _encode_dual_pitch_state(dual_pitch: dict[str, Any] | None) -> str:
    compact = _compact_dual_pitch_state(dual_pitch)
    if not compact:
        return ""
    return json.dumps(compact, ensure_ascii=False, separators=(",", ":"))


def _decode_dual_pitch_state(value: Any) -> dict[str, Any] | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def _format_metrics(metrics: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ["xG", "xGOT", "EPV", "PC"]:
        value = metrics.get(key)
        if value in (None, ""):
            continue
        try:
            parts.append(f"{key}={float(value):.3f}")
        except (TypeError, ValueError):
            parts.append(f"{key}={value}")
    return ", ".join(parts)


def _parse_metrics(value: Any) -> dict[str, str]:
    text = str(value or "").strip()
    if text.startswith("Metrics: "):
        text = text.replace("Metrics: ", "", 1)
    metrics: dict[str, str] = {}
    for raw_part in text.split(","):
        if "=" not in raw_part:
            continue
        key, raw_value = raw_part.split("=", 1)
        key = key.strip()
        raw_value = raw_value.strip()
        if key in {"xG", "xGOT", "EPV", "PC"} and raw_value:
            metrics[key] = raw_value
    return metrics


def _parse_path_points(value: Any) -> list[tuple[float, float]]:
    text = str(value or "").strip()
    if not text:
        return []
    points: list[tuple[float, float]] = []
    for raw_point in text.split(";"):
        parts = [part.strip() for part in raw_point.split(",", 1)]
        if len(parts) != 2:
            continue
        try:
            points.append((float(parts[0]), float(parts[1])))
        except ValueError:
            continue
    return points


def _metric_text_value(value: Any) -> str:
    if value in (None, ""):
        return ""
    try:
        return f"{float(value):.3f}"
    except (TypeError, ValueError):
        return str(value)


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(number):
        return None
    return number


def _epv_state_value(x: Any, y: Any) -> float | None:
    x_value = _finite_float(x)
    y_value = _finite_float(y)
    if x_value is None or y_value is None:
        return None
    progress = max(0.0, min(1.0, x_value / FIELD_W))
    centrality = max(0.0, 1.0 - abs(y_value - FIELD_H / 2) / (FIELD_H / 2))
    box_boost = 0.012 if x_value >= 88.5 and 13.84 < y_value < 54.16 else 0.0
    value = 0.006 + 0.011 * progress + 0.038 * (progress**2.35) * (0.45 + 0.55 * centrality) + box_boost
    return round(min(0.085, value), 4)


def _epv_delta(start_x: Any, start_y: Any, end_x: Any, end_y: Any) -> float | None:
    before = _epv_state_value(start_x, start_y)
    after = _epv_state_value(end_x, end_y)
    if before is None or after is None:
        return None
    return round(after - before, 4)


def _point_team_side(point: dict[str, Any], actor_team: str | None = None) -> str:
    side = str(point.get("team_side") or point.get("teamSide") or "").lower()
    if side in {"home", "away"}:
        return side
    relation = str(point.get("team") or "").lower()
    actor = str(actor_team or "").lower()
    if actor in {"home", "away"} and relation == "ally":
        return actor
    if actor == "home" and relation == "opponent":
        return "away"
    if actor == "away" and relation == "opponent":
        return "home"
    return ""


def _dual_points_by_side(points: Any, actor_team: str | None = None) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    home: list[tuple[float, float]] = []
    away: list[tuple[float, float]] = []
    if not isinstance(points, list):
        return home, away
    for point in points:
        if not isinstance(point, dict):
            continue
        x_value = _finite_float(point.get("meter_x", point.get("x")))
        y_value = _finite_float(point.get("meter_y", point.get("y")))
        if x_value is None or y_value is None:
            continue
        side = _point_team_side(point, actor_team)
        if side == "home":
            home.append((x_value, y_value))
        elif side == "away":
            away.append((x_value, y_value))
    return home, away


def _pitch_control_at(x: Any, y: Any, home_points: list[tuple[float, float]], away_points: list[tuple[float, float]]) -> float | None:
    x_value = _finite_float(x)
    y_value = _finite_float(y)
    if x_value is None or y_value is None or not home_points or not away_points:
        return None

    reaction_time = 0.7
    shared_player_speed = 5.5
    tau = 1.15

    def team_control(points: list[tuple[float, float]]) -> float:
        total = 0.0
        for point_x, point_y in points:
            distance = float(np.sqrt((x_value - point_x) ** 2 + (y_value - point_y) ** 2))
            arrival_time = reaction_time + distance / shared_player_speed
            total += float(np.exp(-arrival_time / tau))
        return total

    home_control = team_control(home_points)
    away_control = team_control(away_points)
    denominator = home_control + away_control
    if denominator <= 0:
        return None
    home_probability = home_control / denominator
    return round((home_probability * 2) - 1, 4)


def _pitch_control_delta(
    dual_state: dict[str, Any] | None,
    start_point: tuple[float, float],
    end_point: tuple[float, float],
) -> float | None:
    if not dual_state:
        return None
    actor_team = str(dual_state.get("actor_team") or "").lower()
    before_home, before_away = _dual_points_by_side(dual_state.get("before"), actor_team)
    after_home, after_away = _dual_points_by_side(dual_state.get("after"), actor_team)
    if not after_home and not after_away:
        after_home, after_away = before_home, before_away
    before_pc = _pitch_control_at(start_point[0], start_point[1], before_home, before_away)
    after_pc = _pitch_control_at(end_point[0], end_point[1], after_home, after_away)
    if before_pc is None or after_pc is None:
        return None
    return round(after_pc - before_pc, 4)


def _path_distance(points: list[tuple[float, float]]) -> float:
    if len(points) < 2:
        return 0.0
    return float(
        sum(
            np.sqrt((points[index][0] - points[index - 1][0]) ** 2 + (points[index][1] - points[index - 1][1]) ** 2)
            for index in range(1, len(points))
        )
    )


def analyze_pass_data(df: pd.DataFrame) -> pd.DataFrame:
    coord_cols = ["StartX", "StartY", "EndX", "EndY"]
    for col in coord_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    if not all(col in df.columns for col in coord_cols + ["Direction"]):
        return df

    is_left_direction = df["Direction"].str.lower() == "left"
    df["StartX_adj"] = np.where(is_left_direction, FIELD_W - df["StartX"], df["StartX"])
    df["StartY_adj"] = np.where(is_left_direction, FIELD_H - df["StartY"], df["StartY"])
    df["EndX_adj"] = np.where(is_left_direction, FIELD_W - df["EndX"], df["EndX"])
    df["EndY_adj"] = np.where(is_left_direction, FIELD_H - df["EndY"], df["EndY"])

    distance = np.sqrt((df["EndX_adj"] - df["StartX_adj"]) ** 2 + (df["EndY_adj"] - df["StartY_adj"]) ** 2)
    df["Distance"] = distance
    if "PathDistance" in df.columns:
        path_distance = pd.to_numeric(df["PathDistance"], errors="coerce")
        is_dribble = df.get("Action", "").astype(str) == "Dribble"
        df.loc[is_dribble & path_distance.notna() & (path_distance > 0), "Distance"] = path_distance
    df["Pass_Distance"] = np.select(
        [distance < 20, (distance >= 20) & (distance < 40), distance >= 40],
        ["short", "middle", "long"],
        default=None,
    )

    dx = df["EndX_adj"] - df["StartX_adj"]
    dy = df["EndY_adj"] - df["StartY_adj"]
    angle = np.degrees(np.arctan2(dy, dx))
    df["Angle"] = (angle + 360) % 360
    df["Pass_Direction"] = np.select(
        [
            (df["Angle"] >= 315) | (df["Angle"] < 45),
            (df["Angle"] >= 45) & (df["Angle"] < 135),
            (df["Angle"] >= 135) & (df["Angle"] < 225),
            (df["Angle"] >= 225) & (df["Angle"] < 315),
        ],
        ["forward", "left", "backward", "right"],
        default=None,
    )
    return df


def add_xg_to_data(df: pd.DataFrame) -> pd.DataFrame:
    if "xG" not in df.columns:
        df["xG"] = np.nan
    else:
        df["xG"] = pd.to_numeric(df["xG"], errors="coerce")
    shot_mask = df.apply(_is_shot_row, axis=1)
    df_shots = df[shot_mask].copy()
    if df_shots.empty:
        return df

    df_shots["Tags"] = df_shots["Tags"].astype(str).fillna("")

    def estimate_row_xg(row: pd.Series) -> float:
        tags = str(row.get("Tags", ""))
        meta = shared_estimate_xg(
            "HOME",
            "L2R",
            float(row["StartX_adj"]),
            float(row["StartY_adj"]),
            "Header" in tags,
            "Weak Foot" in tags,
        )
        return float(meta["xg"])

    df_shots["xG"] = df_shots.apply(estimate_row_xg, axis=1)
    computed_xg = df_shots.set_index("No")["xG"]
    missing_xg = df["xG"].isna()
    df.loc[missing_xg, "xG"] = df.loc[missing_xg, "No"].map(computed_xg)
    return df


def auto_tag_key_pass_and_assist(df: pd.DataFrame) -> pd.DataFrame:
    df_sorted = df.sort_values(by="No").reset_index(drop=True)
    df_sorted["Tags"] = df_sorted["Tags"].astype(str).fillna("")

    for i in range(1, len(df_sorted)):
        current_event = df_sorted.loc[i]
        prev_event = df_sorted.loc[i - 1]
        current_team_id = _clean_scalar_text(current_event.get("TeamID", ""))
        prev_team_id = _clean_scalar_text(prev_event.get("TeamID", ""))
        current_player = _clean_scalar_text(current_event.get("Player", ""))
        prev_player = _clean_scalar_text(prev_event.get("Player", ""))
        if (
            _is_shot_row(current_event)
            and prev_event["Action"] in ["Pass", "Cross"]
            and "Success" in prev_event["Tags"]
            and prev_team_id == current_team_id
            and prev_player != current_player
        ):
            if _is_goal_row(current_event):
                if "Assist" not in prev_event["Tags"]:
                    df_sorted.loc[i - 1, "Tags"] = (prev_event["Tags"] + ", Assist").lstrip(", ")
            elif "Key Pass" not in prev_event["Tags"] and "Assist" not in prev_event["Tags"]:
                df_sorted.loc[i - 1, "Tags"] = (prev_event["Tags"] + ", Key Pass").lstrip(", ")
    return df_sorted


def create_tableau_pass_data(df: pd.DataFrame) -> pd.DataFrame:
    coord_cols = ["StartX", "StartY", "EndX", "EndY"]
    for col in coord_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df_origin = df.copy()
    df_origin["table"] = "origin"
    df_apply = df.copy()
    df_apply[["StartX", "StartY", "EndX", "EndY"]] = df_apply[["EndX", "EndY", "StartX", "StartY"]]
    df_apply["table"] = "apply"

    combined_df = pd.concat([df_origin, df_apply], ignore_index=True)
    combined_df["Pont Size"] = np.where(combined_df["table"] == "origin", 1, 5)
    is_left = combined_df["Direction"].str.lower() == "left"
    combined_df["StartX_adj"] = np.where(is_left, FIELD_W - combined_df["StartX"], combined_df["StartX"])
    combined_df["StartY_adj"] = np.where(is_left, FIELD_H - combined_df["StartY"], combined_df["StartY"])
    combined_df["EndX_adj"] = np.where(is_left, FIELD_W - combined_df["EndX"], combined_df["EndX"])
    combined_df["EndY_adj"] = np.where(is_left, FIELD_H - combined_df["EndY"], combined_df["EndY"])
    return combined_df


def create_player_summary(df_analyzed: pd.DataFrame) -> pd.DataFrame:
    all_players = df_analyzed["Player"].unique()
    summary = pd.DataFrame(index=all_players)
    required_cols = [
        "Total_Pass",
        "Success_Pass",
        "Key_Pass",
        "Assist",
        "Fail_Pass",
        "Pass_Success_Rate",
        "Progressive_Pass_Success",
        "Final_Third_Pass_Success",
        "PA_Pass_Success",
        "Own_Half_Pass_Score",
        "Own_Half_Pass_Fail",
        "forward",
        "left",
        "right",
        "backward",
        "short",
        "middle",
        "long",
    ]
    for col in required_cols:
        summary[col] = 0.0 if "Rate" in col else 0

    if "Tags" not in df_analyzed.columns:
        df_analyzed["Tags"] = ""
    df_pass = df_analyzed[df_analyzed["Action"].isin(["Pass", "Cross"])].copy()
    if df_pass.empty:
        return summary

    agg_summary = df_pass.groupby("Player").agg(
        Total_Pass=("Action", "count"),
        Success_Pass=("Tags", lambda x: x.str.contains("Success").sum()),
        Key_Pass=("Tags", lambda x: x.str.contains("Key").sum()),
        Assist=("Tags", lambda x: x.str.contains("Assist").sum()),
    )
    summary.update(agg_summary)
    summary["Fail_Pass"] = summary["Total_Pass"] - summary["Success_Pass"]
    summary["Pass_Success_Rate"] = np.where(
        summary["Total_Pass"] > 0, (summary["Success_Pass"] / summary["Total_Pass"] * 100), 0
    ).round(2)

    summary.update(pd.pivot_table(df_pass, values="Action", index="Player", columns="Pass_Direction", aggfunc="count").fillna(0))
    summary.update(pd.pivot_table(df_pass, values="Action", index="Player", columns="Pass_Distance", aggfunc="count").fillna(0))

    df_pass_success = df_pass[df_pass["Tags"].str.contains("Success")]
    if not df_pass_success.empty:
        summary["Progressive_Pass_Success"] = (
            df_pass_success[is_progressive_pass(df_pass_success["StartX_adj"], df_pass_success["EndX_adj"])]
            .groupby("Player")["Action"]
            .count()
            .reindex(all_players)
            .fillna(0)
        )
        summary["Final_Third_Pass_Success"] = (
            df_pass_success[is_in_final_third(df_pass_success["StartX_adj"])]
            .groupby("Player")["Action"]
            .count()
            .reindex(all_players)
            .fillna(0)
        )
        summary["PA_Pass_Success"] = (
            df_pass_success[is_in_penalty_area(df_pass_success["EndX_adj"], df_pass_success["EndY_adj"])]
            .groupby("Player")["Action"]
            .count()
            .reindex(all_players)
            .fillna(0)
        )

        df_own_half = df_pass_success[df_pass_success["StartX_adj"] <= 52.5].copy()
        if not df_own_half.empty:
            df_own_half["x_gain"] = df_own_half["EndX_adj"] - df_own_half["StartX_adj"]
            df_own_half["Score"] = 0.5 + np.where(df_own_half["x_gain"] >= 5, df_own_half["x_gain"] * 0.1, 0)
            summary["Own_Half_Pass_Score"] = df_own_half.groupby("Player")["Score"].sum().reindex(all_players).fillna(0)

    df_pass_fail_own = df_pass[(~df_pass["Tags"].str.contains("Success")) & (df_pass["StartX_adj"] <= 52.5)]
    summary["Own_Half_Pass_Fail"] = df_pass_fail_own.groupby("Player")["Action"].count().reindex(all_players).fillna(0)
    int_cols = [col for col in required_cols if "Rate" not in col]
    summary[int_cols] = summary[int_cols].astype(int)
    return summary.sort_values(by="Total_Pass", ascending=False)


def create_shooter_summary(df_with_xg: pd.DataFrame) -> pd.DataFrame:
    all_players = df_with_xg["Player"].unique()
    summary = pd.DataFrame(index=all_players)
    required_cols = [
        "Total_Shots",
        "Shots_On_Target",
        "Goals",
        "Total_xG",
        "Headed_Goals",
        "Outbox_Goals",
        "Counter_Attack_Goals",
        "Catch_Count",
        "Total_SOT_xG_Conceded",
        "Goals_Conceded",
    ]
    for col in required_cols:
        summary[col] = 0.0

    shot_mask = df_with_xg.apply(_is_shot_row, axis=1)
    df_shots = df_with_xg[shot_mask].copy()
    if df_shots.empty:
        return summary

    df_shots["Tags"] = df_shots["Tags"].fillna("")
    df_shots["Is_SOT"] = df_shots.apply(_is_on_target_shot_row, axis=1)
    df_shots["Is_Goal"] = df_shots.apply(_is_goal_row, axis=1)
    agg_summary = df_shots.groupby("Player").agg(Total_Shots=("Action", "count"), Shots_On_Target=("Is_SOT", "sum"), Goals=("Is_Goal", "sum"), Total_xG=("xG", "sum"))
    summary.update(agg_summary)

    df_goals = df_shots[df_shots["Is_Goal"]]
    if not df_goals.empty:
        summary["Headed_Goals"] = df_goals[df_goals["Tags"].str.contains("Header")].groupby("Player")["Action"].count().reindex(all_players).fillna(0)
        summary["Outbox_Goals"] = df_goals[df_goals["Tags"].str.contains("Out-box")].groupby("Player")["Action"].count().reindex(all_players).fillna(0)
        summary["Counter_Attack_Goals"] = df_goals[df_goals["Tags"].str.contains("Counter Attack")].groupby("Player")["Action"].count().reindex(all_players).fillna(0)

    df_catch = df_with_xg[df_with_xg["Action"] == "Catching"]
    summary["Catch_Count"] = df_catch.groupby("Player")["Action"].count().reindex(all_players).fillna(0)
    team_stats = (
        df_with_xg.groupby("TeamID")
        .agg(
            Team_SOT_xG=("xG", lambda x: x[df_with_xg["Action"].isin(["Goal", "Shot On Target"])].sum()),
            Team_Goals=("Action", lambda x: (x == "Goal").sum()),
        )
        .to_dict("index")
    )
    player_teams = df_with_xg[["Player", "TeamID"]].drop_duplicates().set_index("Player")["TeamID"]
    all_team_ids = set(df_with_xg["TeamID"].unique())
    for player in all_players:
        if player in player_teams:
            my_team = player_teams[player]
            opponent_teams = [team_id for team_id in all_team_ids if team_id != my_team]
            if opponent_teams:
                stats = team_stats.get(opponent_teams[0], {"Team_SOT_xG": 0, "Team_Goals": 0})
                summary.at[player, "Total_SOT_xG_Conceded"] = stats["Team_SOT_xG"]
                summary.at[player, "Goals_Conceded"] = stats["Team_Goals"]

    summary[["Total_Shots", "Shots_On_Target", "Goals", "Headed_Goals", "Outbox_Goals", "Counter_Attack_Goals"]] = summary[
        ["Total_Shots", "Shots_On_Target", "Goals", "Headed_Goals", "Outbox_Goals", "Counter_Attack_Goals"]
    ].astype(int)
    return summary.sort_values(by="Goals", ascending=False)


def create_cross_summary(df_analyzed: pd.DataFrame) -> pd.DataFrame:
    all_players = df_analyzed["Player"].unique()
    summary = pd.DataFrame(index=all_players)
    for col in ["Total_Crosses", "Successful_Crosses", "Cross_Accuracy", "Central_PA_Cross_Success"]:
        summary[col] = 0.0

    if "Tags" not in df_analyzed.columns:
        df_analyzed["Tags"] = ""
    df_cross = df_analyzed[df_analyzed["Action"] == "Cross"].copy()
    if df_cross.empty:
        return summary

    agg_summary = df_cross.groupby("Player").agg(
        Total_Crosses=("Action", "count"),
        Successful_Crosses=("Tags", lambda x: x.str.contains("Success").sum()),
    )
    summary.update(agg_summary)
    summary["Cross_Accuracy"] = np.where(
        summary["Total_Crosses"] > 0, (summary["Successful_Crosses"] / summary["Total_Crosses"] * 100), 0
    ).round(2)

    df_cross_success = df_cross[df_cross["Tags"].str.contains("Success")]
    if not df_cross_success.empty:
        central_crosses = df_cross_success[
            is_in_penalty_area(df_cross_success["EndX_adj"], df_cross_success["EndY_adj"])
            & (df_cross_success["EndY_adj"] > 21.1)
            & (df_cross_success["EndY_adj"] < 46.9)
        ]
        summary["Central_PA_Cross_Success"] = central_crosses.groupby("Player")["Action"].count().reindex(all_players).fillna(0)

    summary[["Total_Crosses", "Successful_Crosses", "Central_PA_Cross_Success"]] = summary[
        ["Total_Crosses", "Successful_Crosses", "Central_PA_Cross_Success"]
    ].astype(int)
    return summary


def create_advanced_summary(df_analyzed: pd.DataFrame) -> pd.DataFrame:
    all_players = df_analyzed["Player"].unique()
    required_cols = [
        "Pass_Success_Count",
        "Breakthrough_Success",
        "Pass_Fail_Count",
        "Miss_Count",
        "FT_Pass_Success",
        "FT_Breakthrough_Success",
        "FT_Pass_Fail",
        "FT_Miss",
        "FT_Offside",
        "Tackle_Count",
        "Duel_Win_Count",
        "Intercept_Count",
        "Acquisition_Count",
        "Foul_Count",
        "Duel_Lose_Count",
        "Total_Tackles",
        "Successful_Tackles",
        "Final_Third_Tackle_Success",
        "PA_Foul_Tackles",
        "Clear_Count",
        "Cutout_Count",
        "Block_Count",
        "Total_Aerial_Duels",
        "Aerial_Duels_Won",
        "Received_Assist",
        "Received_Key_Pass",
        "SOT_Count",
        "Goal_Count",
        "Offside_Count",
        "Dribble_Attempt",
        "Cross_Success",
        "Be_Fouled",
        "Valid_Dribble_Distance",
        "Dribble_Fail_Count",
        "Sprint_Count",
        "Total_Sprint_Distance",
        "Header_SOT",
        "Header_Clear",
        "Aerial_Duels_Lost",
    ]
    summary = pd.DataFrame(index=all_players)
    for col in required_cols:
        summary[col] = 0

    if "Tags" not in df_analyzed.columns:
        df_analyzed["Tags"] = ""
    df_analyzed["Tags"] = df_analyzed["Tags"].fillna("")

    def safe_update(series: pd.Series, col_name: str) -> None:
        if not series.empty:
            summary[col_name] = series.reindex(all_players).fillna(0)

    df_pass_succ = df_analyzed[df_analyzed["Action"].isin(["Pass", "Cross"]) & df_analyzed["Tags"].str.contains("Success")]
    df_break_succ = df_analyzed[(df_analyzed["Action"] == "Breakthrough") & df_analyzed["Tags"].str.contains("Success")]
    df_pass_fail = df_analyzed[df_analyzed["Action"].isin(["Pass", "Cross"]) & ~df_analyzed["Tags"].str.contains("Success")]
    df_miss = df_analyzed[(df_analyzed["Action"] == "Miss") | ((df_analyzed["Action"] == "Shot") & df_analyzed["Tags"].str.contains("Off Target"))]
    safe_update(df_pass_succ.groupby("Player")["Action"].count(), "Pass_Success_Count")
    safe_update(df_break_succ.groupby("Player")["Action"].count(), "Breakthrough_Success")
    safe_update(df_pass_fail.groupby("Player")["Action"].count(), "Pass_Fail_Count")
    safe_update(df_miss.groupby("Player")["Action"].count(), "Miss_Count")

    df_final_third = df_analyzed[is_in_final_third(df_analyzed["StartX_adj"])]
    if not df_final_third.empty:
        safe_update(
            df_final_third[df_final_third["Action"].isin(["Pass", "Cross"]) & df_final_third["Tags"].str.contains("Success")]
            .groupby("Player")["Action"]
            .count(),
            "FT_Pass_Success",
        )
        safe_update(
            df_final_third[(df_final_third["Action"] == "Breakthrough") & df_final_third["Tags"].str.contains("Success")]
            .groupby("Player")["Action"]
            .count(),
            "FT_Breakthrough_Success",
        )
        safe_update(
            df_final_third[df_final_third["Action"].isin(["Pass", "Cross"]) & ~df_final_third["Tags"].str.contains("Success")]
            .groupby("Player")["Action"]
            .count(),
            "FT_Pass_Fail",
        )
        safe_update(df_final_third[df_final_third["Action"] == "Miss"].groupby("Player")["Action"].count(), "FT_Miss")
        safe_update(df_final_third[df_final_third["Action"] == "Offside"].groupby("Player")["Action"].count(), "FT_Offside")

    df_tackle = df_analyzed[df_analyzed["Action"] == "Tackle"]
    safe_update(df_tackle.groupby("Player")["Action"].count(), "Tackle_Count")
    safe_update(df_tackle.groupby("Player")["Action"].count(), "Total_Tackles")
    safe_update(df_tackle[df_tackle["Tags"].str.contains("Success")].groupby("Player")["Action"].count(), "Successful_Tackles")
    safe_update(
        df_tackle[df_tackle["Tags"].str.contains("Success") & is_in_final_third(df_tackle["StartX_adj"])]
        .groupby("Player")["Action"]
        .count(),
        "Final_Third_Tackle_Success",
    )
    safe_update(
        df_analyzed[(df_analyzed["Action"] == "Duel") & df_analyzed["Tags"].str.contains("Success")]
        .groupby("Player")["Action"]
        .count(),
        "Duel_Win_Count",
    )
    safe_update(df_analyzed[df_analyzed["Action"] == "Intercept"].groupby("Player")["Action"].count(), "Intercept_Count")
    safe_update(df_analyzed[df_analyzed["Action"] == "Acquisition"].groupby("Player")["Action"].count(), "Acquisition_Count")
    safe_update(df_analyzed[df_analyzed["Action"] == "Foul"].groupby("Player")["Action"].count(), "Foul_Count")
    safe_update(
        df_analyzed[(df_analyzed["Action"] == "Duel") & ~df_analyzed["Tags"].str.contains("Success")]
        .groupby("Player")["Action"]
        .count(),
        "Duel_Lose_Count",
    )
    safe_update(
        df_analyzed[(df_analyzed["Action"] == "Foul") & df_analyzed["Tags"].str.contains("In-box")]
        .groupby("Player")["Action"]
        .count(),
        "PA_Foul_Tackles",
    )
    safe_update(df_analyzed[df_analyzed["Action"] == "Clear"].groupby("Player")["Action"].count(), "Clear_Count")
    safe_update(df_analyzed[df_analyzed["Action"] == "Cutout"].groupby("Player")["Action"].count(), "Cutout_Count")
    safe_update(df_analyzed[df_analyzed["Action"] == "Block"].groupby("Player")["Action"].count(), "Block_Count")

    df_aerial = df_analyzed[(df_analyzed["Action"] == "Duel") & df_analyzed["Tags"].str.contains("Aerial")]
    safe_update(df_aerial.groupby("Player")["Action"].count(), "Total_Aerial_Duels")
    safe_update(df_aerial[df_aerial["Tags"].str.contains("Success")].groupby("Player")["Action"].count(), "Aerial_Duels_Won")
    safe_update(
        df_analyzed[(df_analyzed["Action"] == "Duel") & df_analyzed["Tags"].str.contains("Aerial") & ~df_analyzed["Tags"].str.contains("Success")]
        .groupby("Player")["Action"]
        .count(),
        "Aerial_Duels_Lost",
    )

    df_shots = df_analyzed[df_analyzed.apply(_is_shot_row, axis=1)].copy()
    df_shots["Is_SOT"] = df_shots.apply(_is_on_target_shot_row, axis=1) if not df_shots.empty else pd.Series(dtype=bool)
    df_shots["Is_Goal"] = df_shots.apply(_is_goal_row, axis=1) if not df_shots.empty else pd.Series(dtype=bool)
    safe_update(df_shots[df_shots["Tags"].str.contains("Assist")].groupby("Player")["Action"].count(), "Received_Assist")
    safe_update(df_shots[df_shots["Tags"].str.contains("Key Pass")].groupby("Player")["Action"].count(), "Received_Key_Pass")
    safe_update(df_shots[df_shots["Is_SOT"]].groupby("Player")["Action"].count(), "SOT_Count")
    safe_update(df_shots[df_shots["Is_Goal"]].groupby("Player")["Action"].count(), "Goal_Count")
    safe_update(df_analyzed[df_analyzed["Action"] == "Offside"].groupby("Player")["Action"].count(), "Offside_Count")

    df_dribble = df_analyzed[df_analyzed["Action"] == "Dribble"]
    safe_update(df_dribble.groupby("Player")["Action"].count(), "Dribble_Attempt")
    safe_update(
        df_analyzed[(df_analyzed["Action"] == "Cross") & df_analyzed["Tags"].str.contains("Success")]
        .groupby("Player")["Action"]
        .count(),
        "Cross_Success",
    )
    safe_update(df_analyzed[df_analyzed["Action"] == "Be Fouled"].groupby("Player")["Action"].count(), "Be_Fouled")
    safe_update(df_dribble[df_dribble["Distance"] >= 5].groupby("Player")["Distance"].sum(), "Valid_Dribble_Distance")
    safe_update(df_dribble[~df_dribble["Tags"].str.contains("Success")].groupby("Player")["Action"].count(), "Dribble_Fail_Count")

    df_sprint = df_analyzed[df_analyzed["Action"] == "Sprint"]
    safe_update(df_sprint.groupby("Player")["Action"].count(), "Sprint_Count")
    safe_update(df_sprint.groupby("Player")["Distance"].sum(), "Total_Sprint_Distance")

    df_header = df_analyzed[df_analyzed["Tags"].str.contains("Header")].copy()
    if not df_header.empty:
        header_sot_mask = df_header.apply(_is_on_target_shot_row, axis=1).astype(bool)
        safe_update(df_header[header_sot_mask].groupby("Player")["Action"].count(), "Header_SOT")
        safe_update(df_header[df_header["Action"] == "Clear"].groupby("Player")["Action"].count(), "Header_Clear")
    return summary.fillna(0).astype(int)


def sigmoid_score(raw: Any, mid: float, steepness: float) -> Any:
    return 100 / (1 + np.exp(-steepness * (raw - mid)))


def calculate_passing_score(summary: pd.DataFrame, advanced_summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    summary = summary.drop(columns=["Pass_Fail_Count"], errors="ignore")
    summary = summary.join(advanced_summary[["Pass_Fail_Count"]], how="left").fillna(0)
    raw_score = (
        summary["Pass_Success_Rate"] * 0.8
        + summary["Progressive_Pass_Success"] * 1.5
        + summary["Key_Pass"] * 2.5
        + summary["Assist"] * 5
        + summary["PA_Pass_Success"] * 3
        - summary["Pass_Fail_Count"] * 0.5
    )
    summary["Passing_Raw"] = raw_score
    summary["Passing_Score"] = sigmoid_score(summary["Passing_Raw"], 0, 0.08).round(0).astype(int)
    return summary


def calculate_buildup_score(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    if "Own_Half_Pass_Score" not in summary.columns:
        summary["Own_Half_Pass_Score"] = 0
    if "Own_Half_Pass_Fail" not in summary.columns:
        summary["Own_Half_Pass_Fail"] = 0
    summary["BLD_Raw"] = summary["Own_Half_Pass_Score"] - (summary["Own_Half_Pass_Fail"] * 2)
    summary["BLD_Score"] = sigmoid_score(summary["BLD_Raw"], 0, 0.15).round(0).astype(int)
    return summary


def calculate_shooting_score(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    for col in ["Goals", "Total_xG", "Headed_Goals", "Outbox_Goals"]:
        if col not in summary.columns:
            summary[col] = 0
    raw_score = (
        (summary["Goals"] - summary["Total_xG"]) * 10
        + summary["Total_xG"] * 15
        + summary["Headed_Goals"] * 5
        + summary["Outbox_Goals"] * 3
    )
    summary["Shooting_Raw"] = raw_score
    summary["Shooting_Score"] = sigmoid_score(summary["Shooting_Raw"], 0, 0.18).round(0).astype(int)
    return summary


def calculate_save_score(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    for col in ["Total_SOT_xG_Conceded", "Goals_Conceded", "Catch_Count"]:
        if col not in summary.columns:
            summary[col] = 0
    total_xg = summary["Total_SOT_xG_Conceded"]
    goals = summary["Goals_Conceded"]
    raw_score = ((total_xg - goals) * 10) + ((total_xg - goals) * 10) + (summary["Catch_Count"] * 2)
    summary["SAV_Raw"] = raw_score
    summary["SAV_Score"] = sigmoid_score(summary["SAV_Raw"], 0, 0.1).round(0).astype(int)
    return summary


def calculate_cross_score(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    for col in ["Cross_Accuracy", "Successful_Crosses", "Central_PA_Cross_Success"]:
        if col not in summary.columns:
            summary[col] = 0
    base_score = (summary["Cross_Accuracy"] * 0.7) + (np.log1p(summary["Successful_Crosses"]) * 3)
    summary["Raw_Cross_Score"] = base_score + (summary["Central_PA_Cross_Success"] * 2.5)
    summary["Cross_Score"] = sigmoid_score(summary["Raw_Cross_Score"], 0, 0.1).round(0).astype(int)
    return summary


def calculate_dribbling_score(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    failed_dribble = summary["Dribble_Attempt"] - summary["Breakthrough_Success"]
    raw_score = (summary["Breakthrough_Success"] * 3) - (failed_dribble + summary["Miss_Count"]) + (summary["Be_Fouled"] * 0.8)
    summary["Dribbling_Raw"] = raw_score
    summary["Dribbling_Score"] = sigmoid_score(summary["Dribbling_Raw"], 0, 0.2).round(0).astype(int)
    return summary


def calculate_drive_score(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    if "Valid_Dribble_Distance" not in summary.columns:
        summary["Valid_Dribble_Distance"] = 0
    if "Dribble_Fail_Count" not in summary.columns:
        summary["Dribble_Fail_Count"] = 0
    summary["DRV_Raw"] = (summary["Valid_Dribble_Distance"] * 0.15) - (summary["Dribble_Fail_Count"] * 2)
    summary["DRV_Score"] = sigmoid_score(summary["DRV_Raw"], 0, 0.12).round(0).astype(int)
    return summary


def calculate_tackling_score(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    for col in ["Successful_Tackles", "Total_Tackles", "Intercept_Count", "Block_Count", "Clear_Count", "Aerial_Duels_Won", "Total_Aerial_Duels", "Duel_Win_Count"]:
        if col not in summary.columns:
            summary[col] = 0
    failed_tackles = summary["Total_Tackles"] - summary["Successful_Tackles"]
    failed_aerials = summary["Total_Aerial_Duels"] - summary["Aerial_Duels_Won"]
    raw_score = (
        summary["Successful_Tackles"] * 2
        - failed_tackles
        + summary["Intercept_Count"] * 1.5
        + summary["Block_Count"] * 1.2
        + summary["Clear_Count"]
        + summary["Aerial_Duels_Won"] * 1.5
        - failed_aerials * 0.5
        + summary["Duel_Win_Count"] * 0.5
    )
    summary["TAC_Raw"] = raw_score
    summary["TAC_Score"] = sigmoid_score(summary["TAC_Raw"], 0, 0.15).round(0).astype(int)
    return summary


def calculate_header_score(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    for col in ["Headed_Goals", "Header_SOT", "Header_Clear", "Aerial_Duels_Won", "Aerial_Duels_Lost"]:
        if col not in summary.columns:
            summary[col] = 0
    raw_score = (
        summary["Header_SOT"] * 3
        + summary["Headed_Goals"] * 2
        + summary["Aerial_Duels_Won"] * 2
        + summary["Header_Clear"]
        - summary["Aerial_Duels_Lost"] * 1.5
    )
    summary["HED_Raw"] = raw_score
    summary["HED_Score"] = sigmoid_score(summary["HED_Raw"], 0, 0.2).round(0).astype(int)
    return summary


def calculate_pace_score(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    if "Total_Sprint_Distance" not in summary.columns:
        summary["Total_Sprint_Distance"] = 0
    if "Sprint_Count" not in summary.columns:
        summary["Sprint_Count"] = 0
    summary["PAC_Raw"] = (summary["Total_Sprint_Distance"] * 0.1) + summary["Sprint_Count"]
    summary["PAC_Score"] = sigmoid_score(summary["PAC_Raw"], 0, 0.1).round(0).astype(int)
    return summary


def calculate_advanced_scores(summary: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    fst_num = summary["Pass_Success_Count"] + summary["Breakthrough_Success"]
    fst_denom = fst_num + summary["Pass_Fail_Count"] + summary["Miss_Count"]
    summary["FST_Raw"] = (fst_num / fst_denom).fillna(0) * 100
    summary["FST_Score"] = np.where(fst_denom == 0, 50, sigmoid_score(summary["FST_Raw"], 80, 0.15)).astype(int)
    summary["OFF_Raw"] = (
        summary["Received_Assist"] * 3
        + summary["Received_Key_Pass"] * 1.5
        + summary["SOT_Count"]
        + summary["Goal_Count"]
        - summary["Offside_Count"] * 2
    )
    summary["OFF_Score"] = sigmoid_score(summary["OFF_Raw"], 0, 0.25).round(0).astype(int)
    dec_num = summary["FT_Pass_Success"] + summary["FT_Breakthrough_Success"]
    dec_denom = dec_num + summary["FT_Pass_Fail"] + summary["FT_Miss"] + summary["FT_Offside"]
    summary["DEC_Raw"] = (dec_num / dec_denom).fillna(0) * 100
    summary["DEC_Score"] = np.where(dec_denom == 0, 50, sigmoid_score(summary["DEC_Raw"], 80, 0.15)).astype(int)
    return summary


def perform_full_analysis(df: pd.DataFrame) -> pd.DataFrame:
    df = convert_time_to_seconds(df.copy())
    df = auto_tag_key_pass_and_assist(df)
    df = analyze_pass_data(df)
    df = add_xg_to_data(df)
    return add_canonical_columns(df)


def fig_to_base64(fig: Any) -> str:
    img = io.BytesIO()
    fig.savefig(img, format="png", bbox_inches="tight")
    img.seek(0)
    return base64.b64encode(img.getvalue()).decode("utf-8")


def draw_pass_map(df: pd.DataFrame, player_id: str) -> str | None:
    pitch = Pitch(pitch_type="custom", pitch_length=105, pitch_width=68, pitch_color="grass", line_color="white", stripe=True)
    fig, ax = pitch.draw(figsize=(10, 7))
    req_cols = ["StartX_adj", "StartY_adj", "EndX_adj", "EndY_adj"]
    if not all(col in df.columns for col in req_cols):
        plt.close(fig)
        return None

    df["Player"] = df["Player"].astype(str).str.replace(".0", "", regex=False)
    player_id = str(player_id).replace(".0", "")
    plot_df = df[(df["Player"] == player_id) & (df["Action"].str.contains("Pass", case=False, na=False))].dropna(subset=req_cols)
    for _, row in plot_df.iterrows():
        tags = str(row["Tags"]) if pd.notna(row["Tags"]) else ""
        is_success = "Success" in tags
        color = "blue" if is_success else "red"
        linestyle = "-" if is_success else "--"
        pitch.scatter(row["StartX_adj"], row["StartY_adj"], ax=ax, color=color, edgecolors="none", s=60, alpha=0.8, zorder=2)
        pitch.arrows(
            row["StartX_adj"],
            row["StartY_adj"],
            row["EndX_adj"],
            row["EndY_adj"],
            color=color,
            ax=ax,
            width=2,
            headwidth=3,
            headlength=3,
            linestyle=linestyle,
            alpha=0.8,
            zorder=1,
        )
    image = fig_to_base64(fig)
    plt.close(fig)
    return image


def draw_heatmap(df: pd.DataFrame, player_id: str) -> str:
    pitch = Pitch(pitch_type="custom", pitch_length=105, pitch_width=68, pitch_color="grass", line_color="white", stripe=True)
    fig, ax = pitch.draw(figsize=(10, 7))
    df["Player"] = df["Player"].astype(str).str.replace(".0", "", regex=False)
    player_id = str(player_id).replace(".0", "")
    if "StartX_adj" in df.columns and "StartY_adj" in df.columns:
        plot_df = df[df["Player"] == player_id].dropna(subset=["StartX_adj", "StartY_adj"])
        if not plot_df.empty:
            pitch.kdeplot(x=plot_df["StartX_adj"], y=plot_df["StartY_adj"], ax=ax, fill=True, levels=50, thresh=0.3, cmap="hot", alpha=0.7)
        else:
            ax.text(52.5, 34, "No Data", ha="center", va="center", fontsize=20, color="white")
    image = fig_to_base64(fig)
    plt.close(fig)
    return image


def parse_logs_to_dataframe(logs: list[str], match_id: str, teamid_h: str, teamid_a: str) -> pd.DataFrame:
    parsed_logs: list[dict[str, Any]] = []
    for log in logs:
        log_dict: dict[str, Any] = {}
        parts = log.split(" | ")
        log_dict["Half"] = parts[0]
        log_dict["Team"] = parts[1]
        log_dict["Direction"] = parts[2]
        log_dict["Time"] = parts[3]
        pos_match = re.search(r"Pos\((.+?), (.+?)\)", parts[4])
        if pos_match:
            log_dict["StartX"], log_dict["StartY"] = pos_match.groups()
        action_match = re.match(r"(\d+) (.+?)(?: to (\d+))?$", parts[5])
        if action_match:
            log_dict["Player"], log_dict["Action"], log_dict["Receiver"] = action_match.groups()
            log_dict["Receiver"] = log_dict["Receiver"] if log_dict["Receiver"] else ""
        log_dict["EndX"], log_dict["EndY"], log_dict["PathPoints"], log_dict["PathPointCount"], log_dict["PathDistance"], log_dict["Tags"] = "", "", "", "", "", ""
        log_dict["DualState"], log_dict["DualInputTier"], log_dict["DualActorTeam"], log_dict["DualPrimaryRowIndex"] = "", "", "", ""
        log_dict["BeforeStatePoints"], log_dict["AfterStatePoints"] = "", ""
        log_dict["BeforeStatePointCount"], log_dict["AfterStatePointCount"] = "", ""
        log_dict["BeforeAllyPointCount"], log_dict["BeforeOpponentPointCount"] = "", ""
        log_dict["AfterAllyPointCount"], log_dict["AfterOpponentPointCount"] = "", ""
        log_dict["BeforeHomePointCount"], log_dict["BeforeAwayPointCount"] = "", ""
        log_dict["AfterHomePointCount"], log_dict["AfterAwayPointCount"] = "", ""
        log_dict["BeforeGkPointCount"], log_dict["AfterGkPointCount"] = "", ""
        log_dict["BeforeNumberedPointCount"], log_dict["AfterNumberedPointCount"] = "", ""
        log_dict["xG"], log_dict["xGOT"], log_dict["EPV"], log_dict["PC"] = "", "", "", ""
        for part in parts[6:]:
            if part.startswith("Path("):
                path_text = part.removeprefix("Path(").removesuffix(")")
                path_points = _parse_path_points(path_text)
                log_dict["PathPoints"] = _format_path_points(path_points)
                log_dict["PathPointCount"] = len(path_points) if path_points else ""
                log_dict["PathDistance"] = round(_path_distance(path_points), 2) if path_points else ""
            elif part.startswith("Tags: "):
                log_dict["Tags"] = part.replace("Tags: ", "")
            elif part.startswith("DualState: "):
                dual_state_text = part.replace("DualState: ", "", 1)
                dual_state = _decode_dual_pitch_state(dual_state_text)
                log_dict["DualState"] = dual_state_text
                if dual_state:
                    before_points = dual_state.get("before") if isinstance(dual_state.get("before"), list) else []
                    after_points = dual_state.get("after") if isinstance(dual_state.get("after"), list) else []
                    log_dict["DualInputTier"] = str(dual_state.get("input_tier") or "")
                    log_dict["DualActorTeam"] = str(dual_state.get("actor_team") or "")
                    log_dict["DualPrimaryRowIndex"] = dual_state.get("primary_row_index") if dual_state.get("primary_row_index") is not None else ""
                    log_dict["BeforeStatePoints"] = _format_dual_points(before_points)
                    log_dict["AfterStatePoints"] = _format_dual_points(after_points)
                    log_dict["BeforeStatePointCount"] = len(before_points)
                    log_dict["AfterStatePointCount"] = len(after_points)
                    before_ally_count, before_opponent_count = _dual_team_counts(before_points)
                    after_ally_count, after_opponent_count = _dual_team_counts(after_points)
                    before_home_count, before_away_count = _dual_side_counts(before_points)
                    after_home_count, after_away_count = _dual_side_counts(after_points)
                    before_gk_count, before_numbered_count = _dual_role_counts(before_points)
                    after_gk_count, after_numbered_count = _dual_role_counts(after_points)
                    log_dict["BeforeAllyPointCount"] = before_ally_count
                    log_dict["BeforeOpponentPointCount"] = before_opponent_count
                    log_dict["AfterAllyPointCount"] = after_ally_count
                    log_dict["AfterOpponentPointCount"] = after_opponent_count
                    log_dict["BeforeHomePointCount"] = before_home_count
                    log_dict["BeforeAwayPointCount"] = before_away_count
                    log_dict["AfterHomePointCount"] = after_home_count
                    log_dict["AfterAwayPointCount"] = after_away_count
                    log_dict["BeforeGkPointCount"] = before_gk_count
                    log_dict["AfterGkPointCount"] = after_gk_count
                    log_dict["BeforeNumberedPointCount"] = before_numbered_count
                    log_dict["AfterNumberedPointCount"] = after_numbered_count
            elif part.startswith("Metrics: "):
                metrics = _parse_metrics(part)
                log_dict["xG"] = metrics.get("xG", "")
                log_dict["xGOT"] = metrics.get("xGOT", "")
                log_dict["EPV"] = metrics.get("EPV", "")
                log_dict["PC"] = metrics.get("PC", "")
            elif part.startswith("Pos("):
                end_pos_match = re.search(r"Pos\((.+?), (.+?)\)", part)
                if end_pos_match:
                    log_dict["EndX"], log_dict["EndY"] = end_pos_match.groups()
        parsed_logs.append(log_dict)

    for idx, log in enumerate(parsed_logs, start=1):
        log["No"] = idx
        log["MatchID"] = match_id
        team_val = str(log.get("Team", "")).strip().lower()
        log["TeamID"] = teamid_h if team_val == "home" else teamid_a

    columns = [
        "No",
        "MatchID",
        "TeamID",
        "Half",
        "Team",
        "Direction",
        "Time",
        "Player",
        "Receiver",
        "Action",
        "StartX",
        "StartY",
        "EndX",
        "EndY",
        "PathPoints",
        "PathPointCount",
        "PathDistance",
        "Tags",
        "DualState",
        "DualInputTier",
        "DualActorTeam",
        "DualPrimaryRowIndex",
        "BeforeStatePoints",
        "AfterStatePoints",
        "BeforeStatePointCount",
        "AfterStatePointCount",
        "BeforeAllyPointCount",
        "BeforeOpponentPointCount",
        "AfterAllyPointCount",
        "AfterOpponentPointCount",
        "BeforeHomePointCount",
        "BeforeAwayPointCount",
        "AfterHomePointCount",
        "AfterAwayPointCount",
        "BeforeGkPointCount",
        "AfterGkPointCount",
        "BeforeNumberedPointCount",
        "AfterNumberedPointCount",
        "xG",
        "xGOT",
        "EPV",
        "PC",
    ]
    return pd.DataFrame(parsed_logs).reindex(columns=columns)


def generate_log_entry(
    stat_input: str,
    dots: list[dict[str, Any]],
    half: str,
    team: str,
    direction: str,
    timeline: str,
    dual_pitch: dict[str, Any] | None = None,
) -> dict[str, Any]:
    parts = stat_input.lower().split(".", 1)
    base_action_part = parts[0]
    tag_codes = parts[1].split(".") if len(parts) > 1 else []

    if base_action_part.isdigit():
        player_from = base_action_part
        action_code_raw = "touch"
        player_to = ""
    elif base_action_part.isalpha() and base_action_part in ACTION_CODES:
        # 번호 없는 액션 (예: pr=압박). 팀 단위라 행위자 번호가 없음.
        player_from = ""
        action_code_raw = base_action_part
        player_to = ""
    else:
        match = re.match(r"(\d+)([a-z]+)(\d*)", base_action_part)
        if not match:
            raise ValueError("기본 입력 형식 오류")
        player_from, action_code_raw, player_to = match.groups()

    player_to = player_to if player_to else ""
    base_action_code = action_code_raw[0]
    action_name = ACTION_CODES.get(action_code_raw) or ACTION_CODES.get(base_action_code)
    if not action_name:
        raise ValueError("알 수 없는 액션 코드")

    if (
        base_action_code in ["s", "c", "z"]
        or action_name == "Throw-in"
    ) and action_code_raw != "sv" and not player_to:
        raise ValueError(f"'{action_name}' 액션은 받는 선수 번호가 필요합니다. (예: 10{action_code_raw}8)")

    tags_list = [TAG_CODES[tag_code] for tag_code in tag_codes if tag_code in TAG_CODES]
    if action_code_raw == "z":
        tags_list.extend(["Key Pass", "Success"])
    elif action_code_raw == "zz":
        tags_list.extend(["Assist", "Success"])
    elif action_name == "Throw-in":
        if action_code_raw in ["tt", "tr"]:
            tags_list.extend(["Retained", "Success", "Possession Retained"])
        else:
            tags_list.extend(["Lost", "Fail", "Possession Lost"])
    elif action_code_raw == "ddd":
        tags_list.extend(["Goal", "On Target", "Success"])
    elif action_code_raw == "dd":
        tags_list.extend(["On Target", "Success"])
    elif action_code_raw == "db":
        tags_list.extend(["Blocked", "Fail"])
    elif action_code_raw == "d":
        tags_list.extend(["Off Target", "Fail"])
    elif action_code_raw in ["gp", "w", "qw", "v", "vv", "sv", "q", "pr"]:
        tags_list.append("Success")
    elif action_code_raw == "pn":
        tags_list.extend(["Off-ball Run", "Success"])
    elif action_code_raw not in ["touch", "t", "m", "q", "p", "l", "bl", "o", "st", "pn"]:
        if len(action_code_raw) > 1 and action_code_raw[0] == action_code_raw[1]:
            tags_list.append("Success")
        else:
            tags_list.append("Fail")

    is_dribble = action_name == "Dribble"
    path_points: list[tuple[float, float]] = []
    path_distance = 0.0
    end_x: float | None = None
    end_y: float | None = None
    end_x_adj: float | None = None
    if is_dribble:
        if len(dots) < 2:
            raise ValueError("드리블은 좌표 2개 이상이 필요합니다.")
        path_points = [(float(dot["meter_x"]), float(dot["meter_y"])) for dot in dots]
        start_x, start_y = path_points[0]
        end_x, end_y = path_points[-1]
        start_x_adj = FIELD_W - start_x if direction == "left" else start_x
        end_x_adj = FIELD_W - end_x if direction == "left" else end_x
        path_distance = _path_distance(path_points)
        action_str = f"{player_from} {action_name}"
        log_text = (
            f"{half} | {team} | {direction} | {timeline} | Pos({start_x}, {start_y}) | {action_str} | "
            f"Pos({end_x}, {end_y}) | Path({_format_path_points(path_points)})"
        )
    else:
        requires_two_dots = (base_action_code in TWO_DOT_ACTION_CODES or action_code_raw in TWO_DOT_ACTION_CODES or player_to) and action_code_raw != "sv"
        # 수비 액션: 상대 볼/슛 경로 화살표(start,end) 2점이 오면 two-dot로 처리 (EPV-prevented 또는 xG-prevented).
        if not requires_two_dots and action_code_raw in (DEFENSE_ARROW_CODES | SHOT_BLOCK_CODES) and len(dots) >= 2:
            requires_two_dots = True
    if not is_dribble and requires_two_dots:
        if len(dots) < 2:
            raise ValueError("좌표 2개가 필요합니다.")
        start_pos, end_pos = dots[-2], dots[-1]
        start_x, start_y = float(start_pos["meter_x"]), float(start_pos["meter_y"])
        end_x, end_y = float(end_pos["meter_x"]), float(end_pos["meter_y"])
        start_x_adj = FIELD_W - start_x if direction == "left" else start_x
        end_x_adj = FIELD_W - end_x if direction == "left" else end_x
        # Progressive는 전진 '전달' 액션(패스/크로스/드리블 등)에만 — 수비(상대 공/슛 경로)엔 부적절하므로 제외
        if action_name != "Throw-in" and action_code_raw not in (DEFENSE_ARROW_CODES | SHOT_BLOCK_CODES) and is_progressive_pass(start_x_adj, end_x_adj) and "Progressive" not in tags_list:
            tags_list.append("Progressive")
        if action_name == "Throw-in":
            throw_distance = float(np.sqrt((end_x - start_x) ** 2 + (end_y - start_y) ** 2))
            if throw_distance >= 20 and "Long Throw" not in tags_list:
                tags_list.append("Long Throw")
            if is_in_penalty_area(end_x_adj, end_y) and "Box Entry" not in tags_list:
                tags_list.append("Box Entry")
        action_str = f"{player_from} {action_name}"
        if player_to:
            action_str += f" to {player_to}"
        log_text = f"{half} | {team} | {direction} | {timeline} | Pos({start_x}, {start_y}) | {action_str} | Pos({end_x}, {end_y})"
    elif not is_dribble:
        if len(dots) < 1:
            raise ValueError("좌표 1개가 필요합니다.")
        start_pos = dots[-1]
        start_x, start_y = float(start_pos["meter_x"]), float(start_pos["meter_y"])
        start_x_adj = FIELD_W - start_x if direction == "left" else start_x
        log_text = f"{half} | {team} | {direction} | {timeline} | Pos({start_x}, {start_y}) | {player_from} {action_name}"

    in_penalty_box = is_in_penalty_area(start_x_adj, start_y) or is_in_either_penalty_area(start_x, start_y)
    if in_penalty_box and "In-box" not in tags_list:
        tags_list.append("In-box")
    elif action_name in ["Goal", "Shot On Target", "Shot", "Blocked Shot"] and "Out-box" not in tags_list:
        tags_list.append("Out-box")

    # 획득(possession-win) t/f 폐기 (2026-07-08) — 수비는 before(행위 전)→after(행위 시점) 위치변화의
    # EPV·PC delta로 채점한다. after 프레임 유무로 소유권을 판정하던 옛 로직 제거.
    deduped_tags = list(dict.fromkeys(tags_list))
    if deduped_tags:
        log_text += f" | Tags: {', '.join(deduped_tags)}"

    metrics: dict[str, Any] = {}
    if action_name == "Shot":
        try:
            xg_meta = shared_estimate_xg(
                "HOME",
                "L2R",
                float(start_x_adj),
                float(start_y),
                "Header" in deduped_tags,
                "Weak Foot" in deduped_tags,
            )
            metrics["xG"] = float(xg_meta["xg"])
        except (KeyError, TypeError, ValueError):
            metrics["xG"] = ""

    compact_dual_state = _compact_dual_pitch_state(dual_pitch)
    metric_end_x = end_x if end_x is not None else start_x
    metric_end_y = end_y if end_y is not None else start_y
    metric_end_x_adj = end_x_adj if end_x_adj is not None else start_x_adj
    if action_code_raw in SHOT_BLOCK_CODES:
        # 슛블락: 막은 슛의 xG를 블로커에게 승계. 화살표 start=슈터(상대) 위치를 상대 공격방향으로 뒤집어
        # estimate_xg 계산. EPV/PC는 슛블락에 무의미하므로 생략, xG 컬럼만 채움.
        try:
            block_xg = shared_estimate_xg(
                "HOME", "L2R", float(FIELD_W - start_x_adj), float(start_y),
                "Header" in deduped_tags, "Weak Foot" in deduped_tags,
            )
            metrics["xG"] = round(float(block_xg["xg"]) * BLOCK_CREDIT, 4)
        except (KeyError, TypeError, ValueError):
            pass
    else:
        if action_code_raw in DEFENSE_ARROW_CODES:
            # 수비: 화살표(start=상대 볼 출발, end=끊은 지점)는 '상대 공' 경로. 상대 공격방향(좌표 뒤집기)으로
            # EPV를 재서, 상대가 만들려던 전진위협 EPV(end)−EPV(start)를 그대로 승계(=prevented threat). EPV-방어만.
            epv_value = _epv_delta(FIELD_W - start_x_adj, start_y, FIELD_W - metric_end_x_adj, metric_end_y)
        else:
            epv_value = _epv_delta(start_x_adj, start_y, metric_end_x_adj, metric_end_y)
        if epv_value is not None:
            metrics["EPV"] = epv_value
        pc_value = _pitch_control_delta(compact_dual_state, (start_x, start_y), (metric_end_x, metric_end_y))
        if pc_value is not None:
            metrics["PC"] = pc_value

    metrics_text = _format_metrics(metrics)
    if metrics_text:
        parts = log_text.split(" | ")
        metric_index = next((index for index, part in enumerate(parts) if part.startswith("Metrics: ")), -1)
        if metric_index >= 0:
            parts[metric_index] = f"Metrics: {metrics_text}"
            log_text = " | ".join(parts)
        else:
            log_text += f" | Metrics: {metrics_text}"

    dual_state_text = json.dumps(compact_dual_state, ensure_ascii=False, separators=(",", ":")) if compact_dual_state else ""
    if dual_state_text:
        log_text += f" | DualState: {dual_state_text}"

    return {
        "log_text": log_text,
        "log_data": {
            "Time": timeline,
            "Team": team,
            "Player": player_from,
            "Action": action_name,
            "Receiver": player_to,
            "Coord": f"Pos({start_x}, {start_y})",
            "Tags": ", ".join(deduped_tags) if deduped_tags else "",
            "PathPoints": _format_path_points(path_points) if path_points else "",
            "PathPointCount": str(len(path_points)) if path_points else "",
            "PathDistance": str(round(path_distance, 2)) if path_points else "",
            "DualState": dual_state_text,
            "xG": _metric_text_value(metrics.get("xG")),
            "xGOT": "",
            "EPV": _metric_text_value(metrics.get("EPV")),
            "PC": _metric_text_value(metrics.get("PC")),
        },
    }


def build_final_stats(df_analyzed_with_xg: pd.DataFrame) -> pd.DataFrame:
    pass_summary = create_player_summary(df_analyzed_with_xg)
    shooter_summary = create_shooter_summary(df_analyzed_with_xg)
    cross_summary = create_cross_summary(df_analyzed_with_xg)
    advanced_summary = create_advanced_summary(df_analyzed_with_xg)
    final_stats_df = pd.DataFrame(index=df_analyzed_with_xg["Player"].unique())
    all_stats = final_stats_df.join([pass_summary, shooter_summary, cross_summary, advanced_summary], how="outer").fillna(0)
    all_stats = calculate_passing_score(all_stats, all_stats)
    all_stats = calculate_buildup_score(all_stats)
    all_stats = calculate_shooting_score(all_stats)
    all_stats = calculate_save_score(all_stats)
    all_stats = calculate_cross_score(all_stats)
    all_stats = calculate_dribbling_score(all_stats)
    all_stats = calculate_drive_score(all_stats)
    all_stats = calculate_tackling_score(all_stats)
    all_stats = calculate_header_score(all_stats)
    all_stats = calculate_pace_score(all_stats)
    all_stats = calculate_advanced_scores(all_stats)
    score_cols = [col for col in all_stats.columns if "_Score" in col]
    result = all_stats[score_cols].copy().fillna(0).astype(int)
    result.index.name = "Player"
    return result


def build_canonical_events_sheet(analyzed: pd.DataFrame) -> pd.DataFrame:
    columns = [
        "No",
        "MatchID",
        "TeamID",
        "Half",
        "Team",
        "Direction",
        "Time",
        "Player",
        "Receiver",
        "Action",
        "EventType",
        "EventSubtype",
        "Result",
        "Tags",
        "BodyPart",
        "FootUsage",
        "Phase",
        "DualInputTier",
        "DualActorTeam",
        "DualPrimaryRowIndex",
        "BeforeStatePoints",
        "AfterStatePoints",
        "BeforeStatePointCount",
        "AfterStatePointCount",
        "BeforeAllyPointCount",
        "BeforeOpponentPointCount",
        "AfterAllyPointCount",
        "AfterOpponentPointCount",
        "BeforeHomePointCount",
        "BeforeAwayPointCount",
        "AfterHomePointCount",
        "AfterAwayPointCount",
        "BeforeGkPointCount",
        "AfterGkPointCount",
        "BeforeNumberedPointCount",
        "AfterNumberedPointCount",
        "StartX_adj",
        "StartY_adj",
        "EndX_adj",
        "EndY_adj",
        "xG",
        "xGOT",
        "EPV",
        "PC",
    ]
    return analyzed.reindex(columns=[col for col in columns if col in analyzed.columns])


def build_dual_pitch_states_sheet(analyzed: pd.DataFrame) -> pd.DataFrame:
    columns = [
        "No",
        "MatchID",
        "TeamID",
        "Half",
        "Team",
        "Direction",
        "Time",
        "Player",
        "Receiver",
        "EventType",
        "EventSubtype",
        "Result",
        "DualInputTier",
        "DualActorTeam",
        "DualPrimaryRowIndex",
        "BeforeStatePointCount",
        "BeforeAllyPointCount",
        "BeforeOpponentPointCount",
        "BeforeHomePointCount",
        "BeforeAwayPointCount",
        "BeforeGkPointCount",
        "BeforeNumberedPointCount",
        "BeforeStatePoints",
        "AfterStatePointCount",
        "AfterAllyPointCount",
        "AfterOpponentPointCount",
        "AfterHomePointCount",
        "AfterAwayPointCount",
        "AfterGkPointCount",
        "AfterNumberedPointCount",
        "AfterStatePoints",
        "DualState",
    ]
    sheet = analyzed.reindex(columns=[col for col in columns if col in analyzed.columns]).copy()
    if "DualState" in sheet.columns:
        sheet = sheet[sheet["DualState"].fillna("").astype(str).str.len() > 0]
    return sheet


def build_action_definitions_sheet() -> pd.DataFrame:
    rows = [
        {"ActionKey": "Pass/*/Direct/Possession", "Event": "Pass", "Condition": "OWN/OPP", "Level": "Direct", "Outcome": "Possession", "RequiredEvidence": "Success or retained possession"},
        {"ActionKey": "Pass/*/Direct/Progression", "Event": "Pass", "Condition": "OWN/OPP", "Level": "Direct", "Outcome": "Progression", "RequiredEvidence": "end_x - start_x >= 10m or EPV delta > 0"},
        {"ActionKey": "Cross/OPP/Indirect/Goal", "Event": "Cross", "Condition": "OPP", "Level": "Indirect", "Outcome": "Goal", "RequiredEvidence": "linked shot/goal within sequence window"},
        {"ActionKey": "Shot/OPP/Direct/Goal", "Event": "Shot", "Condition": "OPP", "Level": "Direct", "Outcome": "Goal", "RequiredEvidence": "shot location and xG"},
        {"ActionKey": "Dribble/*/Direct/Possession", "Event": "Dribble/Carry", "Condition": "OWN/OPP", "Level": "Direct", "Outcome": "Possession", "RequiredEvidence": "after possession retained"},
        {"ActionKey": "Dribble/*/Direct/Progression", "Event": "Dribble/Carry", "Condition": "OWN/OPP", "Level": "Direct", "Outcome": "Progression", "RequiredEvidence": "carry delta or EPV delta > 0"},
        {"ActionKey": "Penetration/OPP/Direct/Progression", "Event": "Penetration", "Condition": "OPP", "Level": "Direct", "Outcome": "Progression", "RequiredEvidence": "off-ball run/reception point increases EPV or creates box/line-breaking receive state"},
        {"ActionKey": "Penetration/OPP/Indirect/Progression", "Event": "Penetration", "Condition": "OPP", "Level": "Indirect", "Outcome": "Progression", "RequiredEvidence": "run/space occupation linked to teammate progression within the sequence window"},
        {"ActionKey": "ThrowIn/*/Direct/Possession", "Event": "ThrowIn", "Condition": "OWN/OPP", "Level": "Direct", "Outcome": "Possession", "RequiredEvidence": "Retained / First Contact Won"},
        {"ActionKey": "ThrowIn/*/Direct/TerritoryGain", "Event": "ThrowIn", "Condition": "OWN/OPP", "Level": "Direct", "Outcome": "TerritoryGain", "RequiredEvidence": "Long Throw + territory gain"},
        {"ActionKey": "ThrowIn/OPP/Indirect/Goal", "Event": "ThrowIn", "Condition": "OPP", "Level": "Indirect", "Outcome": "Goal", "RequiredEvidence": "Box Entry or linked shot/second ball"},
        {"ActionKey": "Defense/*/Direct/Possession", "Event": "Defense", "Condition": "OWN/OPP", "Level": "Direct", "Outcome": "Possession", "RequiredEvidence": "recovery or possession gain"},
    ]
    return pd.DataFrame(rows)


def build_model_config_sheet() -> pd.DataFrame:
    rows = [
        ("model_pack_id", "xfp_model_pack_v0.2-draft"),
        ("source_schema_version", "fpa_canonical_event.v0.2-draft"),
        ("action_definition_version", "fpa_xfp_action_rules_v0.2-draft"),
        ("quick_dsl_version", "fpa_quick_dsl_v0.2-draft"),
        ("xg_model_version", "fp_xg_shared_estimator"),
        ("epv_model_version", "fp_epv_state_value_proxy_v0.2"),
        ("pitch_control_model_version", "equal_speed_freeze_frame_pc_v0.2"),
        ("shot_formula", "1 / (1 + EXP(-(b0 + b1*distance + b2*angle + b3*header + b4*pressure)))"),
        ("epv_formula", "EPV_Delta = After_EPV - Before_EPV"),
        ("pitch_control_formula", "PC(z)=2*P_home(z)-1; P_home=sum(exp(-T_home/tau))/sum(exp(-T_all/tau)); T=reaction_time+distance/shared_player_speed"),
        ("pitch_control_scale", "1=home 100%, 0=balanced, -1=away 100%"),
        ("pitch_control_default_parameters", "reaction_time=0.7s, shared_player_speed=5.5m/s, tau=1.15"),
        ("action_score_formula", "BaseWeight * LevelMultiplier * OutcomeMultiplier * ReliabilityFactor"),
    ]
    return pd.DataFrame(rows, columns=["Field", "Value"])


def build_xg_calculation_sheet(analyzed: pd.DataFrame) -> pd.DataFrame:
    shot_rows = analyzed[analyzed.apply(_is_shot_row, axis=1)].copy()
    if shot_rows.empty:
        return pd.DataFrame(columns=["No", "Player", "Result", "StartX_adj", "StartY_adj", "BodyPart", "FootUsage", "xG", "xGOT", "Formula"])
    shot_rows["Formula"] = "fp_xG(shared_estimate_xg): location + header + weak_foot"
    return shot_rows.reindex(columns=["No", "Player", "Result", "StartX_adj", "StartY_adj", "BodyPart", "FootUsage", "xG", "xGOT", "Formula"])


def build_epv_calculation_sheet(analyzed: pd.DataFrame) -> pd.DataFrame:
    sheet = analyzed.reindex(
        columns=[
            "No",
            "Player",
            "EventType",
            "Result",
            "StartX",
            "StartY",
            "EndX",
            "EndY",
            "StartX_adj",
            "StartY_adj",
            "EndX_adj",
            "EndY_adj",
            "EPV",
            "DualInputTier",
            "BeforeStatePoints",
            "AfterStatePoints",
            "BeforeAllyPointCount",
            "BeforeOpponentPointCount",
            "AfterAllyPointCount",
            "AfterOpponentPointCount",
        ]
    ).copy()
    before_values: list[str] = []
    after_values: list[str] = []
    delta_values: list[str] = []
    for _, row in sheet.iterrows():
        start_x = _finite_float(row.get("StartX_adj"))
        start_y = _finite_float(row.get("StartY_adj"))
        end_x = _finite_float(row.get("EndX_adj"))
        end_y = _finite_float(row.get("EndY_adj"))
        if end_x is None:
            end_x = start_x
        if end_y is None:
            end_y = start_y
        before_epv = _epv_state_value(start_x, start_y)
        after_epv = _epv_state_value(end_x, end_y)
        delta_epv = round(after_epv - before_epv, 4) if before_epv is not None and after_epv is not None else None
        before_values.append(_metric_text_value(before_epv))
        after_values.append(_metric_text_value(after_epv))
        delta_values.append(_metric_text_value(delta_epv))
    sheet["Before_EPV"] = before_values
    sheet["After_EPV"] = after_values
    sheet["EPV_Delta"] = delta_values
    sheet["Formula"] = "EPV_Delta = After_EPV - Before_EPV"
    return sheet


def build_pitch_control_calculation_sheet(analyzed: pd.DataFrame) -> pd.DataFrame:
    sheet = analyzed.reindex(
        columns=[
            "No",
            "Player",
            "EventType",
            "Result",
            "StartX",
            "StartY",
            "EndX",
            "EndY",
            "StartX_adj",
            "StartY_adj",
            "EndX_adj",
            "EndY_adj",
            "PC",
            "DualInputTier",
            "DualState",
            "BeforeStatePoints",
            "AfterStatePoints",
            "BeforeAllyPointCount",
            "BeforeOpponentPointCount",
            "AfterAllyPointCount",
            "AfterOpponentPointCount",
        ]
    ).copy()
    before_values: list[str] = []
    after_values: list[str] = []
    delta_values: list[str] = []
    for _, row in sheet.iterrows():
        state = _decode_dual_pitch_state(row.get("DualState"))
        start_x = _finite_float(row.get("StartX"))
        start_y = _finite_float(row.get("StartY"))
        end_x = _finite_float(row.get("EndX"))
        end_y = _finite_float(row.get("EndY"))
        if start_x is None or start_y is None:
            before_values.append("")
            after_values.append("")
            delta_values.append("")
            continue
        if end_x is None:
            end_x = start_x
        if end_y is None:
            end_y = start_y
        actor_team = str(state.get("actor_team") or "").lower() if state else ""
        before_home, before_away = _dual_points_by_side(state.get("before") if state else None, actor_team)
        after_home, after_away = _dual_points_by_side(state.get("after") if state else None, actor_team)
        if not after_home and not after_away:
            after_home, after_away = before_home, before_away
        before_pc = _pitch_control_at(start_x, start_y, before_home, before_away)
        after_pc = _pitch_control_at(end_x, end_y, after_home, after_away)
        delta_pc = round(after_pc - before_pc, 4) if before_pc is not None and after_pc is not None else None
        before_values.append(_metric_text_value(before_pc))
        after_values.append(_metric_text_value(after_pc))
        delta_values.append(_metric_text_value(delta_pc))
    sheet["Before_PC"] = before_values
    sheet["After_PC"] = after_values
    sheet["PC_Delta"] = delta_values
    has_dual_state = sheet.get("BeforeStatePoints", "").fillna("").astype(str).str.len() > 0
    dual_tier = sheet.get("DualInputTier", "").fillna("").astype(str).replace("", "minimal")
    sheet["InputTier"] = np.where(has_dual_state, "dual_pitch_" + dual_tier, "single_pitch")
    sheet["Formula"] = "PC(z)=2*P_home(z)-1 from equal-speed home/away player coordinates; PC_Delta = After_PC - Before_PC"
    return sheet


def _scene_cell_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and pd.isna(value):
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def _parse_scene_state(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _scene_points(state: dict[str, Any], key: str) -> list[dict[str, Any]]:
    candidates = state.get(key)
    if key == "beforeDots" and not isinstance(candidates, list):
        candidates = state.get("before")
    if key == "afterDots" and not isinstance(candidates, list):
        candidates = state.get("after")
    return [item for item in candidates if isinstance(item, dict)] if isinstance(candidates, list) else []


def _scene_pass_arrows(state: dict[str, Any]) -> list[dict[str, Any]]:
    arrows = state.get("passArrows")
    return [item for item in arrows if isinstance(item, dict)] if isinstance(arrows, list) else []


def _merge_scene_columns(df: pd.DataFrame, scene_rows: list[dict[str, Any]] | None) -> pd.DataFrame:
    if not scene_rows:
        return df
    merged = df.copy()
    row_count = len(merged.index)
    for column in ["SceneIndex", "SceneActionIndex", "SceneState"]:
        values = [""] * row_count
        for index, row in enumerate(scene_rows[:row_count]):
            if isinstance(row, dict):
                values[index] = _scene_cell_value(row.get(column, ""))
        if any(values):
            merged[column] = values
    return merged


def build_scene_actions_sheet(scene_rows: list[dict[str, Any]] | None) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for index, row in enumerate(scene_rows or [], start=1):
        if not isinstance(row, dict):
            continue
        state = _parse_scene_state(row.get("SceneState"))
        before_dots = _scene_points(state, "beforeDots") if state else []
        after_dots = _scene_points(state, "afterDots") if state else []
        pass_arrows = _scene_pass_arrows(state) if state else []
        rows.append(
            {
                "RowNo": index,
                "SceneIndex": _scene_cell_value(row.get("SceneIndex")),
                "SceneActionIndex": _scene_cell_value(row.get("SceneActionIndex")),
                "Time": _scene_cell_value(row.get("Time")),
                "Team": _scene_cell_value(row.get("Team")),
                "Player": _scene_cell_value(row.get("Player")),
                "Action": _scene_cell_value(row.get("Action")),
                "Receiver": _scene_cell_value(row.get("Receiver")),
                "Tags": _scene_cell_value(row.get("Tags")),
                "BeforeDotCount": len(before_dots),
                "AfterDotCount": len(after_dots),
                "PassArrowCount": len(pass_arrows),
                "PrimaryActionIndex": _scene_cell_value(state.get("primary") if state else ""),
                "SceneState": _scene_cell_value(row.get("SceneState")),
            }
        )
    return pd.DataFrame(
        rows,
        columns=[
            "RowNo",
            "SceneIndex",
            "SceneActionIndex",
            "Time",
            "Team",
            "Player",
            "Action",
            "Receiver",
            "Tags",
            "BeforeDotCount",
            "AfterDotCount",
            "PassArrowCount",
            "PrimaryActionIndex",
            "SceneState",
        ],
    )


def _unique_scene_states(scene_rows: list[dict[str, Any]] | None) -> list[tuple[str, dict[str, Any]]]:
    scenes: list[tuple[str, dict[str, Any]]] = []
    seen: set[str] = set()
    for index, row in enumerate(scene_rows or [], start=1):
        if not isinstance(row, dict):
            continue
        state = _parse_scene_state(row.get("SceneState"))
        if not state:
            continue
        scene_index = _scene_cell_value(row.get("SceneIndex")) or str(index)
        if scene_index in seen:
            continue
        seen.add(scene_index)
        scenes.append((scene_index, state))
    return scenes


def build_scene_dots_sheet(scene_rows: list[dict[str, Any]] | None) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for scene_index, state in _unique_scene_states(scene_rows):
        for side, dots in [("before", _scene_points(state, "beforeDots")), ("after", _scene_points(state, "afterDots"))]:
            for dot_index, dot in enumerate(dots, start=1):
                rows.append(
                    {
                        "SceneIndex": scene_index,
                        "Side": side,
                        "DotIndex": dot_index,
                        "DotId": _scene_cell_value(dot.get("id")),
                        "Team": _scene_cell_value(dot.get("team")),
                        "TeamSide": _scene_cell_value(dot.get("teamSide") or dot.get("team_side")),
                        "Role": _scene_cell_value(dot.get("role")),
                        "Number": _scene_cell_value(dot.get("number")),
                        "Layer": _scene_cell_value(dot.get("layer")),
                        "MeterX": dot.get("meter_x", dot.get("x", "")),
                        "MeterY": dot.get("meter_y", dot.get("y", "")),
                        "ScreenX": dot.get("screen_x", ""),
                        "ScreenY": dot.get("screen_y", ""),
                        "Color": _scene_cell_value(dot.get("color")),
                    }
                )
    return pd.DataFrame(
        rows,
        columns=["SceneIndex", "Side", "DotIndex", "DotId", "Team", "TeamSide", "Role", "Number", "Layer", "MeterX", "MeterY", "ScreenX", "ScreenY", "Color"],
    )


def build_scene_passes_sheet(scene_rows: list[dict[str, Any]] | None) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for scene_index, state in _unique_scene_states(scene_rows):
        for arrow_index, arrow in enumerate(_scene_pass_arrows(state), start=1):
            rows.append(
                {
                    "SceneIndex": scene_index,
                    "ArrowIndex": arrow_index,
                    "Side": _scene_cell_value(arrow.get("side")),
                    "StartId": _scene_cell_value(arrow.get("startId") or arrow.get("start_id")),
                    "X1": arrow.get("x1", ""),
                    "Y1": arrow.get("y1", ""),
                    "X2": arrow.get("x2", ""),
                    "Y2": arrow.get("y2", ""),
                }
            )
    return pd.DataFrame(rows, columns=["SceneIndex", "ArrowIndex", "Side", "StartId", "X1", "Y1", "X2", "Y2"])


def build_analysis_workbook(df_or_bytes: pd.DataFrame | bytes, scene_rows: list[dict[str, Any]] | None = None) -> bytes:
    df = load_excel_dataframe(df_or_bytes, "Data") if isinstance(df_or_bytes, bytes) else _dedupe_dataframe_columns(df_or_bytes.copy())
    df = _merge_scene_columns(df, scene_rows)
    analyzed = perform_full_analysis(df)
    pass_summary = create_player_summary(analyzed)
    shooter_summary = create_shooter_summary(analyzed)
    cross_summary = create_cross_summary(analyzed)
    advanced_summary = create_advanced_summary(analyzed)
    final_stats_df = build_final_stats(analyzed)

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        analyzed.to_excel(writer, sheet_name="Data", index=False)
        create_tableau_pass_data(analyzed).to_excel(writer, sheet_name="Tableau_Pass", index=False)
        pass_summary.to_excel(writer, sheet_name="Pass_Summary")
        shooter_summary.to_excel(writer, sheet_name="Shooting_Summary")
        cross_summary.to_excel(writer, sheet_name="Cross_Summary")
        advanced_summary.to_excel(writer, sheet_name="Advanced_Summary")
        if not final_stats_df.empty:
            final_stats_df.to_excel(writer, sheet_name="Final_Stats")
        build_canonical_events_sheet(analyzed).to_excel(writer, sheet_name="Canonical_Events", index=False)
        build_dual_pitch_states_sheet(analyzed).to_excel(writer, sheet_name="Dual_Pitch_States", index=False)
        build_action_definitions_sheet().to_excel(writer, sheet_name="Action_Definitions", index=False)
        build_model_config_sheet().to_excel(writer, sheet_name="Model_Config", index=False)
        build_xg_calculation_sheet(analyzed).to_excel(writer, sheet_name="xG_Calculation", index=False)
        build_epv_calculation_sheet(analyzed).to_excel(writer, sheet_name="EPV_Calculation", index=False)
        build_pitch_control_calculation_sheet(analyzed).to_excel(writer, sheet_name="PitchControl_Calc", index=False)
        if scene_rows:
            build_scene_actions_sheet(scene_rows).to_excel(writer, sheet_name="Scene_Actions", index=False)
            build_scene_dots_sheet(scene_rows).to_excel(writer, sheet_name="Scene_Dots", index=False)
            build_scene_passes_sheet(scene_rows).to_excel(writer, sheet_name="Scene_Passes", index=False)
    output.seek(0)
    return output.getvalue()


def _clean_player_label(value: Any) -> str:
    return _clean_scalar_text(value)


def _format_count(value: Any) -> str:
    count = int(round(float(value or 0)))
    return f"{count}회"


def _format_percent(value: Any) -> str:
    return f"{float(value or 0):.1f}%"


def _format_decimal(value: Any) -> str:
    return f"{float(value or 0):.3f}"


def _safe_series_value(series: pd.Series | None, key: str) -> float:
    if series is None or key not in series.index:
        return 0.0
    value = _scalar_value(series.get(key, 0))
    if pd.isna(value):
        return 0.0
    return float(value)


def analyze_card_workbook(file_bytes: bytes) -> dict[str, Any]:
    df = load_excel_dataframe(file_bytes, "Data")
    required_cols = ["Player", "Action", "Team", "StartX", "StartY"]
    missing = [col for col in required_cols if col not in df.columns]
    if missing:
        raise ValueError(f"Data 시트에 필요한 컬럼이 없습니다: {', '.join(missing)}")

    # Support both raw FPA exports and already-analyzed workbooks.
    already_analyzed = all(col in df.columns for col in ["StartX_adj", "StartY_adj", "EndX_adj", "EndY_adj", "xG"])
    analyzed = df.copy() if already_analyzed else perform_full_analysis(df)
    pass_summary = create_player_summary(analyzed)
    shooter_summary = create_shooter_summary(analyzed)
    cross_summary = create_cross_summary(analyzed)
    advanced_summary = create_advanced_summary(analyzed)

    touch_counts = analyzed.groupby("Player")["Action"].count()
    player_teams = analyzed.groupby("Player")["Team"].agg(lambda values: _clean_player_label(values.dropna().iloc[0]) if len(values.dropna()) else "")

    players_payload: list[dict[str, Any]] = []

    stat_priority = [
        "Goal",
        "Assist",
        "슈팅(유효슈팅)",
        "기대득점(xG)",
        "크로스 성공률(%)",
        "헤더",
        "드리블",
        "돌파",
        "패스 성공률(%)",
        "전진 패스",
        "Key Pass",
        "인터셉트",
        "태클",
        "클리어",
        "차단",
        "경합 성공률(%)",
        "볼 터치",
    ]

    for raw_player in analyzed["Player"].dropna().unique():
        player = _clean_player_label(raw_player)
        shooter_row = shooter_summary.loc[raw_player] if raw_player in shooter_summary.index else None
        pass_row = pass_summary.loc[raw_player] if raw_player in pass_summary.index else None
        cross_row = cross_summary.loc[raw_player] if raw_player in cross_summary.index else None
        advanced_row = advanced_summary.loc[raw_player] if raw_player in advanced_summary.index else None

        goals = _safe_series_value(shooter_row, "Goals")
        assists = _safe_series_value(pass_row, "Assist")
        total_xg = _safe_series_value(shooter_row, "Total_xG")
        total_shots = _safe_series_value(shooter_row, "Total_Shots")
        shots_on_target = _safe_series_value(shooter_row, "Shots_On_Target")
        key_pass = _safe_series_value(pass_row, "Key_Pass")
        pass_success_rate = _safe_series_value(pass_row, "Pass_Success_Rate")
        success_pass = _safe_series_value(pass_row, "Success_Pass")
        progressive_pass = _safe_series_value(pass_row, "Progressive_Pass_Success")
        crosses = _safe_series_value(cross_row, "Total_Crosses")
        cross_accuracy = _safe_series_value(cross_row, "Cross_Accuracy")
        successful_crosses = _safe_series_value(cross_row, "Successful_Crosses")
        dribble = _safe_series_value(advanced_row, "Dribble_Attempt")
        breakthrough = _safe_series_value(advanced_row, "Breakthrough_Success")
        intercept = _safe_series_value(advanced_row, "Intercept_Count")
        tackle = _safe_series_value(advanced_row, "Successful_Tackles")
        clear = _safe_series_value(advanced_row, "Clear_Count")
        block = _safe_series_value(advanced_row, "Block_Count")
        touches = float(touch_counts.get(raw_player, 0))
        duel_win = _safe_series_value(advanced_row, "Duel_Win_Count")
        duel_lose = _safe_series_value(advanced_row, "Duel_Lose_Count")
        aerial_win = _safe_series_value(advanced_row, "Aerial_Duels_Won")
        aerial_lose = _safe_series_value(advanced_row, "Aerial_Duels_Lost")
        headed_goals = _safe_series_value(shooter_row, "Headed_Goals")
        header_sot = _safe_series_value(advanced_row, "Header_SOT")
        header_clear = _safe_series_value(advanced_row, "Header_Clear")
        duel_total = duel_win + duel_lose + aerial_win + aerial_lose
        duel_success_pct = ((duel_win + aerial_win) / duel_total * 100) if duel_total > 0 else 0.0
        header_count = headed_goals + header_sot + header_clear

        candidate_map = {
            "Goal": f"Goal : {int(goals)}골",
            "Assist": f"Assist : {int(assists)}도움",
            "슈팅(유효슈팅)": f"슈팅(유효슈팅) : {int(total_shots)}회({int(shots_on_target)}회)",
            "기대득점(xG)": f"기대득점(xG) : {_format_decimal(total_xg)} ({int(goals)}골)",
            "크로스 성공률(%)": f"크로스 성공률(%) : {_format_percent(cross_accuracy)} ({int(successful_crosses)}회)",
            "헤더": f"헤더 : {_format_count(header_count)}",
            "드리블": f"드리블 : {_format_count(dribble)}",
            "돌파": f"돌파 : {_format_count(breakthrough)}",
            "패스 성공률(%)": f"패스 성공률(%) : {_format_percent(pass_success_rate)} ({int(success_pass)}회)",
            "전진 패스": f"전진 패스 : {_format_count(progressive_pass)}",
            "Key Pass": f"Key Pass : {_format_count(key_pass)}",
            "인터셉트": f"인터셉트 : {_format_count(intercept)}",
            "태클": f"태클 : {_format_count(tackle)}",
            "클리어": f"클리어 : {_format_count(clear)}",
            "차단": f"차단 : {_format_count(block)}",
            "경합 성공률(%)": f"경합 성공률(%) : {_format_percent(duel_success_pct)}",
            "볼 터치": f"볼 터치 : {_format_count(touches)}",
        }

        weighted_pool = {
            "Goal": goals * 100,
            "Assist": assists * 90,
            "슈팅(유효슈팅)": total_shots * 18 + shots_on_target * 12,
            "기대득점(xG)": total_xg * 40,
            "크로스 성공률(%)": crosses * 14 + successful_crosses * 4,
            "헤더": header_count * 10,
            "드리블": dribble * 10,
            "돌파": breakthrough * 12,
            "패스 성공률(%)": pass_success_rate + success_pass,
            "전진 패스": progressive_pass * 14,
            "Key Pass": key_pass * 16,
            "인터셉트": intercept * 9,
            "태클": tackle * 10,
            "클리어": clear * 7,
            "차단": block * 8,
            "경합 성공률(%)": duel_success_pct + duel_total,
            "볼 터치": touches * 0.5,
        }

        ranked_keys = sorted(stat_priority, key=lambda key: weighted_pool.get(key, 0), reverse=True)
        candidates = [candidate_map[key] for key in ranked_keys if key in candidate_map]

        ranking_score = (
            goals * 100
            + assists * 80
            + total_xg * 35
            + shots_on_target * 15
            + key_pass * 14
            + progressive_pass * 10
            + breakthrough * 9
            + dribble * 6
            + intercept * 6
            + tackle * 6
            + clear * 3
            + block * 4
            + touches * 0.2
        )

        players_payload.append(
            {
                "player_id": player,
                "team": _clean_player_label(player_teams.get(raw_player, "")),
                "ranking_score": round(ranking_score, 2),
                "candidates": candidates,
            }
        )

    players_payload.sort(key=lambda item: item["ranking_score"], reverse=True)
    recommended_player_id = players_payload[0]["player_id"] if players_payload else None
    return {
        "players": players_payload,
        "recommended_player_id": recommended_player_id,
    }


def load_excel_dataframe(file_bytes: bytes, sheet_name: str | int = 0) -> pd.DataFrame:
    return _dedupe_dataframe_columns(pd.read_excel(io.BytesIO(file_bytes), sheet_name=sheet_name))


def extract_players(file_bytes: bytes) -> list[str]:
    try:
        df = load_excel_dataframe(file_bytes, "Data")
    except ValueError:
        df = load_excel_dataframe(file_bytes, 0)
    if "Player" not in df.columns:
        raise ValueError("Player 컬럼 없음")
    players = [_clean_player_label(value) for value in df["Player"].dropna().unique()]
    deduped = sorted(set(player for player in players if player), key=lambda value: float(value) if value.replace(".", "", 1).isdigit() else 999)
    return deduped


def _load_visual_df(file_bytes: bytes) -> pd.DataFrame:
    try:
        df = load_excel_dataframe(file_bytes, "Data")
    except ValueError:
        df = load_excel_dataframe(file_bytes, 0)
    required_cols = ["StartX_adj", "StartY_adj", "EndX_adj", "EndY_adj"]
    if not all(col in df.columns for col in required_cols):
        df = perform_full_analysis(df)
    return df


def _build_data_workbook(df: pd.DataFrame) -> bytes:
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Data", index=False)
    output.seek(0)
    return output.getvalue()


def _resolve_pitch_background_path() -> Path | None:
    env_path = os.getenv("FPA_PITCH_IMAGE_PATH", "").strip()
    candidates = [
        Path(env_path) if env_path else None,
        Path("/app/apps/web/public/fpa-field.png"),
        Path(__file__).resolve().parents[2] / "web/public/fpa-field.png",
        Path.cwd() / "apps/web/public/fpa-field.png",
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    return None


def _load_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    font_candidates = [
        Path("/app/assets/fonts/KFAGothicBold.otf" if bold else "/app/assets/fonts/KFAGothicRegular.otf"),
        Path.cwd() / "assets/fonts" / ("KFAGothicBold.otf" if bold else "KFAGothicRegular.otf"),
    ]
    for path in font_candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def _fit_cover(image: Image.Image, target_size: tuple[int, int]) -> Image.Image:
    target_w, target_h = target_size
    scale = max(target_w / image.width, target_h / image.height)
    resized = image.resize((max(1, int(round(image.width * scale))), max(1, int(round(image.height * scale)))), Image.Resampling.LANCZOS)
    left = max(0, (resized.width - target_w) // 2)
    top = max(0, (resized.height - target_h) // 2)
    return resized.crop((left, top, left + target_w, top + target_h))


def _fit_contain(image: Image.Image, target_size: tuple[int, int]) -> Image.Image:
    target_w, target_h = target_size
    scale = min(target_w / image.width, target_h / image.height)
    resized = image.resize((max(1, int(round(image.width * scale))), max(1, int(round(image.height * scale)))), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", target_size, (0, 0, 0, 0))
    offset_x = (target_w - resized.width) // 2
    offset_y = (target_h - resized.height) // 2
    canvas.alpha_composite(resized, (offset_x, offset_y))
    return canvas


def _make_grass_canvas(size: tuple[int, int]) -> Image.Image:
    width, height = size
    grass_a = (16, 104, 86, 255)
    grass_b = (20, 116, 96, 255)
    canvas = Image.new("RGBA", size, grass_a)
    draw = ImageDraw.Draw(canvas)
    stripe_count = 8
    stripe_w = max(1, width // stripe_count)
    for index in range(stripe_count):
        color = grass_a if index % 2 == 0 else grass_b
        draw.rectangle((index * stripe_w, 0, min(width, (index + 1) * stripe_w), height), fill=color)
    return canvas


def _trim_outer_border(image: Image.Image, ratio: float = 0.035) -> Image.Image:
    width, height = image.size
    trim_x = max(1, int(round(width * ratio)))
    trim_y = max(1, int(round(height * ratio)))
    left = trim_x
    top = trim_y
    right = max(left + 1, width - trim_x)
    bottom = max(top + 1, height - trim_y)
    return image.crop((left, top, right, bottom))


def _ensure_grass_background(image: Image.Image | None) -> Image.Image | None:
    if image is None:
        return None
    return _trim_outer_border(image.convert("RGBA"))


def _build_pitch_panel(overlay: Image.Image | None, panel_size: tuple[int, int], pitch_background: Image.Image | None) -> Image.Image | None:
    if overlay is None:
        return None
    # Keep full pitch visible without cropping.
    return _fit_contain(overlay.convert("RGBA"), panel_size)


def _encode_png(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    output.seek(0)
    return output.getvalue()


def _encode_base64_png(image: Image.Image | None) -> str | None:
    if image is None:
        return None
    return base64.b64encode(_encode_png(image)).decode("utf-8")


def _build_player_visual_image(
    *,
    player_id: str,
    report_title: str,
    heatmap: Image.Image | None,
    passmap: Image.Image | None,
    pitch_background: Image.Image | None,
) -> Image.Image:
    canvas = Image.new("RGBA", (1800, 1040), (240, 242, 244, 255))
    draw = ImageDraw.Draw(canvas)
    title_font = _load_font(70, bold=True)
    label_font = _load_font(52, bold=True)
    panel_label_font = _load_font(44, bold=False)

    draw.text((120, 66), report_title, fill=(16, 16, 16, 255), font=title_font)
    draw.text((120, 170), f"No. {player_id}", fill=(16, 16, 16, 255), font=label_font)

    panel_w = 740
    panel_h = 480
    panel_top = 250
    left_x = 120
    right_x = left_x + panel_w + 80

    heat_panel = _build_pitch_panel(heatmap, (panel_w, panel_h), pitch_background)
    pass_panel = _build_pitch_panel(passmap, (panel_w, panel_h), pitch_background)
    if heat_panel is not None:
        canvas.alpha_composite(heat_panel, (left_x, panel_top))
    if pass_panel is not None:
        canvas.alpha_composite(pass_panel, (right_x, panel_top))
    heat_label = "Heatmap"
    pass_label = "Passmap"
    heat_box = draw.textbbox((0, 0), heat_label, font=panel_label_font)
    pass_box = draw.textbbox((0, 0), pass_label, font=panel_label_font)
    heat_x = left_x + panel_w - (heat_box[2] - heat_box[0])
    pass_x = right_x + panel_w - (pass_box[2] - pass_box[0])
    label_y = panel_top - 54
    draw.text((heat_x, label_y), heat_label, fill=(22, 22, 22, 255), font=panel_label_font)
    draw.text((pass_x, label_y), pass_label, fill=(22, 22, 22, 255), font=panel_label_font)
    return canvas


def _build_four_up_pdf(
    entries: list[dict[str, Any]],
    report_title: str,
    pitch_background: Image.Image | None,
) -> bytes:
    if not entries:
        raise ValueError("PDF로 생성할 선수가 없습니다.")

    page_w, page_h = 2480, 3508
    margin_x = 110
    top_margin = 90
    bottom_margin = 120
    column_gap = 80
    row_gap = 40
    number_block_h = 66
    label_to_panel_gap = 14
    label_text_h = 48
    start_y = 290

    # Keep pitch ratio fixed (105:68) and shrink if 4 rows do not fit.
    max_panel_w_by_width = (page_w - (margin_x * 2) - column_gap) // 2
    usable_h = page_h - start_y - bottom_margin
    per_row_fixed_h = number_block_h + label_to_panel_gap + label_text_h + row_gap
    max_panel_h_by_height = max(220, (usable_h - (per_row_fixed_h * 4)) // 4)
    max_panel_w_by_height = int(max_panel_h_by_height * (105 / 68))
    panel_w = max(640, min(max_panel_w_by_width, max_panel_w_by_height))
    panel_h = int(round(panel_w * (68 / 105)))
    row_h = number_block_h + label_to_panel_gap + label_text_h + panel_h + row_gap
    title_font = _load_font(78, bold=True)
    row_font = _load_font(56, bold=True)
    panel_font = _load_font(44, bold=False)

    pages: list[Image.Image] = []
    group_width = (panel_w * 2) + column_gap
    group_left = max(margin_x, (page_w - group_width) // 2)

    for page_start in range(0, len(entries), 4):
        page_entries = entries[page_start : page_start + 4]
        page = Image.new("RGB", (page_w, page_h), (240, 242, 244))
        draw = ImageDraw.Draw(page)
        title_box = draw.textbbox((0, 0), report_title, font=title_font)
        title_w = title_box[2] - title_box[0]
        draw.text((group_left + max(0, (group_width - title_w) // 2), top_margin), report_title, fill=(12, 12, 12), font=title_font)

        for row_idx, entry in enumerate(page_entries):
            base_y = start_y + (row_idx * row_h)
            draw.text((group_left, base_y), f"No. {entry['player_id']}", fill=(20, 20, 20), font=row_font)

            panel_y = base_y + number_block_h + label_to_panel_gap + label_text_h
            left_x = group_left
            right_x = group_left + panel_w + column_gap

            heat_panel = _build_pitch_panel(entry.get("heatmap"), (panel_w, panel_h), pitch_background)
            pass_panel = _build_pitch_panel(entry.get("passmap"), (panel_w, panel_h), pitch_background)

            if heat_panel is not None:
                heat_rgba = heat_panel.convert("RGBA")
                page.paste(heat_rgba, (left_x, panel_y), heat_rgba)
            if pass_panel is not None:
                pass_rgba = pass_panel.convert("RGBA")
                page.paste(pass_rgba, (right_x, panel_y), pass_rgba)
            heat_label = "Heatmap"
            pass_label = "Passmap"
            heat_box = draw.textbbox((0, 0), heat_label, font=panel_font)
            pass_box = draw.textbbox((0, 0), pass_label, font=panel_font)
            label_y = panel_y - label_text_h
            draw.text((left_x + panel_w - (heat_box[2] - heat_box[0]), label_y), heat_label, fill=(18, 18, 18), font=panel_font)
            draw.text((right_x + panel_w - (pass_box[2] - pass_box[0]), label_y), pass_label, fill=(18, 18, 18), font=panel_font)

        pages.append(page)

    output = io.BytesIO()
    pages[0].save(output, format="PDF", save_all=True, append_images=pages[1:])
    output.seek(0)
    return output.getvalue()


def build_visual_reports(file_bytes: bytes, player_id: str, report_title: str | None = None) -> dict[str, str | None]:
    visual_df = _load_visual_df(file_bytes)
    workbook_bytes = _build_data_workbook(visual_df)
    normalized_player = _clean_player_label(player_id)
    heatmap = _ensure_grass_background(render_reference_heatmap(workbook_bytes, normalized_player))
    passmap = _ensure_grass_background(render_reference_passmap(workbook_bytes, normalized_player))
    pitch_path = _resolve_pitch_background_path()
    pitch_background = Image.open(pitch_path).convert("RGBA") if pitch_path else None
    combined = _build_player_visual_image(
        player_id=normalized_player,
        report_title=(report_title or DEFAULT_FPA_REPORT_TITLE).strip() or DEFAULT_FPA_REPORT_TITLE,
        heatmap=heatmap,
        passmap=passmap,
        pitch_background=pitch_background,
    )
    return {
        "pass_map": _encode_base64_png(passmap),
        "heatmap": _encode_base64_png(heatmap),
        "combined_map": _encode_base64_png(combined),
    }


def build_visual_reports_archive(file_bytes: bytes, report_title: str | None = None) -> bytes:
    visual_df = _load_visual_df(file_bytes)
    workbook_bytes = _build_data_workbook(visual_df)
    players = extract_players(workbook_bytes)
    if not players:
        raise ValueError("시각화할 선수를 찾지 못했습니다.")

    pitch_path = _resolve_pitch_background_path()
    pitch_background = Image.open(pitch_path).convert("RGBA") if pitch_path else None
    final_title = (report_title or DEFAULT_FPA_REPORT_TITLE).strip() or DEFAULT_FPA_REPORT_TITLE

    entries: list[dict[str, Any]] = []
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for player in players:
            heatmap = _ensure_grass_background(render_reference_heatmap(workbook_bytes, player))
            passmap = _ensure_grass_background(render_reference_passmap(workbook_bytes, player))
            combined = _build_player_visual_image(
                player_id=player,
                report_title=final_title,
                heatmap=heatmap,
                passmap=passmap,
                pitch_background=pitch_background,
            )
            archive.writestr(f"players/{player}_visual.png", _encode_png(combined))
            entries.append({"player_id": player, "heatmap": heatmap, "passmap": passmap})

        pdf_bytes = _build_four_up_pdf(entries, final_title, pitch_background)
        archive.writestr("visual_report_4up.pdf", pdf_bytes)

    zip_buffer.seek(0)
    return zip_buffer.getvalue()


def import_logs_from_workbook(file_bytes: bytes) -> dict[str, Any]:
    df = load_excel_dataframe(file_bytes, "Data")
    required_cols = ["Half", "Team", "Direction", "Time", "Player", "Action", "StartX", "StartY"]
    missing = [col for col in required_cols if col not in df.columns]
    if missing:
        raise ValueError(f"Data 시트에 필요한 컬럼이 없습니다: {', '.join(missing)}")

    logs: list[str] = []
    rows: list[dict[str, str]] = []

    def clean_value(value: Any) -> str:
        return _clean_scalar_text(value)

    home_team_id = ""
    away_team_id = ""
    match_id = clean_value(df.iloc[0]["MatchID"]) if "MatchID" in df.columns and not df.empty else ""

    for _, row in df.iterrows():
        team = clean_value(row.get("Team", "")).lower()
        direction = clean_value(row.get("Direction", "")).lower()
        half = clean_value(row.get("Half", ""))
        timeline = clean_value(row.get("Time", ""))
        player = clean_value(row.get("Player", ""))
        action = clean_value(row.get("Action", ""))
        receiver = clean_value(row.get("Receiver", ""))
        start_x = clean_value(row.get("StartX", ""))
        start_y = clean_value(row.get("StartY", ""))
        end_x = clean_value(row.get("EndX", ""))
        end_y = clean_value(row.get("EndY", ""))
        path_points = clean_value(row.get("PathPoints", ""))
        tags = clean_value(row.get("Tags", ""))
        dual_state = clean_value(row.get("DualState", ""))
        team_id = clean_value(row.get("TeamID", ""))
        xg = clean_value(row.get("xG", ""))
        xgot = clean_value(row.get("xGOT", ""))
        epv = clean_value(row.get("EPV", ""))
        pc = clean_value(row.get("PC", ""))

        if team == "home" and team_id and not home_team_id:
            home_team_id = team_id
        if team == "away" and team_id and not away_team_id:
            away_team_id = team_id

        action_str = f"{player} {action}".strip()
        if receiver:
            action_str += f" to {receiver}"

        log_parts = [
            half,
            team,
            direction,
            timeline,
            f"Pos({start_x}, {start_y})",
            action_str,
        ]
        if end_x and end_y:
            log_parts.append(f"Pos({end_x}, {end_y})")
        if path_points:
            log_parts.append(f"Path({path_points})")
        if tags:
            log_parts.append(f"Tags: {tags}")
        metrics = _format_metrics({"xG": xg, "xGOT": xgot, "EPV": epv, "PC": pc})
        if metrics:
            log_parts.append(f"Metrics: {metrics}")
        if dual_state:
            log_parts.append(f"DualState: {dual_state}")
        logs.append(" | ".join(log_parts))
        rows.append(
            {
                "Time": timeline,
                "Team": team,
                "Player": player,
                "Action": action,
                "Receiver": receiver,
                "Coord": f"Pos({start_x}, {start_y})",
                "Tags": tags,
                "PathPoints": path_points,
                "DualState": dual_state,
                "xG": _parse_metrics(metrics).get("xG", "") if metrics else "",
                "xGOT": _parse_metrics(metrics).get("xGOT", "") if metrics else "",
                "EPV": _parse_metrics(metrics).get("EPV", "") if metrics else "",
                "PC": _parse_metrics(metrics).get("PC", "") if metrics else "",
            }
        )

    return {
        "logs": logs,
        "rows": rows,
        "match_id": match_id,
        "teamid_h": home_team_id,
        "teamid_a": away_team_id,
    }
