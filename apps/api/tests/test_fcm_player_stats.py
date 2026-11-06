"""FCM 주요선수 카드 스탯 — 분석관 스탯 입력 가이드 규칙 회귀 테스트.

가이드: 골 → 어시스트 → 포지션 순서로 최대 5줄, 표기는 '스탯명 : 값', 괄호 앞 공백 없음
(어드민 카드뉴스와 같은 형식), 수비 스탯은 5줄이 넘칠 때만 ' / '로 묶는다.
"""
import ast
import io
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import Mock
from uuid import uuid4

TEMP = tempfile.TemporaryDirectory()
os.environ.setdefault('DATABASE_URL', 'sqlite:///' + str(Path(TEMP.name) / 'db.sqlite3'))
os.environ.setdefault('MPLCONFIGDIR', str(Path(tempfile.gettempdir()) / 'fpc-matplotlib-tests'))
os.environ.setdefault('XDG_CACHE_HOME', str(Path(tempfile.gettempdir()) / 'fpc-cache-tests'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pandas as pd

from app import fcm_stats
from app.fcm_stats import infer_position_from_events, position_from_slot, select_player_stats
from app.fpa import analyze_card_workbook, build_analysis_workbook, parse_logs_to_dataframe
from app.models import Match


def metrics(**values):
    base = {key: 0 for key in (
        'goals', 'assists', 'key_passes', 'shots', 'shots_on_target', 'xg', 'passes', 'passes_success',
        'forward_passes', 'crosses', 'crosses_success', 'headers', 'dribbles', 'breakthroughs',
        'intercepts', 'tackles', 'clears', 'blocks', 'duels', 'duels_won',
    )}
    base.update(values)
    return base


# 로컬 시드 (a) FC 한빛 vs 성수 유나이티드의 FPA 저장 로그(37행)에서 DualState 만 뺀 것.
# 양 팀 모두 7번이 있어(홈 7번·원정 7번) 등번호 충돌 회귀도 같이 본다.
SEED_FPA_LOG = [
    "1H | home | right | 05:04 | Pos(51.67, 23.21) | 16 Pass to 7 | Pos(71.16, 38.53) | Tags: Success, Progressive | Metrics: xRC=0.010, xPK=0.000, EPV=0.010, PC=-0.421 | Sport: FOOTBALL",
    "1H | home | right | 05:06 | Pos(71.16, 38.53) | 7 Pass to 30 | Pos(89.15, 38.68) | Tags: Success, Progressive | Metrics: xRC=0.080, xPK=0.250, EPV=0.024, PC=-0.287 | Sport: FOOTBALL",
    "1H | home | right | 05:08 | Pos(89.15, 38.68) | 30 Shot | Tags: Under Pressure, Off Target, Fail, In-box | Metrics: xG=0.080, xGOT=0.000, EPV=0.000, PC=0.629 | Sport: FOOTBALL | GoalMouth: -0.280,1.158,right",
    "1H | home | right | 10:16 | Pos(72.3, 49.52) | 19 Breakthrough | Pos(80.3, 48.45) | Tags: Success | Metrics: EPV=0.004, PC=-0.483 | Sport: FOOTBALL",
    "1H | home | right | 10:18 | Pos(80.3, 48.45) | 19 Pass to 30 | Pos(93.16, 38.94) | Tags: Assist, Success, Progressive | Metrics: xRC=0.129, xPK=0.400, EPV=0.024, PC=0.129 | Sport: FOOTBALL",
    "1H | home | right | 10:20 | Pos(93.16, 38.94) | 30 Shot | Tags: Goal, On Target, Success, In-box | Metrics: xG=0.129, xGOT=0.368, EPV=0.000, PC=0.552 | Sport: FOOTBALL | GoalMouth: 0.898,0.549,right",
    "1H | home | right | 16:09 | Pos(44.11, 24.48) | 7 Intercept | Pos(32.59, 22.28) | Tags: Success | Metrics: EPV=0.022, PC=1.278 | Sport: FOOTBALL",
    "1H | home | right | 16:11 | Pos(32.59, 22.28) | 7 Pass to 2 | Pos(47.66, 16.44) | Tags: Fail, Progressive | Metrics: xRC=0.001, xPK=0.143, EPV=0.004, PC=-0.215 | Sport: FOOTBALL",
    "1H | home | right | 21:31 | Pos(55.53, 10.2) | 16 Pass to 30 | Pos(88.84, 5.0) | Tags: Success, Progressive | Metrics: xRC=0.009, xPK=0.000, EPV=0.012, PC=-0.332 | Sport: FOOTBALL",
    "1H | home | right | 21:33 | Pos(88.84, 5.0) | 30 Cross to 15 | Pos(98.83, 39.54) | Tags: Success | Metrics: xRC=0.232, xPK=0.600, EPV=0.029, PC=-0.865 | Sport: FOOTBALL",
    "1H | home | right | 21:35 | Pos(98.83, 39.54) | 15 Shot | Tags: Header, On Target, Success, In-box | Metrics: xG=0.123, xGOT=0.118, EPV=0.000, PC=0.387 | Sport: FOOTBALL | GoalMouth: 0.360,0.060,right",
    "1H | home | right | 26:25 | Pos(16.35, 38.66) | 1 Save | Pos(3.55, 31.81) | Tags: Catch, Success, In-box | Metrics: xG=0.075, xGOT=0.336 | Sport: FOOTBALL | GoalMouth: 0.134,0.813,right",
    "1H | home | right | 31:12 | Pos(72.21, 20.22) | 19 Dribble | Pos(78.21, 16.32) | Path(72.21,20.22;78.21,16.32) | Tags: Success | Metrics: EPV=0.002, PC=-0.486 | Sport: FOOTBALL",
    "1H | home | right | 31:14 | Pos(78.21, 16.32) | 19 Pass to 2 | Pos(92.9, 25.56) | Tags: Key Pass, Success, Progressive | Metrics: xRC=0.089, xPK=0.000, EPV=0.025, PC=0.628 | Sport: FOOTBALL",
    "1H | home | right | 31:16 | Pos(92.9, 25.56) | 2 Shot | Tags: Goal, On Target, Success, In-box | Metrics: xG=0.089, xGOT=0.354, EPV=0.000, PC=0.334 | Sport: FOOTBALL | GoalMouth: 0.828,0.789,right",
    "1H | home | right | 36:53 | Pos(69.18, 45.97) |  Press | Tags: Success | Metrics: PC=0.131 | Sport: FOOTBALL",
    "1H | home | right | 36:55 | Pos(74.83, 47.08) | 27 Tackle | Pos(69.18, 45.97) | Tags: Success | Metrics: EPV=0.016, PC=0.400 | Sport: FOOTBALL",
    "1H | home | right | 42:02 | Pos(79.7, 36.5) | 27 Penetration | Pos(91.7, 42.02) | Tags: Off-ball Run, Success, Progressive | Metrics: EPV=0.018, PC=0.416 | Sport: FOOTBALL",
    "1H | home | right | 42:04 | Pos(72.24, 21.54) | 15 Pass to 27 | Pos(91.7, 42.02) | Tags: Success, Progressive | Metrics: xRC=0.083, xPK=0.000, EPV=0.025, PC=0.153 | Sport: FOOTBALL",
    "1H | home | right | 42:06 | Pos(91.7, 42.02) | 27 Shot | Tags: Blocked, Fail, In-box | Metrics: xG=0.083, EPV=0.000, PC=0.317 | Sport: FOOTBALL",
    "2H | away | right | 55:52 | Pos(50.33, 28.22) | 7 Pass to 11 | Pos(72.8, 32.17) | Tags: Success, Progressive | Metrics: xRC=0.007, xPK=0.333, EPV=0.012, PC=-1.018 | Sport: FOOTBALL",
    "2H | away | right | 55:54 | Pos(72.8, 32.17) | 11 Pass to 10 | Pos(96.02, 30.72) | Tags: Success, Progressive | Metrics: xRC=0.219, xPK=0.167, EPV=0.028, PC=0.740 | Sport: FOOTBALL",
    "2H | away | right | 55:56 | Pos(96.02, 30.72) | 10 Shot | Tags: Under Pressure, Goal, On Target, Success, In-box | Metrics: xG=0.219, xGOT=0.276, EPV=0.000, PC=0.477 | Sport: FOOTBALL | GoalMouth: 0.698,0.447,right",
    "2H | home | left | 61:24 | Pos(39.16, 36.81) | 30 Duel | Tags: Success | Metrics: EPV=0.017, PC=0.384 | Sport: FOOTBALL",
    "2H | home | left | 61:26 | Pos(39.16, 36.81) | 30 Be Fouled | Tags: Success | Metrics: EPV=0.025, PC=0.384 | Sport: FOOTBALL",
    "2H | home | left | 67:36 | Pos(53.68, 14.67) | 17 Pass to 15 | Pos(16.51, 5.0) | Tags: Success, Progressive | Metrics: xRC=0.010, xPK=0.000, EPV=0.013, PC=-0.162 | Sport: FOOTBALL",
    "2H | home | left | 67:38 | Pos(16.51, 5.0) | 15 Cross to 30 | Pos(9.54, 34.06) | Tags: Success | Metrics: xRC=0.231, xPK=0.250, EPV=0.029, PC=-0.722 | Sport: FOOTBALL",
    "2H | home | left | 67:40 | Pos(9.54, 34.06) | 30 Shot | Tags: Header, Goal, On Target, Success, In-box | Metrics: xG=0.122, xGOT=0.272, EPV=0.000, PC=0.445 | Sport: FOOTBALL | GoalMouth: 0.605,0.812,left",
    "2H | home | left | 73:12 | Pos(61.33, 39.61) | 7 Intercept | Pos(69.69, 35.36) | Tags: Success | Metrics: EPV=0.022, PC=0.766 | Sport: FOOTBALL",
    "2H | home | left | 73:14 | Pos(69.69, 35.36) | 7 Pass to 15 | Pos(54.85, 32.37) | Tags: Fail, Progressive | Metrics: xRC=0.002, xPK=0.429, EPV=0.005, PC=-0.021 | Sport: FOOTBALL",
    "2H | home | left | 79:31 | Pos(25.16, 34.59) | 7 Dribble | Pos(19.16, 36.62) | Path(25.16,34.59;19.16,36.62) | Tags: Success | Metrics: EPV=0.004, PC=-0.605 | Sport: FOOTBALL",
    "2H | home | left | 79:33 | Pos(19.16, 36.62) | 7 Pass to 2 | Pos(13.99, 41.68) | Tags: Key Pass, Success | Metrics: xRC=0.042, xPK=0.200, EPV=0.014, PC=-0.292 | Sport: FOOTBALL",
    "2H | home | left | 79:35 | Pos(13.99, 41.68) | 2 Shot | Tags: Under Pressure, Off Target, Fail, In-box | Metrics: xG=0.080, xGOT=0.000, EPV=0.000, PC=0.412 | Sport: FOOTBALL | GoalMouth: -0.130,0.923,left",
    "2H | home | left | 85:30 | Pos(50.37, 44.01) | 2 Pass to 19 | Pos(29.43, 36.08) | Tags: Success, Progressive | Metrics: xRC=0.019, xPK=0.000, EPV=0.012, PC=-1.027 | Sport: FOOTBALL",
    "2H | home | left | 85:32 | Pos(29.43, 36.08) | 19 Pass to 27 | Pos(13.11, 39.49) | Tags: Success, Progressive | Metrics: xRC=0.106, xPK=0.600, EPV=0.022, PC=0.325 | Sport: FOOTBALL",
    "2H | home | left | 85:34 | Pos(13.11, 39.49) | 27 Shot | Tags: On Target, Success, In-box | Metrics: xG=0.106, xGOT=0.166, EPV=0.000, PC=0.461 | Sport: FOOTBALL | GoalMouth: 0.367,0.288,left",
    "2H | home | left | 91:30 | Pos(81.28, 62.0) | 38 Clear | Pos(98.38, 35.91) | Tags: Success | Metrics: EPV=0.040, PC=1.770 | Sport: FOOTBALL",
]


def seed_analysis():
    df = parse_logs_to_dataframe(SEED_FPA_LOG, str(uuid4()), 'FC 한빛', '성수 유나이티드')
    # FPA 로그 반영 경로와 같다: 저장 로그 → 분석 워크북 → 카드 분석.
    return analyze_card_workbook(build_analysis_workbook(df))


def player(payload, team, number):
    return next(p for p in payload['players'] if p['team'] == team and p['player_id'] == number)


class GoalCaseTests(unittest.TestCase):
    def test_goal_order_and_format(self):
        result = select_player_stats(metrics(
            goals=2, xg=0.331, shots=3, shots_on_target=2, dribbles=2, breakthroughs=1,
            duels=4, duels_won=3, passes=10, passes_success=8, intercepts=2,
        ), 'FW')
        self.assertEqual(result['stat_case'], 'GOAL')
        self.assertEqual(result['selected'], [
            'Goal : 2골',
            '기대득점(xG) : 0.331(2골)',
            '슈팅(유효슈팅) : 3회(2회)',
            '드리블 : 2회',
            '경합 성공률(%) : 75.0%(3회)',
        ])

    def test_breakthrough_takes_the_dribble_slot_when_no_dribble(self):
        result = select_player_stats(metrics(goals=1, xg=0.2, shots=1, shots_on_target=1, breakthroughs=2, duels=1, duels_won=1), 'FW')
        self.assertEqual(result['selected'][3], '돌파 : 2회')

    def test_shot_line_is_mandatory_even_with_inconsistent_data(self):
        result = select_player_stats(metrics(goals=1), 'FW')
        self.assertIn('슈팅(유효슈팅) : 0회(0회)', result['selected'])

    def test_missing_rule_stats_fall_back_to_position_order(self):
        # 드리블/돌파·경합이 없으면 그 자리를 포지션(DF) 순서의 다음 스탯이 채운다.
        result = select_player_stats(metrics(goals=1, xg=0.1, shots=1, shots_on_target=1, intercepts=3, passes=5, passes_success=4), 'DF')
        self.assertEqual(result['selected'], [
            'Goal : 1골', '기대득점(xG) : 0.100(1골)', '슈팅(유효슈팅) : 1회(1회)', '인터셉트 : 3회', '패스 성공률(%) : 80.0%(4회)',
        ])

    def test_goal_and_assist_keeps_goal_order_and_assist_as_candidate(self):
        result = select_player_stats(metrics(goals=1, assists=1, xg=0.3, shots=2, shots_on_target=1, dribbles=1, duels=2, duels_won=1), 'FW')
        self.assertEqual(result['selected'][0], 'Goal : 1골')
        self.assertNotIn('Assist : 1도움', result['selected'])
        self.assertIn('Assist : 1도움', result['candidates'])


class AssistCaseTests(unittest.TestCase):
    def test_assist_order_and_format(self):
        result = select_player_stats(metrics(
            assists=1, key_passes=2, passes=20, passes_success=17, forward_passes=5, duels=2, duels_won=1, dribbles=3,
        ), 'MF')
        self.assertEqual(result['stat_case'], 'ASSIST')
        self.assertEqual(result['selected'], [
            'Assist : 1도움', 'Key Pass : 2회', '패스 성공률(%) : 85.0%(17회)', '전진 패스 : 5회', '경합 성공률(%) : 50.0%(1회)',
        ])

    def test_missing_key_pass_and_duel_are_skipped(self):
        result = select_player_stats(metrics(assists=1, passes=3, passes_success=3, forward_passes=1, dribbles=1, crosses=1, crosses_success=1), 'MF')
        self.assertEqual(result['selected'], [
            'Assist : 1도움', '패스 성공률(%) : 100.0%(3회)', '전진 패스 : 1회', '드리블 : 1회', '크로스 성공률(%) : 100.0%(1회)',
        ])


class PositionCaseTests(unittest.TestCase):
    SAMPLE = metrics(
        shots=2, shots_on_target=1, xg=0.25, dribbles=2, passes=12, passes_success=9, forward_passes=3,
        key_passes=1, intercepts=2, tackles=1, duels=3, duels_won=2,
    )

    def test_each_position_starts_with_its_own_stats(self):
        fw = select_player_stats(self.SAMPLE, 'FW')['selected']
        mf = select_player_stats(self.SAMPLE, 'MF')['selected']
        df = select_player_stats(self.SAMPLE, 'DF')['selected']
        self.assertEqual(fw[:3], ['기대득점(xG) : 0.250(0골)', '슈팅(유효슈팅) : 2회(1회)', '드리블 : 2회'])
        self.assertEqual(mf[:3], ['패스 성공률(%) : 75.0%(9회)', '전진 패스 : 3회', 'Key Pass : 1회'])
        # DF 는 수비 스탯이 앞이고, 5줄이 넘쳐 인터셉트·태클이 한 줄로 묶인다.
        self.assertEqual(df[0], '인터셉트 : 2회 / 태클 : 1회')
        self.assertEqual(df[1], '경합 성공률(%) : 66.7%(2회)')
        self.assertTrue(all(select_player_stats(self.SAMPLE, pos)['stat_case'] == 'POSITION' for pos in ('FW', 'MF', 'DF')))

    def test_unknown_position_uses_midfielder_order(self):
        self.assertEqual(select_player_stats(self.SAMPLE, '')['selected'], select_player_stats(self.SAMPLE, 'MF')['selected'])
        self.assertEqual(select_player_stats(self.SAMPLE, '')['position'], 'MF')


class FormatAndLimitTests(unittest.TestCase):
    RICH = metrics(
        goals=1, assists=1, key_passes=3, shots=4, shots_on_target=2, xg=1.2345, passes=30, passes_success=27,
        forward_passes=8, crosses=3, crosses_success=2, headers=1, dribbles=4, breakthroughs=2,
        intercepts=3, tackles=3, clears=3, blocks=1, duels=6, duels_won=4,
    )

    def test_spacing_decimals_and_parentheses(self):
        lines = select_player_stats(self.RICH, 'MF')['candidates']
        for line in lines:
            for part in line.split(' / '):
                self.assertRegex(part, r'^[^:]+[^ ] : [^ ].*$')
            self.assertNotIn(' (', line)
            self.assertNotIn('  ', line)
        self.assertIn('기대득점(xG) : 1.234(1골)', lines)  # 소수 3자리 + 실제 득점
        self.assertIn('크로스 성공률(%) : 66.7%(2회)', lines)  # 비율 소수 1자리 + 성공 횟수
        self.assertIn('패스 성공률(%) : 90.0%(27회)', lines)

    def test_at_most_five_lines_and_no_ball_touch(self):
        result = select_player_stats(self.RICH, 'DF')
        self.assertEqual(len(result['selected']), 5)
        self.assertFalse(any('볼 터치' in line for line in result['candidates']))
        self.assertIn('볼 터치', fcm_stats.UNSUPPORTED_STATS)

    def test_zero_stats_are_never_selected(self):
        result = select_player_stats(metrics(passes=2, passes_success=1, clears=1), 'DF')
        self.assertEqual(result['selected'], ['클리어 : 1회', '패스 성공률(%) : 50.0%(1회)'])
        self.assertFalse(any(re.search(r': 0(회|골|도움)$', line) for line in result['candidates']))

    def test_empty_player_gets_no_stats(self):
        self.assertEqual(select_player_stats(metrics(), 'MF')['selected'], [])


class DefensiveCombineTests(unittest.TestCase):
    def test_not_combined_when_five_lines_are_enough(self):
        result = select_player_stats(metrics(intercepts=3, tackles=2, passes=4, passes_success=3), 'DF')
        self.assertEqual(result['selected'], ['인터셉트 : 3회', '태클 : 2회', '패스 성공률(%) : 75.0%(3회)'])

    def test_three_defensive_stats_share_one_line_like_the_guide_example(self):
        result = select_player_stats(metrics(
            intercepts=3, blocks=3, clears=3, duels=2, duels_won=1, passes=10, passes_success=8, forward_passes=2, key_passes=1, dribbles=1,
        ), 'DF')
        # DF 순서는 인터셉트 → 태클 → 클리어 → 차단. 가이드 예시와 같은 세 개짜리 줄.
        self.assertEqual(result['selected'][0], '인터셉트 : 3회 / 클리어 : 3회 / 차단 : 3회')
        self.assertEqual(len(result['selected']), 5)
        self.assertEqual(result['selected'][1:], [
            '경합 성공률(%) : 50.0%(1회)', '패스 성공률(%) : 80.0%(8회)', '전진 패스 : 2회', 'Key Pass : 1회',
        ])

    def test_four_defensive_stats_split_two_and_two(self):
        result = select_player_stats(metrics(intercepts=3, tackles=2, clears=4, blocks=1, duels=2, duels_won=2, passes=5, passes_success=5, forward_passes=1), 'DF')
        self.assertEqual(result['selected'][:2], ['인터셉트 : 3회 / 태클 : 2회', '클리어 : 4회 / 차단 : 1회'])
        # 묶인 스탯은 후보 목록에 따로 다시 나오지 않는다.
        self.assertNotIn('인터셉트 : 3회', result['candidates'])


class PositionMappingTests(unittest.TestCase):
    def test_slot_mapping(self):
        self.assertEqual(position_from_slot('gk'), 'GK')
        self.assertEqual(position_from_slot('LCB'), 'DF')
        self.assertEqual(position_from_slot('RWB'), 'DF')
        self.assertEqual(position_from_slot('CAM'), 'MF')
        self.assertEqual(position_from_slot('ST'), 'FW')
        self.assertEqual(position_from_slot('player_0_1', formation='4-3-3'), 'DF')
        self.assertEqual(position_from_slot('player_1_0', formation='4-3-3'), 'MF')
        self.assertEqual(position_from_slot('player_2_0', formation='4-3-3'), 'FW')
        self.assertEqual(position_from_slot('player_3_0', formation='4-2-3-1'), 'FW')
        self.assertEqual(position_from_slot('player_2_0', formation='4-2-3-1'), 'MF')
        self.assertEqual(position_from_slot('player_2_0', max_line=3), 'MF')
        self.assertEqual(position_from_slot('c0_2'), 'GK')
        self.assertEqual(position_from_slot('c1_0', max_custom_row=4), 'DF')
        self.assertEqual(position_from_slot('c2_1', max_custom_row=4), 'MF')
        self.assertEqual(position_from_slot('c4_1', max_custom_row=4), 'FW')
        self.assertEqual(position_from_slot('SUB'), '')
        self.assertEqual(position_from_slot(''), '')

    def test_event_position_inference(self):
        self.assertEqual(infer_position_from_events(0.30), 'DF')
        self.assertEqual(infer_position_from_events(0.50), 'MF')
        self.assertEqual(infer_position_from_events(0.80), 'FW')
        self.assertEqual(infer_position_from_events(0.80, is_goalkeeper=True), 'GK')
        self.assertEqual(infer_position_from_events(None), '')


class WorkbookRegressionTests(unittest.TestCase):
    def test_seed_fpa_log_follows_the_guide(self):
        payload = seed_analysis()
        # 홈 30번: 2골(헤더 1골 포함). 예전 결과는 Goal 다음에 패스 성공률이 오고 xG 가 5줄에서 빠졌으며
        # 헤더는 헤딩골+헤딩 유효슈팅을 이중으로 세어 2회였다.
        striker = player(payload, 'home', '30')
        self.assertEqual(striker['selected_stats'], [
            'Goal : 2골', '기대득점(xG) : 0.331(2골)', '슈팅(유효슈팅) : 3회(2회)', '경합 성공률(%) : 100.0%(1회)', '헤더 : 1회',
        ])
        self.assertEqual(striker['candidates'][:5], striker['selected_stats'])
        # 홈 19번: 어시스트 기준.
        self.assertEqual(player(payload, 'home', '19')['selected_stats'][:4], [
            'Assist : 2도움', 'Key Pass : 2회', '패스 성공률(%) : 100.0%(3회)', '전진 패스 : 3회',
        ])
        self.assertEqual(payload['recommended_player_id'], '30')
        for item in payload['players']:
            self.assertLessEqual(len(item['selected_stats']), 5)
            for line in item['candidates']:
                self.assertNotIn('볼 터치', line)
                if not item['is_goalkeeper']:
                    self.assertNotIn(' (', line)

    def test_same_jersey_number_on_both_teams_is_not_merged(self):
        payload = seed_analysis()
        home_seven = player(payload, 'home', '7')
        away_seven = player(payload, 'away', '7')
        # 홈 7번 패스 4회(성공 2) · 원정 7번 패스 1회(성공 1). 예전에는 둘이 한 선수로 합쳐졌다.
        self.assertIn('패스 성공률(%) : 50.0%(2회)', home_seven['candidates'])
        self.assertEqual(away_seven['candidates'], ['패스 성공률(%) : 100.0%(1회)', '전진 패스 : 1회'])

    def test_goalkeeper_keeps_goalkeeper_candidates(self):
        keeper = player(seed_analysis(), 'home', '1')
        self.assertTrue(keeper['is_goalkeeper'])
        self.assertEqual(keeper['candidates'][0], '실점 : 1골')

    def test_legacy_workbook_with_team_names(self):
        rows = [
            {'No': 1, 'Player': 9, 'Team': 'FC목포', 'TeamID': 'FC목포', 'Action': 'Shot', 'Tags': 'Goal, On Target', 'xG': 0.42,
             'StartX': 95, 'StartY': 34, 'EndX': 105, 'EndY': 34, 'StartX_adj': 95, 'StartY_adj': 34, 'EndX_adj': 105, 'EndY_adj': 34, 'Distance': 10},
            {'No': 2, 'Player': 9, 'Team': 'FC강릉', 'TeamID': 'FC강릉', 'Action': 'Intercept', 'Tags': 'Success', 'xG': 0,
             'StartX': 20, 'StartY': 30, 'EndX': 25, 'EndY': 30, 'StartX_adj': 20, 'StartY_adj': 30, 'EndX_adj': 25, 'EndY_adj': 30, 'Distance': 5},
        ]
        output = io.BytesIO()
        pd.DataFrame(rows).to_excel(output, sheet_name='Data', index=False)
        payload = analyze_card_workbook(output.getvalue())
        self.assertEqual(player(payload, 'FC목포', '9')['selected_stats'][:3], ['Goal : 1골', '기대득점(xG) : 0.420(1골)', '슈팅(유효슈팅) : 1회(1회)'])
        self.assertEqual(player(payload, 'FC강릉', '9')['selected_stats'], ['인터셉트 : 1회'])


def enrich_helpers():
    # main.py 를 통째로 import 하면 워커가 뜨므로, 테스트할 함수만 꺼내 실행한다(test_goalkeeper_cards 와 같은 방식).
    source = ast.parse((Path(__file__).resolve().parents[1] / 'app/main.py').read_text())
    names = {
        '_enrich_fcm_analysis_with_lineup', '_fcm_player_side', '_fcm_fineplay_positions',
        '_sync_goalkeeper_card_stats', '_goalkeeper_fla_save_count', '_goalkeeper_fla_conceded_values',
    }
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)] + [
        node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names
    ], type_ignores=[])
    namespace = {
        're': re, 'Match': Match,
        'normalize_position': fcm_stats.normalize_position,
        'position_from_slot': fcm_stats.position_from_slot,
        'select_player_stats': fcm_stats.select_player_stats,
        '_goalkeeper_fla_shot_events': Mock(return_value=None),
        '_fineplay_job_for_fpa_match': Mock(return_value=None),
        '_fineplay_lineup_sides': Mock(return_value={}),
    }
    exec(compile(ast.fix_missing_locations(module), 'main-fcm-helpers', 'exec'), namespace)
    return namespace


class EnrichTests(unittest.TestCase):
    def setUp(self):
        self.ns = enrich_helpers()

    def test_match_lineup_position_reselects_and_sets_team_side(self):
        match = Match(id=uuid4(), name='Fixture', metadata_json={'lineups': {'teams': {'HOME': [
            {'number': '7', 'name': '홍길동', 'position': 'DF'},
        ]}}})
        enriched = self.ns['_enrich_fcm_analysis_with_lineup'](seed_analysis(), match, Mock())
        seven = player(enriched, 'home', '7')
        self.assertEqual((seven['team_side'], seven['player_name'], seven['position'], seven['position_source']), ('HOME', '홍길동', 'DF', 'lineup'))
        self.assertEqual(seven['selected_stats'][0], '인터셉트 : 2회')
        self.assertEqual(player(enriched, 'away', '7')['team_side'], 'AWAY')

    def test_fineplay_lineup_slot_is_used_when_match_has_no_lineup(self):
        self.ns['_fineplay_job_for_fpa_match'].return_value = object()
        self.ns['_fineplay_lineup_sides'].return_value = {'home': {'formation': '4-3-3', 'players': [
            {'jersey': '7', 'positionSlot': 'player_2_1'},
        ]}}
        match = Match(id=uuid4(), name='Fixture', metadata_json={})
        enriched = self.ns['_enrich_fcm_analysis_with_lineup'](seed_analysis(), match, Mock())
        seven = player(enriched, 'home', '7')
        self.assertEqual((seven['position'], seven['position_source']), ('FW', 'fineplay_lineup'))
        self.assertEqual(seven['selected_stats'][0], '드리블 : 1회')

    def test_team_name_maps_to_side(self):
        side = self.ns['_fcm_player_side']
        self.assertEqual(side('FC목포', {'home_team': 'FC목포', 'away_team': 'FC강릉'}), 'HOME')
        self.assertEqual(side('FC강릉', {'home_team': 'FC목포', 'away_team': 'FC강릉'}), 'AWAY')
        self.assertEqual(side('away', {}), 'AWAY')
        self.assertEqual(side('다른팀', {'home_team': 'FC목포'}), '')


class PlayerCardRenderTests(unittest.TestCase):
    @unittest.skipUnless(__import__('app.fcm_cards').fcm_cards.FONT_REGULAR.exists(), '카드 폰트가 없는 환경(운영 이미지는 볼륨으로 붙인다)')
    def test_long_defensive_line_is_shrunk_to_fit(self):
        from PIL import Image, ImageDraw, ImageFont
        from app import fcm_cards

        background = Path(TEMP.name) / 'bg.png'
        Image.new('RGBA', (1920, 1080), (0, 0, 0, 255)).save(background)
        line = '인터셉트 : 13회 / 태클 : 12회 / 클리어 : 14회'
        layout = fcm_cards.FcmCardLayout()
        full_size = ImageDraw.Draw(Image.new('RGB', (1, 1))).textlength(line, font=ImageFont.truetype(str(fcm_cards.FONT_REGULAR), layout.stat_font_size))
        text_x = layout.stat_x + layout.bullet_radius * 2 + layout.bullet_gap
        self.assertGreater(text_x + full_size, 1920 - 48)  # 기본 크기로는 넘친다는 전제 확인
        png = fcm_cards.build_card_image(background_path=background, player_id='5', player_name='테스트', selected_stats=[line])
        image = Image.open(io.BytesIO(png)).convert('RGB')
        self.assertEqual(image.size, (1920, 1080))
        # 오른쪽 여백(48px)에 글자 픽셀이 없어야 한다.
        right_margin = image.crop((1920 - 40, layout.stat_y, 1920, layout.stat_y + layout.stat_gap))
        self.assertEqual(right_margin.getextrema(), ((0, 0), (0, 0), (0, 0)))


if __name__ == '__main__':
    unittest.main()
