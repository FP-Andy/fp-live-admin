"""라커룸 자체전(C-21, 2026-11-11) — 반대편(B팀)도 FinePlay 선수로 매칭한다.

매니페스트에 matchKind=SCRIMMAGE + opponentLineup 이 있을 때만 분기한다. 없으면(일반 경기) 반대편은
지금처럼 익명 처리 — 회귀 테스트로 고정한다.
Run: python -m unittest discover -s apps/api/tests -p test_scrimmage_opponent_lineup.py -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import fineplay_fpa as fpa  # noqa: E402

LINEUP_A = [{"playerId": "101", "name": "김에이", "jerseyNumber": 7, "positionSlot": "player_2_1"}]
LINEUP_B = [{"playerId": "202", "name": "이비", "jerseyNumber": 7, "positionSlot": "player_2_1"},
            {"playerId": "203", "name": "박비", "jerseyNumber": 9, "positionSlot": "player_2_0"}]


def _actions():
    return [
        {"seq": 1, "action": "Pass", "baseAction": "Pass", "teamSide": "home", "jersey": "7",
         "playerId": "stale", "playerName": "옛값", "userId": 1},
        {"seq": 2, "action": "Shot", "baseAction": "Shot", "teamSide": "away", "jersey": "9",
         "playerId": "stale", "playerName": "옛값", "userId": 1},
        {"seq": 3, "action": "Pass", "baseAction": "Pass", "teamSide": "away", "jersey": "7"},
    ]


def _scene():
    rows = [
        {"Action": "Pass", "Team": "Home", "Player": "7", "SceneActionIndex": "1"},
        {"Action": "Shot", "Team": "Away", "Player": "9", "SceneActionIndex": "2"},
    ]
    return fpa.FpaScene(index=0, rows=rows, primary_row=fpa.pick_primary(rows))


class ScrimmageManifestTest(unittest.TestCase):
    def test_only_scrimmage_manifest_yields_opponent_lineup(self):
        self.assertEqual(fpa.scrimmage_opponent_lineup({"matchKind": "SCRIMMAGE", "opponentLineup": LINEUP_B}), LINEUP_B)
        self.assertIsNone(fpa.scrimmage_opponent_lineup({"opponentLineup": LINEUP_B}))  # matchKind 없음 = 일반
        self.assertIsNone(fpa.scrimmage_opponent_lineup({"matchKind": "SCRIMMAGE", "opponentLineup": []}))
        self.assertIsNone(fpa.scrimmage_opponent_lineup({"matchKind": "SCRIMMAGE"}))
        self.assertIsNone(fpa.scrimmage_opponent_lineup(None))
        self.assertIsNone(fpa.scrimmage_opponent_lineup({"lineup": LINEUP_A}))


class RematchTest(unittest.TestCase):
    def test_regular_match_keeps_opponent_anonymous(self):
        out = fpa.rematch_action_players(_actions(), our_side="home", lineup=LINEUP_A)
        self.assertEqual(out[0]["playerId"], "101")
        self.assertEqual(out[0]["userId"], 101)
        for a in out[1:]:
            self.assertIsNone(a["playerId"])
            self.assertIsNone(a["playerName"])
            self.assertIsNone(a["userId"])
            self.assertTrue(a["jersey"])  # 등번호·사이드는 남는다

    def test_scrimmage_matches_both_sides_by_their_own_lineup(self):
        out = fpa.rematch_action_players(_actions(), our_side="home", lineup=LINEUP_A, opponent_lineup=LINEUP_B)
        # 같은 7번이라도 사이드별 라인업으로 갈린다
        self.assertEqual(out[0]["playerId"], "101")
        self.assertEqual(out[1]["playerId"], "203")
        self.assertEqual(out[1]["userId"], 203)
        self.assertEqual(out[2]["playerId"], "202")
        self.assertEqual(out[2]["playerName"], "이비")


class SceneRowsTest(unittest.TestCase):
    def test_scene_rows_regular_and_scrimmage(self):
        plain = fpa.scene_action_rows(_scene(), our_side="home", lineup=LINEUP_A)
        self.assertEqual(plain[0]["playerId"], "101")
        self.assertIsNone(plain[1]["playerId"])
        scrim = fpa.scene_action_rows(_scene(), our_side="home", lineup=LINEUP_A, opponent_lineup=LINEUP_B)
        self.assertEqual(scrim[0]["playerId"], "101")
        self.assertEqual(scrim[1]["playerId"], "203")

    def test_involved_players_include_b_team_only_for_scrimmage(self):
        _, _, plain, _ = fpa.build_clip_analysis(
            _scene(), clip_team=None, our_side="home", team_labels={"home": "A", "away": "B"},
            lineup=LINEUP_A, fpa_match_id="m1")
        self.assertEqual({p["playerId"] for p in plain}, {"101"})
        _, _, scrim, _ = fpa.build_clip_analysis(
            _scene(), clip_team=None, our_side="home", team_labels={"home": "A", "away": "B"},
            lineup=LINEUP_A, fpa_match_id="m1", opponent_lineup=LINEUP_B)
        self.assertEqual({p["playerId"] for p in scrim}, {"101", "203"})


if __name__ == "__main__":
    unittest.main()
