"""ByteTrack with operator-color constraints; no additional model or encoder.

The geometry, XYAH Kalman filter, and assignment thresholds remain ByteTrack's.
Pinned to Ultralytics 8.4.14: its second association stage needs a private
distance-provider adapter. Never mutate the installed package or global state.
"""
from __future__ import annotations
import importlib.metadata
import types
import numpy as np
from ultralytics.trackers.byte_tracker import BYTETracker, STrack
from ultralytics.trackers.utils import matching

TEAMS = {'home': 1, 'home_gk': 1, 'away': 2, 'away_gk': 2}


def team_conflicts(tracks, detections):
    out = np.zeros((len(tracks), len(detections)), dtype=bool)
    for i, old in enumerate(tracks):
        for j, new in enumerate(detections):
            # Track-vs-track duplicate removal must retain upstream semantics.
            if old.frame_id and not new.frame_id:
                a, b = getattr(old, 'stable_team', 0), getattr(new, 'observed_team', 0)
                if a and b and a != b:
                    # Strong geometric continuity survives isolated colour noise.
                    # A distant opponent or sustained contradiction is still gated.
                    distance = float(matching.iou_distance([old], [new])[0, 0])
                    sustained = old.pending_team == b and old.pending_count >= old.confirm_frames
                    out[i, j] = distance > .45 or sustained
    return out


class TeamMemory:
    def init_team(self, team, confirm_frames=9):
        self.observed_team = team
        self.stable_team = 0
        self.pending_team = team
        self.pending_count = int(bool(team))
        self.confirm_frames = confirm_frames

    def learn_team(self, observation):
        team = observation.observed_team
        if team and team == self.pending_team:
            self.pending_count += 1
        else:
            self.pending_team, self.pending_count = team, int(bool(team))
        if not self.stable_team and self.pending_count >= 3:
            self.stable_team = team


class TeamSTrack(TeamMemory, STrack):
    def __init__(self, *args, team=0, confirm_frames=9, **kwargs):
        super().__init__(*args, **kwargs)
        self.init_team(team, confirm_frames)

    def update(self, new_track, frame_id):
        self.learn_team(new_track)
        super().update(new_track, frame_id)

    def re_activate(self, new_track, frame_id, new_id=False):
        self.learn_team(new_track)
        super().re_activate(new_track, frame_id, new_id)


class GatedDistances:
    def __getattr__(self, name):
        return getattr(matching, name)

    @staticmethod
    def iou_distance(tracks, detections):
        distances = matching.iou_distance(tracks, detections)
        distances[team_conflicts(tracks, detections)] = 1.
        return distances


gated_update = types.FunctionType(BYTETracker.update.__code__,
    {**BYTETracker.update.__globals__, 'matching': GatedDistances()},
    'gated_update', BYTETracker.update.__defaults__, BYTETracker.update.__closure__)


class ColorBYTETracker(BYTETracker):
    def __init__(self, args, *, team_gate=True, frame_rate=30, observation_fps=15):
        if importlib.metadata.version('ultralytics') != '8.4.14':
            raise RuntimeError('Revalidate the ByteTrack adapter before changing Ultralytics 8.4.14')
        super().__init__(args, frame_rate=frame_rate)
        self.team_gate = team_gate
        self.confirm_frames = max(3, round(observation_fps * .6))

    def init_track(self, results, features=None):
        if not len(results):
            return []
        # Upstream resets detection indices separately in the high/low subsets.
        # Carry the original index through the SAME masks as detections so
        # output provenance cannot point to a different person's appearance.
        bboxes = np.column_stack([results.xywh, features[:, 1]])
        return [TeamSTrack(box, score, cls, team=int(row[0]), confirm_frames=self.confirm_frames)
                for box, score, cls, row in zip(bboxes, results.conf, results.cls, features)]

    def get_dists(self, tracks, detections):
        distances = super().get_dists(tracks, detections)
        if self.team_gate:
            distances[team_conflicts(tracks, detections)] = 1.
        return distances

    def seed_teams(self, assignments):
        """Operator anchors establish a team immediately, without relearning it."""
        for track in self.tracked_stracks:
            team=assignments.get(track.track_id)
            if team in (1,2):
                track.stable_team=track.pending_team=track.observed_team=team
                track.pending_count=track.confirm_frames

    def update(self, results, teams=None):
        teams = np.zeros(len(results)) if teams is None else np.asarray(teams)
        if teams.shape != (len(results),) or not np.isin(teams, [0, 1, 2]).all():
            raise ValueError('One team code (0 unknown, 1 home, 2 away) per detection is required')
        features = np.column_stack([teams, np.arange(len(results))])
        return (gated_update if self.team_gate else BYTETracker.update)(self, results, feats=features)
