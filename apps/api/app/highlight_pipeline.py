"""Highlight extraction pipeline for console (production).

Adapted from ai-highlight/extract.py + log_extract.py.
XGB is always active in this version. YOLO/XGB models are passed in as
arguments rather than loaded from global scope.
"""
from __future__ import annotations

import logging
import math
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
import pandas as pd
from scipy.signal import find_peaks

logger = logging.getLogger(__name__)

# ── clip sizing constants ──────────────────────────────────────────────────
CLIP_DURATION_BEFORE = 15   # seconds before anchor frame
CLIP_DURATION_AFTER = 10    # seconds after anchor frame
MIN_SECONDS_BETWEEN_CLIPS = 15
SCORE_THRESHOLD = 0.2

# log-mode constants (kept identical to log_extract.py)
LOG_CLIP_BEFORE = 45   # seconds before event
LOG_CLIP_AFTER = 25    # seconds after event
_LOG_MIN_GAP = 20  # event merge gap (s). events within 20s are merged (GOAL priority)

_LOG_EVENT_SCORES = {"GOAL": 1.0, "HIGHLIGHT": 0.9}
LOG_VALID_EVENTS = {"GOAL", "HIGHLIGHT"}

YOLO_CONF = 0.15
YOLO_IMGSZ = 1280
YOLO_STRIDE = 7
# 공 전용 detect-only 패스 임계값 (ByteTrack이 stride=7에서 공 ~87% 누락 → 별도 추론으로 회복)
BALL_DETECT_CONF = 0.10
# 잔디(녹색) 마스크로 경기장 밖(관중·벤치) player/ref 오탐 제거. 끄려면 USE_GRASS_MASK=0.
GRASS_MASK = os.environ.get("USE_GRASS_MASK", "1") == "1"
GRASS_FILTER_CLASSES = ("player", "goalkeeper", "referee")  # 공/골대는 공중·라인 위라 미적용

_ML_BASE_COLS = [
    "inv_dist_centroid_masked",
    "f_ball_speed", "f_ball_accel",
    "f_goalpost_visible",
    "f_ball_dir_change",
    "f_possession_switches",
    "f_sprint_count",
    "f_ball_to_goal_width_ratio",
    "f_goal_bbox_width_norm",
    "f_players_near_ball",
    "f_ball_visible",
    "f_ball_to_goal_approach",
]

ML_FEATURES = [
    "inv_dist_centroid_masked_max",
    "inv_dist_centroid_masked_mean",
    "f_ball_speed_max",
    "f_ball_speed_anchor",
    "f_ball_accel_std",
    "f_goalpost_visible_mean",
    "f_ball_dir_change_max",
    "f_ball_dir_change_mean",
    "f_possession_switches_mean",
    "f_sprint_count_max",
    "f_ball_to_goal_width_ratio_mean",
    "f_goal_bbox_width_norm_mean",
    "f_players_near_ball_max",
    "f_ball_visible_mean",
    "f_ball_to_goal_approach_max",
]

AI_EVENT_WINDOW_ROWS = 25

XH_WEIGHTS = {"goal": 100.0, "setpiece": 80.0, "base": 1.0}


# ── result dataclasses ────────────────────────────────────────────────────

@dataclass
class HighlightRunResult:
    success: bool
    message: str
    fps: float = 0.0
    highlight_frames: list[int] | None = None
    output_dir: str = ""
    clip_paths: list[str] | None = None
    clip_features: list[str] | None = None
    clip_feature_stats: dict[int, dict[str, float]] | None = None
    clip_scores: dict[int, float] | None = None


@dataclass
class LogExtractResult:
    success: bool
    message: str
    clip_paths: list[str] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    fps: float = 30.0
    clip_scores: dict[str, float] = field(default_factory=dict)
    clip_features: dict[str, str] = field(default_factory=dict)
    clip_feature_stats: dict[str, dict] = field(default_factory=dict)
    highlight_frames: list[int] = field(default_factory=list)


# ── log pipeline helpers ──────────────────────────────────────────────────

@dataclass
class _LogEvent:
    video_sec: float
    event_type: str
    half: str
    elapsed_sec: int


def _parse_log(
    log_data: list[dict[str, Any]],
    second_half_start_sec: float,
    event_filter: set[str] | None = None,
) -> list[_LogEvent]:
    if event_filter is None:
        event_filter = LOG_VALID_EVENTS
    events: list[_LogEvent] = []
    for item in log_data:
        event_type = str(item.get("eventLog", "")).upper()
        if event_type not in event_filter:
            continue
        # API field is elapsedSeconds (legacy elapsedTime fallback)
        elapsed_sec = int(item.get("elapsedSeconds", item.get("elapsedTime", 0)))
        half = str(item.get("halfType", "FIRST_HALF")).upper()
        video_sec = float(elapsed_sec) if half == "FIRST_HALF" else second_half_start_sec + elapsed_sec
        events.append(_LogEvent(video_sec=video_sec, event_type=event_type, half=half, elapsed_sec=elapsed_sec))
    # FIRST_HALF time order → SECOND_HALF time order
    half_order = {"FIRST_HALF": 0, "SECOND_HALF": 1}
    events.sort(key=lambda e: (half_order.get(e.half, 2), e.elapsed_sec))
    return events


def _dedup_events(events: list[_LogEvent]) -> list[_LogEvent]:
    if not events:
        return []
    sorted_ev = sorted(events, key=lambda e: e.video_sec)
    result = [sorted_ev[0]]
    for ev in sorted_ev[1:]:
        prev = result[-1]
        if ev.video_sec - prev.video_sec < _LOG_MIN_GAP:
            if ev.event_type == "GOAL" and prev.event_type != "GOAL":
                result[-1] = ev
        else:
            result.append(ev)
    return result


def _get_video_duration(video_path: str) -> float | None:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, check=True,
        )
        return float(r.stdout.strip())
    except Exception:
        return None


def _get_video_fps(video_path: str) -> float | None:
    """Return r_frame_rate (e.g. '60000/1001') as a float fps, or None on failure.

    Accurate fps is needed to compute AI clip anchor labels (frame/fps);
    e.g. dividing a 59.94fps video by 30fps would double the label time.
    """
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=r_frame_rate",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, check=True,
        )
        raw = r.stdout.strip()
        if "/" in raw:
            num, den = raw.split("/")
            den_f = float(den)
            return float(num) / den_f if den_f else None
        return float(raw)
    except Exception:
        return None


def _cut_clip(video_path: str, start: float, duration: float, out_path: str) -> bool:
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}", "-i", video_path,
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-c:a", "aac",
        "-avoid_negative_ts", "make_zero",
        out_path,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError:
        return False


# ── XH score calculator ───────────────────────────────────────────────────

class XHScoreCalculator:
    def __init__(self, weights: dict, fps: float, xgb_model: Any = None):
        self.weights = weights
        self.fps = fps
        self._xgb = xgb_model
        self._xgb_n_features = 0
        if xgb_model is not None:
            try:
                self._xgb_n_features = int(xgb_model.n_features_in_)
            except AttributeError:
                try:
                    self._xgb_n_features = xgb_model.get_booster().num_features()
                except Exception:
                    self._xgb_n_features = 0

    def _compute_ball_physics(self, df: pd.DataFrame, all_frames: list) -> pd.DataFrame:
        ball_coords = (df[df["class_name"] == "ball"]
                       .drop_duplicates("frame")
                       .set_index("frame")[["cx", "cy"]])
        ball_stats = pd.DataFrame(index=all_frames)
        ball_stats[["cx", "cy"]] = ball_coords

        # 긴 공백을 가로지르는 보간은 가짜 등속(speed≈일정·accel≈0)을 만들어
        # 격렬한 장면을 '조용함'으로 둔갑시킨다. ~1초 이내 공백만 보간하고
        # 그 이상은 NaN으로 두어 speed/accel/dir_change가 0(무신호)으로 귀결되게 한다.
        stride = (all_frames[1] - all_frames[0]) if len(all_frames) > 1 else 1
        gap_limit = max(1, int(round(self.fps / max(stride, 1))))
        ball_interp = ball_stats[["cx", "cy"]].interpolate(
            method="linear", limit=gap_limit, limit_area="inside")
        ball_dx = ball_interp["cx"].diff()
        ball_dy = ball_interp["cy"].diff()
        ball_diff = (ball_dx.pow(2) + ball_dy.pow(2)).pow(0.5)

        ball_stats["speed"] = ball_diff.fillna(0)
        ball_stats["accel"] = ball_diff.diff().abs().fillna(0)
        ball_stats["vx"] = ball_dx.fillna(0)
        ball_stats["vy"] = ball_dy.fillna(0)

        v1x, v1y = ball_stats["vx"].shift(1), ball_stats["vy"].shift(1)
        v2x, v2y = ball_stats["vx"], ball_stats["vy"]
        mag1 = np.sqrt(v1x**2 + v1y**2)
        mag2 = np.sqrt(v2x**2 + v2y**2)
        cos_sim = (v1x * v2x + v1y * v2y) / (mag1 * mag2 + 1e-5)
        cos_sim = cos_sim.clip(-1.0, 1.0).fillna(0.0)
        dir_change = (1.0 - cos_sim).where((mag1 >= 0.5) & (mag2 >= 0.5), 0.0)
        ball_stats["dir_change"] = dir_change
        return ball_stats

    def _compute_goal_ref(self, df: pd.DataFrame, all_frames: list) -> pd.DataFrame:
        """프레임별 골대 기준점(가장 넓은 bbox) + persistence.

        골대는 정적인데 탐지율이 ~45%로 깜빡인다. 짧은 미탐지(~2초)는 마지막 탐지 위치를
        유지(ffill/bfill)해 inv_dist_centroid·골대상대 피처의 유효 커버리지를 넓힌다.
        """
        cols = ["g_cx", "g_cy", "g_w", "g_h"]
        goal_rows = []
        for frame, fdf in df.groupby("frame"):
            goals_f = fdf[fdf["class_name"] == "goal"]
            if goals_f.empty:
                continue
            g = goals_f.loc[goals_f["w"].idxmax()]  # 가장 넓은=가장 가까운/주된 골대
            goal_rows.append({"frame": frame, "g_cx": float(g["cx"]), "g_cy": float(g["cy"]),
                              "g_w": float(g["w"]), "g_h": float(g["h"])})

        goal_ref = (pd.DataFrame(goal_rows).set_index("frame")
                    if goal_rows else pd.DataFrame(columns=cols))
        goal_ref = goal_ref.reindex(all_frames)

        stride = (all_frames[1] - all_frames[0]) if len(all_frames) > 1 else 1
        fill_limit = max(1, int(round(self.fps * 2 / max(stride, 1))))  # ~2초
        goal_ref[cols] = goal_ref[cols].ffill(limit=fill_limit).bfill(limit=fill_limit)
        return goal_ref

    def _compute_frame_features(self, df: pd.DataFrame, ball_stats: pd.DataFrame,
                                all_frames: list, goal_ref: pd.DataFrame) -> pd.DataFrame:
        frame_features = []
        for frame, frame_df in df.groupby("frame"):
            players = frame_df[frame_df["class_name"] == "player"]
            clustering_score = 0.0
            if len(players) >= 2:
                players_calc = players.copy()
                players_calc["y_bottom"] = players_calc["cy"] + players_calc["h"] / 2
                p_list = players_calc.to_dict("records")
                pair_distances = []
                for i in range(len(p_list)):
                    for j in range(i + 1, len(p_list)):
                        p1, p2 = p_list[i], p_list[j]
                        h_ratio = max(p1["h"], p2["h"]) / (min(p1["h"], p2["h"]) + 1e-5)
                        if h_ratio > 2.0:
                            pair_distances.append(10000.0)
                        else:
                            dx = p1["cx"] - p2["cx"]
                            dy = (p1["y_bottom"] - p2["y_bottom"]) * 3.0
                            pair_distances.append(np.sqrt(dx**2 + dy**2))
                avg_dist = np.mean(pair_distances) if pair_distances else 10000.0
                clustering_score = 1.0 / (avg_dist + 0.1)

            goals = frame_df[frame_df["class_name"] == "goal"]
            f_goalpost_visible = int(len(goals) > 0)  # raw 가시성 (persistence 아님)
            active = frame_df[frame_df["class_name"].isin(["player", "goalkeeper"])]
            centroid_cx = float(active["cx"].mean()) if not active.empty else np.nan
            centroid_cy = float(active["cy"].mean()) if not active.empty else np.nan

            frame_features.append({
                "frame": frame,
                "clustering": clustering_score,
                "audio": frame_df["f_audio"].max() if "f_audio" in df.columns else 0.0,
                "f_goalpost_visible": f_goalpost_visible,
                "centroid_cx": centroid_cx,
                "centroid_cy": centroid_cy,
            })

        feat_df = pd.DataFrame(frame_features).set_index("frame").reindex(all_frames)

        # 골대 거리: persistence된 goal_ref 기준 (탐지율 ~45% 깜빡임 보완). fillna 전에 계산.
        gr = goal_ref.reindex(feat_df.index)
        feat_df["f_dist_centroid_to_goal"] = np.sqrt(
            (feat_df["centroid_cx"] - gr["g_cx"]) ** 2 +
            (feat_df["centroid_cy"] - gr["g_cy"]) ** 2)
        ball_cx = ball_stats["cx"].reindex(feat_df.index)
        ball_cy = ball_stats["cy"].reindex(feat_df.index)
        feat_df["f_dist_ball_to_goal"] = np.sqrt(
            (ball_cx - gr["g_cx"]) ** 2 + (ball_cy - gr["g_cy"]) ** 2)
        feat_df = feat_df.drop(columns=["centroid_cx", "centroid_cy"]).fillna(0)

        feat_df["player_density"] = np.log1p(feat_df["clustering"])
        feat_df["player_density"] /= feat_df["player_density"].max() + 1e-5
        feat_df["f_audio"] = feat_df["audio"] / (feat_df["audio"].max() + 1e-5)

        norm_speed = ball_stats["speed"] / (ball_stats["speed"].max() + 1e-5)
        norm_accel = ball_stats["accel"] / (ball_stats["accel"].max() + 1e-5)
        feat_df["f_ball_speed"] = norm_speed
        feat_df["f_ball_accel"] = norm_accel
        feat_df["f_ball_dir_change"] = (
            ball_stats["dir_change"] / (ball_stats["dir_change"].max() + 1e-5)
        ).reindex(feat_df.index).fillna(0.0)

        visual_cols = ["f_ball_speed", "f_ball_accel", "player_density",
                       "f_dist_centroid_to_goal", "f_dist_ball_to_goal"]
        feat_df[visual_cols] = (
            feat_df[visual_cols]
            .replace(0, np.nan)
            .interpolate(method="linear", limit=15, limit_direction="both")
            .fillna(0)
        )

        # 공 실탐지 마스크 (보간/채움 전 원본). 윈도우 평균 = 그 구간 공 탐지율.
        feat_df["f_ball_visible"] = (ball_stats["cx"].notna().astype(float)
                                     .reindex(feat_df.index).fillna(0.0))
        return feat_df

    def _add_phase2_features(self, df: pd.DataFrame, feat_df: pd.DataFrame,
                              all_frames: list, ball_stats: pd.DataFrame) -> pd.DataFrame:
        player_types = ("player", "goalkeeper")
        df_by_frame = {f: g for f, g in df.groupby("frame")}

        poss_records = []
        for frame in all_frames:
            if frame not in ball_stats.index:
                poss_records.append((frame, -1)); continue
            bx, by = ball_stats.loc[frame, "cx"], ball_stats.loc[frame, "cy"]
            if np.isnan(bx) or np.isnan(by):
                poss_records.append((frame, -1)); continue
            fdf = df_by_frame.get(frame)
            if fdf is None:
                poss_records.append((frame, -1)); continue
            pl = fdf[fdf["class_name"].isin(player_types)]
            pl = pl[pl["track_id"] != -1]
            if pl.empty:
                poss_records.append((frame, -1)); continue
            dists = np.sqrt((pl["cx"].values - bx)**2 + (pl["cy"].values - by)**2)
            poss_records.append((frame, int(pl["track_id"].iloc[int(np.argmin(dists))])))

        poss_df = pd.DataFrame(poss_records, columns=["frame", "poss_id"]).set_index("frame")
        prev_id = poss_df["poss_id"].shift(1)
        valid = (poss_df["poss_id"] != -1) & (prev_id != -1) & (poss_df["poss_id"] != prev_id)
        win = max(1, int(self.fps * 4 + 1))
        switch_rolling = valid.astype(int).rolling(window=win, center=True).sum().fillna(0)
        feat_df["f_possession_switches"] = (
            switch_rolling / (switch_rolling.max() + 1e-5)
        ).reindex(feat_df.index).fillna(0.0)

        players_df = df[df["class_name"] == "player"].copy()
        if "track_id" in players_df.columns and (players_df["track_id"] != -1).any():
            players_df = players_df[players_df["track_id"] != -1].sort_values(["track_id", "frame"])
            players_df["p_speed"] = np.sqrt(
                players_df.groupby("track_id")["cx"].diff().pow(2) +
                players_df.groupby("track_id")["cy"].diff().pow(2)
            ).fillna(0.0)
            ABS_SPRINT_MIN = 3.0
            threshold = max(float(players_df["p_speed"].quantile(0.75)), ABS_SPRINT_MIN)
            sprint_count = (players_df[players_df["p_speed"] > threshold]
                            .groupby("frame").size()
                            .reindex(feat_df.index).fillna(0))
            feat_df["f_sprint_count"] = sprint_count / (sprint_count.max() + 1e-5)
        else:
            feat_df["f_sprint_count"] = 0.0
        return feat_df

    def _add_goal_relative_features(self, df: pd.DataFrame, feat_df: pd.DataFrame,
                                     all_frames: list, ball_stats: pd.DataFrame,
                                     goal_ref: pd.DataFrame) -> pd.DataFrame:
        player_types = ("player", "goalkeeper")
        df_by_frame = {f: g for f, g in df.groupby("frame")}

        goal_ref_df = goal_ref.reindex(all_frames)  # persistence 적용된 통합 골대 기준

        ball_cx_i = ball_stats["cx"].reindex(all_frames)
        ball_cy_i = ball_stats["cy"].reindex(all_frames)

        dist_px_goal = np.sqrt(
            (ball_cx_i - goal_ref_df["g_cx"]).pow(2) +
            (ball_cy_i - goal_ref_df["g_cy"]).pow(2)
        )
        feat_df["f_ball_to_goal_width_ratio"] = (
            dist_px_goal / (goal_ref_df["g_w"] + 1e-5)
        ).fillna(10.0).clip(upper=10.0)

        gw = goal_ref_df["g_w"]
        feat_df["f_goal_bbox_width_norm"] = (gw / (gw.max() + 1e-5)).fillna(0.0)

        # 골대 방향 추진력: 공 속도벡터의 골대방향 성분(골대폭 정규화=줌 불변). 슛/위협 신호.
        to_gx = goal_ref_df["g_cx"] - ball_cx_i
        to_gy = goal_ref_df["g_cy"] - ball_cy_i
        norm = np.sqrt(to_gx.pow(2) + to_gy.pow(2))
        ux, uy = to_gx / (norm + 1e-5), to_gy / (norm + 1e-5)
        vx_i = ball_stats["vx"].reindex(all_frames)
        vy_i = ball_stats["vy"].reindex(all_frames)
        approach = ((vx_i * ux + vy_i * uy).clip(lower=0)) / (goal_ref_df["g_w"] + 1e-5)
        # 공·골대 둘 다 있어야 유효 (보간 vx는 있어도 raw 공 위치 없으면 방향 신뢰불가)
        approach = approach.where(ball_cx_i.notna() & goal_ref_df["g_cx"].notna())
        feat_df["f_ball_to_goal_approach"] = (
            approach / (approach.max() + 1e-5)
        ).reindex(feat_df.index).fillna(0.0)

        frame_to_idx = {f: i for i, f in enumerate(all_frames)}
        near_counts = np.zeros(len(all_frames), dtype=float)
        for frame in all_frames:
            if frame not in ball_stats.index:
                continue
            bx, by = ball_stats.loc[frame, "cx"], ball_stats.loc[frame, "cy"]
            if pd.isna(bx) or pd.isna(by):
                continue
            fdf = df_by_frame.get(frame)
            if fdf is None:
                continue
            pl = fdf[fdf["class_name"].isin(player_types)]
            if pl.empty:
                continue
            pdists = np.sqrt((pl["cx"].values - bx)**2 + (pl["cy"].values - by)**2)
            gw_frame = goal_ref_df.loc[frame, "g_w"] if frame in goal_ref_df.index else np.nan
            radius = (gw_frame * 1.5) if pd.notna(gw_frame) else 150.0
            near_counts[frame_to_idx[frame]] = int((pdists < radius).sum())

        near_series = pd.Series(near_counts, index=all_frames)
        feat_df["f_players_near_ball"] = near_series / (near_series.max() + 1e-5)
        return feat_df

    def _compute_rule_score(self, feat_df: pd.DataFrame) -> pd.DataFrame:
        # 골대 미탐지(fillna(0)) 프레임은 실제 거리=0이 불가 → where(> 0)으로 NaN 처리 후 fillna(0.0)
        dist_centroid = feat_df["f_dist_centroid_to_goal"].where(feat_df["f_dist_centroid_to_goal"] > 0)
        max_dist = dist_centroid.max() + 1e-5
        inv_dist_centroid = (1.0 - dist_centroid / max_dist).clip(lower=0).fillna(0.0)
        window_size = int(self.fps * 4 + 1)
        visible_in_window = feat_df["f_goalpost_visible"].rolling(window=window_size, center=True).max().fillna(0)
        visibility_factor = (visible_in_window > 0).astype(float) * 0.7 + 0.3
        inv_dist_centroid = inv_dist_centroid * visibility_factor
        feat_df["inv_dist_centroid_masked"] = inv_dist_centroid

        inv_dist_ball = 1.0 - feat_df["f_dist_ball_to_goal"] / (feat_df["f_dist_ball_to_goal"].max() + 1e-5)
        ball_goal_valid = feat_df["f_dist_ball_to_goal"] > 0
        cond1 = inv_dist_ball > 0.85
        cond1_strong = (inv_dist_ball > 0.95) & ball_goal_valid
        cond2 = (feat_df["player_density"] > 0.2) & (inv_dist_centroid > 0.3)
        feat_df["bonus_score"] = 0.0
        feat_df.loc[cond1 & cond2, "bonus_score"] = 0.5
        feat_df.loc[cond1_strong, "bonus_score"] = 0.7

        base_vision = (
            inv_dist_centroid * 0.35 +
            feat_df["player_density"] * 0.25 +
            feat_df["f_ball_accel"] * 0.20 +
            feat_df["f_ball_dir_change"] * 0.10 +
            feat_df["f_ball_speed"] * 0.05 +
            feat_df["f_players_near_ball"] * 0.05
        )
        vision_score = (base_vision + feat_df["bonus_score"]).clip(upper=1.0)
        feat_df["xh_score"] = (vision_score * 0.9 + feat_df["f_audio"] * 0.1).clip(upper=1.0)

        top_feature_df = pd.DataFrame({
            "f_ball_speed": feat_df["f_ball_speed"],
            "f_ball_accel": feat_df["f_ball_accel"],
            "player_density": feat_df["player_density"],
            "f_players_near_ball": feat_df["f_players_near_ball"],
            "f_audio": feat_df["f_audio"],
            "inv_dist_centroid": inv_dist_centroid,
        })
        feat_df["top_feature"] = top_feature_df.idxmax(axis=1)
        return feat_df

    def _compute_ml_score(self, feat_df: pd.DataFrame) -> pd.DataFrame:
        feat_df["xgb_score"] = 0.0
        if self._xgb is None:
            feat_df["final_ensemble_score"] = feat_df["xh_score"]
            return feat_df

        ai_features = (ML_FEATURES[:self._xgb_n_features]
                       if self._xgb_n_features and self._xgb_n_features < len(ML_FEATURES)
                       else ML_FEATURES)
        try:
            ai_data = []
            elite_features_data = []
            for i in range(len(feat_df)):
                start_idx = max(0, i - AI_EVENT_WINDOW_ROWS)
                end_idx = min(len(feat_df), i + AI_EVENT_WINDOW_ROWS + 1)
                window = feat_df.iloc[start_idx:end_idx]
                full_stats = {}
                for col in _ML_BASE_COLS:
                    if col in feat_df.columns:
                        series = window[col]
                        full_stats[f"{col}_anchor"] = float(feat_df.iloc[i][col])
                        full_stats[f"{col}_mean"] = float(series.mean())
                        full_stats[f"{col}_max"] = float(series.max())
                        full_stats[f"{col}_min"] = float(series.min())
                        full_stats[f"{col}_std"] = float(series.std(ddof=0))
                row_elite = {f: full_stats.get(f, 0.0) for f in ai_features}
                ai_data.append([row_elite[f] for f in ai_features])
                elite_features_data.append(row_elite)

            elite_df = pd.DataFrame(elite_features_data, index=feat_df.index)
            feat_df = pd.concat([feat_df, elite_df], axis=1)
            probs = self._xgb.predict_proba(np.array(ai_data))
            feat_df["xgb_score"] = probs[:, 1]
        except Exception as exc:
            logger.warning("XGBoost inference failed, falling back to rule score: %s", exc)
            feat_df["xgb_score"] = feat_df["xh_score"]

        if (feat_df["xgb_score"] == 0).all():
            feat_df["final_ensemble_score"] = feat_df["xh_score"]
        else:
            feat_df["final_ensemble_score"] = feat_df["xh_score"] * 0.5 + feat_df["xgb_score"] * 0.5
        return feat_df

    def calculate_xh_score(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.sort_values("frame")
        all_frames = sorted(df["frame"].unique())

        if "track_id" not in df.columns:
            df = df.copy()
            df["track_id"] = -1

        ball_stats = self._compute_ball_physics(df, all_frames)
        goal_ref = self._compute_goal_ref(df, all_frames)
        feat_df = self._compute_frame_features(df, ball_stats, all_frames, goal_ref)
        feat_df = self._add_phase2_features(df, feat_df, all_frames, ball_stats)
        feat_df = self._add_goal_relative_features(df, feat_df, all_frames, ball_stats, goal_ref)
        feat_df = self._compute_rule_score(feat_df)
        feat_df = self._compute_ml_score(feat_df)

        # feat_df는 stride 간격 샘플당 1행 → 3초 = (fps*3/stride)행.
        stride = (all_frames[1] - all_frames[0]) if len(all_frames) > 1 else 1
        window_size = max(1, int(self.fps * 3 / max(stride, 1)))
        feat_df["smoothed_score"] = (
            feat_df["final_ensemble_score"]
            .rolling(window=window_size, center=True)
            .mean().fillna(0)
        )
        return feat_df.reset_index()


# ── YOLO detection ────────────────────────────────────────────────────────

def _detect_ball_only(yolo_model: Any, video_path: str, device: str, stride: int,
                      conf: float, total_frames: int,
                      progress_cb: Callable[[int], None] | None = None) -> dict[int, dict]:
    """공 전용 detect-only 패스.

    ByteTrack은 stride=7에서 공 점프가 커 트랙을 못 만들고 공 탐지의 ~87%를 누락한다.
    추적 없이 순수 탐지로 한 패스 더 돌려 공을 회복한다. 프레임별 conf 최고 공 1개만 채택.
    """
    ball_cls = next((k for k, v in yolo_model.names.items() if v == "ball"), None)
    if ball_cls is None:
        return {}
    results = yolo_model.predict(
        source=video_path, device=device, stream=True, half=True,
        vid_stride=stride, conf=conf, imgsz=YOLO_IMGSZ, verbose=False, classes=[ball_cls],
    )
    ball_by_frame: dict[int, dict] = {}
    frame_count = 0
    logged_pct = -1
    for result in results:
        current_frame = int(getattr(result, "frame_idx", frame_count))
        boxes = result.boxes
        if boxes is not None and len(boxes) > 0:
            confs = boxes.conf.cpu().numpy()
            i = int(np.argmax(confs))
            coords = boxes.xyxy[i].cpu().numpy()
            ball_by_frame[current_frame] = {
                "cx": float((coords[0] + coords[2]) / 2),
                "cy": float((coords[1] + coords[3]) / 2),
                "w": float(coords[2] - coords[0]),
                "h": float(coords[3] - coords[1]),
            }
        frame_count += stride
        if progress_cb:
            pct = min(100, int(frame_count / max(total_frames, 1) * 100))
            if pct // 10 > logged_pct // 10:
                logged_pct = pct
                progress_cb(pct)
    return ball_by_frame


def _green_mask(bgr: np.ndarray) -> np.ndarray:
    """잔디(녹색) 이진 마스크. 자연/인조 잔디 포괄, 그림자 고려해 채도/명도 하한 낮춤."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    return cv2.inRange(hsv, np.array([30, 25, 25]), np.array([95, 255, 255]))


def _feet_on_grass(mask: np.ndarray, cx: float, feet_y: float, h: float,
                   min_green: float = 0.15) -> bool:
    """발끝(bbox 하단 중앙) 주변 패치의 녹색 비율로 경기장 안 여부 판정. 경계 밖이면 보존(fail-open)."""
    H, W = mask.shape
    r = max(8, int(h * 0.15))
    x0, x1 = max(0, int(cx) - r), min(W, int(cx) + r)
    y0, y1 = max(0, int(feet_y) - r), min(H, int(feet_y) + r)
    if x1 <= x0 or y1 <= y0:
        return True
    return (mask[y0:y1, x0:x1] > 0).mean() >= min_green


def _detect_objects(video_path: str, yolo_model: Any, stride: int = YOLO_STRIDE,
                    tracker: str = "bytetrack.yaml",
                    progress_cb: Callable[[int, str], None] | None = None
                    ) -> tuple[pd.DataFrame, float]:
    """progress_cb(pct, stage): 추적 패스 0→45%, 공 탐지 패스 45→90% 로 보고."""
    import torch

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    all_detections = []

    tracker_ok = False
    try:
        # half=True 는 CUDA(예: AWS T4)에서만 활성, MPS/CPU 에선 ultralytics 가 자동 무시.
        results = yolo_model.track(
            source=video_path, device=device, stream=True, half=True,
            vid_stride=stride, conf=YOLO_CONF, imgsz=YOLO_IMGSZ,
            verbose=False, persist=True, tracker=tracker,
        )
        tracker_ok = True
    except Exception as exc:
        logger.warning("ByteTrack failed, falling back to detect-only: %s", exc)

    if not tracker_ok:
        results = yolo_model.predict(
            source=video_path, device=device, stream=True, half=True,
            vid_stride=stride, conf=YOLO_CONF, imgsz=YOLO_IMGSZ, verbose=False,
        )

    frame_count = 0
    logged_pct = -1
    grass_removed = 0
    for result in results:
        current_frame = getattr(result, "frame_idx", frame_count)
        if result.boxes is not None:
            ids_tensor = getattr(result.boxes, "id", None)
            ids_list = (ids_tensor.cpu().numpy().astype(int).tolist()
                        if ids_tensor is not None else [-1] * len(result.boxes))

            # 잔디 마스크: 프레임이 경기장 위주(녹색 ≥12%)일 때만 활성 (클로즈업/관중샷은 fail-open)
            gmask = None
            if GRASS_MASK:
                orig = getattr(result, "orig_img", None)
                if orig is not None:
                    gm = _green_mask(orig)
                    if (gm > 0).mean() >= 0.12:
                        gmask = gm

            rows, off_pitch = [], []
            for idx, (box, tid) in enumerate(zip(result.boxes, ids_list)):
                coords = box.xyxy[0].cpu().numpy()
                cls_name = yolo_model.names[int(box.cls[0])]
                cx = float((coords[0] + coords[2]) / 2)
                cy = float((coords[1] + coords[3]) / 2)
                h = float(coords[3] - coords[1])
                rows.append({
                    "frame": int(current_frame), "class_name": cls_name, "track_id": int(tid),
                    "cx": cx, "cy": cy, "w": float(coords[2] - coords[0]), "h": h,
                })
                if gmask is not None and cls_name in GRASS_FILTER_CLASSES \
                        and not _feet_on_grass(gmask, cx, cy + h / 2, h):
                    off_pitch.append(idx)

            # 안전장치: player 과반이 경기장 밖으로 판정되면 마스크 신뢰불가 → 필터 무시(fail-open)
            n_players = sum(1 for r in rows if r["class_name"] == "player")
            n_players_off = sum(1 for i in off_pitch if rows[i]["class_name"] == "player")
            if n_players and n_players_off > 0.5 * n_players:
                off_pitch = []

            off_set = set(off_pitch)
            for i, r in enumerate(rows):
                if i in off_set:
                    grass_removed += 1
                    continue
                all_detections.append(r)
        frame_count += stride
        pct = min(100, int(frame_count / max(total_frames, 1) * 100))
        if pct // 10 > logged_pct // 10:
            logged_pct = pct
            logger.info("Detection progress: %d%%", pct)
            if progress_cb:
                progress_cb(int(pct * 0.45), "선수·공 추적")

    if GRASS_MASK and grass_removed:
        logger.info("Grass mask: removed %d off-pitch detections", grass_removed)

    det_df = pd.DataFrame(all_detections)

    # --- 공 전용 detect-only 패스로 공 행 교체 (추적 모드 공 누락 보완) ---
    if tracker_ok:
        n_ball_track = int((det_df["class_name"] == "ball").sum()) if not det_df.empty else 0
        ball_cb = ((lambda p: progress_cb(45 + int(p * 0.45), "공 탐지"))
                   if progress_cb else None)
        ball_by_frame = _detect_ball_only(yolo_model, video_path, device, stride,
                                          BALL_DETECT_CONF, total_frames, progress_cb=ball_cb)
        if not det_df.empty:
            det_df = det_df[det_df["class_name"] != "ball"]  # 추적 패스의 공 행 폐기
        ball_rows = [
            {"frame": f, "class_name": "ball", "track_id": -1,
             "cx": b["cx"], "cy": b["cy"], "w": b["w"], "h": b["h"]}
            for f, b in ball_by_frame.items()
        ]
        det_df = pd.concat([det_df, pd.DataFrame(ball_rows)], ignore_index=True)
        det_df = det_df.sort_values("frame").reset_index(drop=True)
        logger.info("Ball recovery: track-pass %d frames → detect-pass %d frames",
                    n_ball_track, len(ball_rows))

    return det_df, float(fps)


def _get_audio_features(video_path: str, fps: float) -> pd.DataFrame | None:
    try:
        from moviepy import VideoFileClip
        video = VideoFileClip(video_path)
        if video.audio is None:
            video.close()
            return None
        audio = video.audio
        sr = audio.fps
        audio_data = audio.to_soundarray()
        if len(audio_data.shape) > 1:
            audio_data = np.mean(audio_data, axis=1)
        samples_per_frame = sr / fps
        total_frames = int(video.duration * fps)
        audio_features = []
        for i in range(total_frames):
            start_idx, end_idx = int(i * samples_per_frame), int((i + 1) * samples_per_frame)
            frame_audio = audio_data[start_idx:end_idx]
            power = float(np.sqrt(np.mean(frame_audio**2))) if len(frame_audio) > 0 else 0.0
            audio_features.append({"frame": i, "f_audio": power})
        video.close()
        return pd.DataFrame(audio_features)
    except Exception as exc:
        logger.warning("Audio extraction failed: %s", exc)
        return None


def _create_clips(video_path: str, frames: list[int], fps: float, output_dir: str) -> list[str]:
    from moviepy import VideoFileClip

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    video = VideoFileClip(video_path)
    base_name = Path(video_path).stem
    video_prefix = f"{base_name}_{time.strftime('%m%d_%H%M')}"

    created: list[str] = []
    for i, frame_idx in enumerate(frames):
        t = frame_idx / fps
        start = max(0, t - CLIP_DURATION_BEFORE)
        end = min(video.duration, t + CLIP_DURATION_AFTER)
        try:
            clip = video.subclipped(start, end)
        except AttributeError:
            clip = video.subclip(start, end)
        out = str(output_path / f"{video_prefix}_{i + 1:02d}.mp4")
        clip.write_videofile(out, codec="libx264", audio_codec="aac",
                             temp_audiofile=f"temp-audio-{i}.m4a", remove_temp=True, logger=None)
        created.append(out)
        logger.info("Clip %d/%d created: %s", i + 1, len(frames), out)
    video.close()
    return created


# ── public pipeline functions ─────────────────────────────────────────────

def run_highlight_pipeline(
    video_path: str,
    output_dir: str,
    yolo_model: Any,
    xgb_model: Any = None,
    highlight_count: int = 40,
    exclude_intervals: list[tuple[float, float]] | None = None,
    progress_cb: Callable[[int, str], None] | None = None,
) -> HighlightRunResult:
    logger.info("Starting AI highlight pipeline for %s", video_path)

    detections_df, fps = _detect_objects(video_path, yolo_model, progress_cb=progress_cb)
    if detections_df.empty:
        return HighlightRunResult(False, "탐지된 객체가 없습니다.")
    if progress_cb:
        progress_cb(92, "스코어 계산")

    audio_df = _get_audio_features(video_path, fps)
    if audio_df is not None:
        detections_df = pd.merge(detections_df, audio_df, on="frame", how="left").fillna(0)
    else:
        detections_df["f_audio"] = 0.0

    calculator = XHScoreCalculator(XH_WEIGHTS, fps, xgb_model)
    xh_df = calculator.calculate_xh_score(detections_df)

    extractor = _HighlightExtractor(fps)
    highlight_frames = extractor.extract_auto(xh_df, highlight_count, MIN_SECONDS_BETWEEN_CLIPS, exclude_intervals)
    if not highlight_frames:
        return HighlightRunResult(False, "하이라이트 구간을 찾지 못했습니다.")

    if progress_cb:
        progress_cb(95, "클립 생성")
    clip_paths = _create_clips(video_path, highlight_frames, fps, output_dir)

    _RULE_CONTRIB = {
        "inv_dist_centroid_masked": 0.35,
        "player_density": 0.25,
        "f_ball_accel": 0.20,
        "f_ball_dir_change": 0.10,
        "f_ball_speed": 0.05,
        "f_players_near_ball": 0.05,
    }
    model_loaded = xgb_model is not None
    importances = (dict(zip(ML_FEATURES, xgb_model.feature_importances_))
                   if model_loaded else {})

    clip_feature_stats: dict[int, dict[str, float]] = {}
    for frame in highlight_frames:
        row = xh_df[xh_df["frame"] == frame].head(1)
        if row.empty:
            continue
        if model_loaded:
            vals = {f: importances[f] * (float(row[f].iloc[0]) if f in xh_df.columns else 0.0)
                    for f in ML_FEATURES}
        else:
            vals = {f: w * (float(row[f].iloc[0]) if f in xh_df.columns else 0.0)
                    for f, w in _RULE_CONTRIB.items()}
        total_sum = sum(vals.values())
        clip_feature_stats[frame] = (
            {k: v / total_sum for k, v in vals.items()}
            if total_sum > 1e-9 else {k: 1.0 / len(vals) for k in vals}
        )

    clip_features = [
        max(clip_feature_stats[f].items(), key=lambda x: x[1])[0]
        if f in clip_feature_stats else "unknown"
        for f in highlight_frames
    ]

    clip_scores: dict[int, float] = {}
    for frame in highlight_frames:
        row = xh_df[xh_df["frame"] == frame].head(1)
        if not row.empty:
            clip_scores[frame] = float(row["smoothed_score"].iloc[0])

    if progress_cb:
        progress_cb(100, "완료")
    logger.info("Pipeline complete: %d clips extracted", len(highlight_frames))
    return HighlightRunResult(
        True,
        f"{len(highlight_frames)}개 하이라이트 추출 완료",
        fps, highlight_frames, output_dir,
        clip_paths, clip_features, clip_feature_stats, clip_scores,
    )


def run_log_pipeline(
    video_path: str,
    log_data: list[dict[str, Any]],
    second_half_start_sec: float,
    output_dir: str,
    target_count: int = 40,
    yolo_model: Any = None,
    xgb_model: Any = None,
    progress_cb: Callable[[int, str], None] | None = None,
) -> LogExtractResult:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    events = _dedup_events(_parse_log(log_data, second_half_start_sec))
    if not events:
        return LogExtractResult(success=False, message="로그에서 유효한 이벤트(GOAL/SHOT)를 찾지 못했습니다.")
    if progress_cb:
        progress_cb(3, "로그 이벤트 추출")

    video_duration = _get_video_duration(video_path)
    prefix = f"log_{time.strftime('%m%d_%H%M')}"
    clip_paths: list[str] = []
    events_meta: list[dict] = []

    logger.info("Log mode: %d events → extracting clips", len(events))
    for i, ev in enumerate(events):
        start = max(0.0, ev.video_sec - LOG_CLIP_BEFORE)
        end = ev.video_sec + LOG_CLIP_AFTER
        if video_duration:
            end = min(end, video_duration)
        duration = end - start
        if duration <= 0:
            continue

        clip_name = (
            f"{prefix}_{ev.half.lower()}_{ev.elapsed_sec:04d}s"
            f"_{ev.event_type.lower()}_{i:03d}.mp4"
        )
        clip_path = str(out_dir / clip_name)

        if _cut_clip(video_path, start, duration, clip_path):
            clip_paths.append(clip_path)
            events_meta.append({
                "clip": clip_name,
                "event_type": ev.event_type,
                "half": ev.half,
                "elapsed_sec": ev.elapsed_sec,
                "video_sec": ev.video_sec,
                "source": "log",
            })

    log_count = len(clip_paths)
    remaining = target_count - log_count
    ai_count = 0
    _ai_result: HighlightRunResult | None = None

    if remaining > 0 and yolo_model is not None:
        exclude_intervals = [
            (
                max(0.0, ev.video_sec - LOG_CLIP_BEFORE - CLIP_DURATION_BEFORE),
                ev.video_sec + LOG_CLIP_AFTER + CLIP_DURATION_AFTER,
            )
            for ev in events
        ]
        try:
            # AI 보충이 주 비용 → 내부 0~100% 를 전체 5~100% 로 매핑.
            ai_cb = ((lambda p, s: progress_cb(5 + int(p * 0.95), s))
                     if progress_cb else None)
            ai_result = run_highlight_pipeline(
                video_path=video_path,
                output_dir=output_dir,
                yolo_model=yolo_model,
                xgb_model=xgb_model,
                highlight_count=remaining,
                exclude_intervals=exclude_intervals,
                progress_cb=ai_cb,
            )
            if ai_result.success and ai_result.clip_paths:
                for p in ai_result.clip_paths:
                    clip_paths.append(p)
                    events_meta.append({"clip": Path(p).name, "source": "ai"})
                ai_count = len(ai_result.clip_paths)
                _ai_result = ai_result
        except Exception as exc:
            logger.warning("AI supplement failed in log pipeline: %s", exc)

    clip_scores: dict[str, float] = {}
    clip_features_map: dict[str, str] = {}
    clip_feature_stats_map: dict[str, dict] = {}
    highlight_frames: list[int] = []

    for meta in events_meta:
        if meta.get("source") == "log":
            name = meta["clip"]
            clip_scores[name] = _LOG_EVENT_SCORES.get(meta.get("event_type", ""), 0.5)
            clip_features_map[name] = meta.get("event_type", "").lower() or "log"

    if _ai_result:
        ai_frames = _ai_result.highlight_frames or []
        ai_feats = _ai_result.clip_features or []
        ai_scores_map = _ai_result.clip_scores or {}
        ai_feat_stats = _ai_result.clip_feature_stats or {}

        for i, p in enumerate(_ai_result.clip_paths or []):
            name = Path(p).name
            frame = ai_frames[i] if i < len(ai_frames) else None
            if frame is not None:
                clip_scores[name] = ai_scores_map.get(frame, 0.0)
                highlight_frames.append(frame)
                if frame in ai_feat_stats:
                    clip_feature_stats_map[name] = ai_feat_stats[frame]
            if i < len(ai_feats):
                clip_features_map[name] = ai_feats[i]

    # Real fps: prefer AI result fps (read via cv2 during detection), else ffprobe.
    # The server computes AI clip anchor labels as frame/fps, so fps must be accurate.
    real_fps = (_ai_result.fps if _ai_result and _ai_result.fps else None) or _get_video_fps(video_path) or 30.0

    if progress_cb:
        progress_cb(100, "완료")
    return LogExtractResult(
        success=True,
        message=f"로그 {log_count}개 + AI {ai_count}개 클립 추출 완료",
        clip_paths=clip_paths,
        events=events_meta,
        fps=float(real_fps),
        clip_scores=clip_scores,
        clip_features=clip_features_map,
        clip_feature_stats=clip_feature_stats_map,
        highlight_frames=highlight_frames,
    )


class _HighlightExtractor:
    def __init__(self, fps: float):
        self.fps = fps

    def extract_auto(
        self,
        xh_df: pd.DataFrame,
        count: int,
        min_interval_sec: int,
        exclude_intervals: list[tuple[float, float]] | None = None,
    ) -> list[int]:
        stride = 10
        if len(xh_df) > 1:
            stride = max(1, xh_df["frame"].iloc[1] - xh_df["frame"].iloc[0])

        peaks, _ = find_peaks(xh_df["smoothed_score"], distance=int(self.fps * 2 / stride))
        anchored_candidates = [
            {"frame": int(xh_df.loc[p_idx, "frame"]), "score": xh_df.loc[p_idx, "smoothed_score"]}
            for p_idx in peaks
            if xh_df.loc[p_idx, "smoothed_score"] >= SCORE_THRESHOLD
        ]

        if not anchored_candidates:
            candidates = xh_df.sort_values("smoothed_score", ascending=False).head(count)
            return sorted(candidates["frame"].tolist())

        candidates_df = pd.DataFrame(anchored_candidates).sort_values("score", ascending=False)
        highlight_frames: list[int] = []
        for _, row in candidates_df.iterrows():
            f = int(row["frame"])
            if exclude_intervals and any(s <= f / self.fps <= e for s, e in exclude_intervals):
                continue
            if not any(abs(f - ef) < self.fps * min_interval_sec for ef in highlight_frames):
                highlight_frames.append(f)
            if len(highlight_frames) >= count:
                break

        return sorted(highlight_frames)


def load_models(yolo_model_path: str, xgb_model_path: str | None) -> tuple[Any, Any]:
    """Load YOLO and XGBoost models. Call once at server startup."""
    from ultralytics import YOLO
    import xgboost as xgb

    logger.info("Loading YOLO model from %s", yolo_model_path)
    yolo = YOLO(yolo_model_path)

    xgb_clf = None
    if xgb_model_path and Path(xgb_model_path).exists():
        logger.info("Loading XGBoost model from %s", xgb_model_path)
        xgb_clf = xgb.XGBClassifier()
        xgb_clf.load_model(xgb_model_path)
    else:
        logger.info("XGBoost model not found at %s, rule-based scoring only", xgb_model_path)

    return yolo, xgb_clf
