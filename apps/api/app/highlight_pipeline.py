"""Highlight extraction pipeline for console (production).

Adapted from ai-highlight/extract.py + log_extract.py.
XGB is always active in this version. YOLO/XGB models are passed in as
arguments rather than loaded from global scope.
"""
from __future__ import annotations

import logging
import math
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
LOG_CLIP_BEFORE = 10
LOG_CLIP_AFTER = 5
LOG_CLIP_MINUTE_SPAN = 60
_LOG_MIN_GAP = LOG_CLIP_BEFORE + LOG_CLIP_MINUTE_SPAN + LOG_CLIP_AFTER

_LOG_EVENT_SCORES = {"GOAL": 1.0, "VALID_SHOT": 0.8, "SHOT": 0.6}
LOG_VALID_EVENTS = {"GOAL", "SHOT", "VALID_SHOT"}

YOLO_CONF = 0.15
YOLO_IMGSZ = 1280
YOLO_STRIDE = 7

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
        event_type = str(item.get("eventLog", ""))
        if event_type not in event_filter:
            continue
        elapsed_min = int(item.get("elapsedMinutes", 0))
        half = str(item.get("halfType", "FIRST_HALF"))
        elapsed_sec = elapsed_min * 60
        video_sec = float(elapsed_sec) if half == "FIRST_HALF" else second_half_start_sec + elapsed_sec
        events.append(_LogEvent(video_sec=video_sec, event_type=event_type, half=half, elapsed_sec=elapsed_sec))
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

        ball_interp = ball_stats[["cx", "cy"]].interpolate(method="linear")
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

    def _compute_frame_features(self, df: pd.DataFrame, ball_stats: pd.DataFrame, all_frames: list) -> pd.DataFrame:
        from moviepy import VideoFileClip  # lazy import

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
            f_goalpost_visible = int(len(goals) > 0)
            f_dist_centroid_to_goal = np.nan
            f_dist_ball_to_goal = np.nan
            if not goals.empty:
                goal_center = np.array([goals.iloc[0]["cx"], goals.iloc[0]["cy"]])
                active = frame_df[frame_df["class_name"].isin(["player", "goalkeeper"])]
                if not active.empty:
                    centroid = np.array([active["cx"].mean(), active["cy"].mean()])
                    f_dist_centroid_to_goal = float(np.linalg.norm(centroid - goal_center))
                ball_row = frame_df[frame_df["class_name"] == "ball"]
                if not ball_row.empty:
                    ball_pos = np.array([ball_row.iloc[0]["cx"], ball_row.iloc[0]["cy"]])
                    f_dist_ball_to_goal = float(np.linalg.norm(ball_pos - goal_center))

            frame_features.append({
                "frame": frame,
                "clustering": clustering_score,
                "audio": frame_df["f_audio"].max() if "f_audio" in df.columns else 0.0,
                "f_goalpost_visible": f_goalpost_visible,
                "f_dist_centroid_to_goal": f_dist_centroid_to_goal,
                "f_dist_ball_to_goal": f_dist_ball_to_goal,
            })

        feat_df = pd.DataFrame(frame_features).set_index("frame").reindex(all_frames).fillna(0)

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
                                     all_frames: list, ball_stats: pd.DataFrame) -> pd.DataFrame:
        player_types = ("player", "goalkeeper")
        df_by_frame = {f: g for f, g in df.groupby("frame")}

        goal_rows = []
        for frame in all_frames:
            fdf = df_by_frame.get(frame)
            if fdf is None:
                continue
            goals_f = fdf[fdf["class_name"] == "goal"]
            if goals_f.empty:
                continue
            g = goals_f.loc[goals_f["w"].idxmax()]
            goal_rows.append({"frame": frame, "g_cx": float(g["cx"]), "g_cy": float(g["cy"]),
                               "g_w": float(g["w"]), "g_h": float(g["h"])})

        goal_ref_df = (pd.DataFrame(goal_rows).set_index("frame")
                       if goal_rows else pd.DataFrame(columns=["g_cx", "g_cy", "g_w", "g_h"]))
        goal_ref_df = goal_ref_df.reindex(all_frames)

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
        feat_df = self._compute_frame_features(df, ball_stats, all_frames)
        feat_df = self._add_phase2_features(df, feat_df, all_frames, ball_stats)
        feat_df = self._add_goal_relative_features(df, feat_df, all_frames, ball_stats)
        feat_df = self._compute_rule_score(feat_df)
        feat_df = self._compute_ml_score(feat_df)

        window_size = int(self.fps * 3)
        feat_df["smoothed_score"] = (
            feat_df["final_ensemble_score"]
            .rolling(window=window_size, center=True)
            .mean().fillna(0)
        )
        return feat_df.reset_index()


# ── YOLO detection ────────────────────────────────────────────────────────

ProgressCallback = Callable[[dict[str, Any]], None]


def _detect_objects(video_path: str, yolo_model: Any, progress_callback: ProgressCallback | None = None) -> tuple[pd.DataFrame, float]:
    import torch

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    all_detections = []

    tracker_ok = False
    try:
        results = yolo_model.track(
            source=video_path, device=device, stream=True,
            vid_stride=YOLO_STRIDE, conf=YOLO_CONF, imgsz=YOLO_IMGSZ,
            verbose=False, persist=True, tracker="bytetrack.yaml",
        )
        tracker_ok = True
    except Exception as exc:
        logger.warning("ByteTrack failed, falling back to detect-only: %s", exc)

    if not tracker_ok:
        results = yolo_model.predict(
            source=video_path, device=device, stream=True,
            vid_stride=YOLO_STRIDE, conf=YOLO_CONF, imgsz=YOLO_IMGSZ, verbose=False,
        )

    frame_count = 0
    total_expected = total_frames // YOLO_STRIDE
    logged_pct = -1
    for result in results:
        current_frame = getattr(result, "frame_idx", frame_count)
        if result.boxes is not None:
            ids_tensor = getattr(result.boxes, "id", None)
            ids_list = (ids_tensor.cpu().numpy().astype(int).tolist()
                        if ids_tensor is not None else [-1] * len(result.boxes))
            for box, tid in zip(result.boxes, ids_list):
                coords = box.xyxy[0].cpu().numpy()
                all_detections.append({
                    "frame": int(current_frame),
                    "class_name": yolo_model.names[int(box.cls[0])],
                    "track_id": int(tid),
                    "cx": float((coords[0] + coords[2]) / 2),
                    "cy": float((coords[1] + coords[3]) / 2),
                    "w": float(coords[2] - coords[0]),
                    "h": float(coords[3] - coords[1]),
                })
        frame_count += YOLO_STRIDE
        pct = int(frame_count / max(total_frames, 1) * 100)
        if pct // 10 > logged_pct // 10:
            logged_pct = pct
            logger.info("Detection progress: %d%%", pct)
            if progress_callback:
                progress_callback({"phase": "detecting_objects", "percent": min(65, 5 + int(pct * 0.6)), "detail": f"YOLO 탐지 {pct}%"})

    return pd.DataFrame(all_detections), float(fps)


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


def _create_clips(
    video_path: str,
    frames: list[int],
    fps: float,
    output_dir: str,
    progress_callback: ProgressCallback | None = None,
) -> list[str]:
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
        if progress_callback:
            clip_pct = int(((i + 1) / max(len(frames), 1)) * 19)
            progress_callback({"phase": "creating_clips", "percent": min(99, 80 + clip_pct), "detail": f"클립 생성 {i + 1}/{len(frames)}"})
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
    progress_callback: ProgressCallback | None = None,
) -> HighlightRunResult:
    logger.info("Starting AI highlight pipeline for %s", video_path)

    if progress_callback:
        progress_callback({"phase": "detecting_objects", "percent": 5, "detail": "YOLO 탐지 시작"})
    detections_df, fps = _detect_objects(video_path, yolo_model, progress_callback)
    if detections_df.empty:
        return HighlightRunResult(False, "탐지된 객체가 없습니다.")

    if progress_callback:
        progress_callback({"phase": "audio_scoring", "percent": 68, "detail": "오디오 분석 중"})
    audio_df = _get_audio_features(video_path, fps)
    if audio_df is not None:
        detections_df = pd.merge(detections_df, audio_df, on="frame", how="left").fillna(0)
    else:
        detections_df["f_audio"] = 0.0

    if progress_callback:
        progress_callback({"phase": "scoring", "percent": 74, "detail": "하이라이트 점수 계산 중"})
    calculator = XHScoreCalculator(XH_WEIGHTS, fps, xgb_model)
    xh_df = calculator.calculate_xh_score(detections_df)

    if progress_callback:
        progress_callback({"phase": "selecting_clips", "percent": 78, "detail": "하이라이트 구간 선택 중"})
    extractor = _HighlightExtractor(fps)
    highlight_frames = extractor.extract_auto(xh_df, highlight_count, MIN_SECONDS_BETWEEN_CLIPS, exclude_intervals)
    if not highlight_frames:
        return HighlightRunResult(False, "하이라이트 구간을 찾지 못했습니다.")

    if progress_callback:
        progress_callback({"phase": "creating_clips", "percent": 80, "detail": "클립 생성 시작"})
    clip_paths = _create_clips(video_path, highlight_frames, fps, output_dir, progress_callback)

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
    progress_callback: ProgressCallback | None = None,
) -> LogExtractResult:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    events = _dedup_events(_parse_log(log_data, second_half_start_sec))
    if not events:
        return LogExtractResult(success=False, message="로그에서 유효한 이벤트(GOAL/SHOT)를 찾지 못했습니다.")

    video_duration = _get_video_duration(video_path)
    prefix = f"log_{time.strftime('%m%d_%H%M')}"
    clip_paths: list[str] = []
    events_meta: list[dict] = []

    for i, ev in enumerate(events):
        if progress_callback:
            pct = 5 + int((i / max(len(events), 1)) * 20)
            progress_callback({"phase": "creating_log_clips", "percent": pct, "detail": f"로그 클립 생성 {i + 1}/{len(events)}"})
        start = max(0.0, ev.video_sec - LOG_CLIP_MINUTE_SPAN - LOG_CLIP_BEFORE)
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
                max(0.0, ev.video_sec - LOG_CLIP_MINUTE_SPAN - LOG_CLIP_BEFORE - CLIP_DURATION_BEFORE),
                ev.video_sec + LOG_CLIP_AFTER + CLIP_DURATION_AFTER,
            )
            for ev in events
        ]
        try:
            ai_result = run_highlight_pipeline(
                video_path=video_path,
                output_dir=output_dir,
                yolo_model=yolo_model,
                xgb_model=xgb_model,
                highlight_count=remaining,
                exclude_intervals=exclude_intervals,
                progress_callback=progress_callback,
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

    return LogExtractResult(
        success=True,
        message=f"로그 {log_count}개 + AI {ai_count}개 클립 추출 완료",
        clip_paths=clip_paths,
        events=events_meta,
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
