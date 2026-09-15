"""Regression coverage for FPA/FLA goalkeeper candidates and final PNG input."""
import ast
import io
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from datetime import datetime
from unittest.mock import Mock
from uuid import uuid4

TEMP = tempfile.TemporaryDirectory()
os.environ.setdefault('DATABASE_URL', 'sqlite:///' + str(Path(TEMP.name) / 'db.sqlite3'))
os.environ.setdefault('MPLCONFIGDIR', str(Path(tempfile.gettempdir()) / 'fpc-matplotlib-tests'))
os.environ.setdefault('XDG_CACHE_HOME', str(Path(tempfile.gettempdir()) / 'fpc-cache-tests'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pandas as pd
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session
from app.fpa import analyze_card_workbook
from app.fcm_cards import GOALKEEPER_TEMPLATE_PATH, build_card_image
from app.models import CompetitionClass, Event, Match, FcmSubmission
from app.db import Base


@compiles(JSONB, 'sqlite')
def jsonb_as_json(element, compiler, **kw):
    return 'JSON'


def main_helpers():
    # Execute the production helpers without starting the unrelated video and
    # broadcast workers in main.py. Database queries and rendering remain real.
    source = ast.parse((Path(__file__).resolve().parents[1] / 'app/main.py').read_text())
    names = {
        '_goalkeeper_fla_shot_events', '_goalkeeper_fla_save_count',
        '_goalkeeper_fla_conceded_values',
        '_sync_goalkeeper_card_stats', '_enrich_fcm_analysis_with_lineup',
        '_build_fcm_card_payload', '_serialize_fcm_submission',
    }
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)] + [
        node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names
    ], type_ignores=[])
    namespace = {'re': re, 'Event': Event, 'Match': Match}
    exec(compile(ast.fix_missing_locations(module), 'main-goalkeeper-helpers', 'exec'), namespace)
    return namespace


def workbook(*, canonical=False, keeper_side='away', off_target=False, keeper_only=False):
    opponent = 'home' if keeper_side == 'away' else 'away'
    actions = [('Save', '', 0, keeper_side, 31), ('Catching', '', 0, keeper_side, 31)]
    if not keeper_only:
        actions += [
            ('Shot' if canonical else 'Goal', 'Goal' if canonical else '', .194, opponent, 7),
            ('Shot' if canonical else 'Shot On Target', 'On Target' if canonical else '', .706, opponent, 7),
            ('Shot' if canonical else 'Shot On Target', 'On Target' if canonical else '', .7, opponent, 7),
            ('Shot' if canonical else 'Blocked Shot', 'Blocked' if canonical else '', .5, opponent, 7),
            # Own-team xG and a non-shot defensive block must not be conceded.
            ('Goal', '', .75, keeper_side, 9),
            ('Block', '', .9, opponent, 5),
        ]
    if off_target:
        actions.append(('Shot', 'Off Target', .2, opponent, 7))
    rows = [{
        'No': index, 'Player': player, 'Team': side, 'TeamID': side,
        'Action': action, 'Tags': tags, 'xG': xg, 'Distance': 15,
        'StartX': 85, 'StartY': 34, 'EndX': 100, 'EndY': 34,
        'StartX_adj': 85, 'StartY_adj': 34, 'EndX_adj': 100, 'EndY_adj': 34,
    } for index, (action, tags, xg, side, player) in enumerate(actions, 1)]
    output = io.BytesIO()
    pd.DataFrame(rows).to_excel(output, sheet_name='Data', index=False)
    return output.getvalue()


class WorkbookTests(unittest.TestCase):
    def test_legacy_and_canonical_non_goal_shots_are_conceded_for_both_sides(self):
        for canonical in (False, True):
            for side in ('home', 'away'):
                with self.subTest(canonical=canonical, side=side):
                    data = analyze_card_workbook(workbook(canonical=canonical, keeper_side=side))
                    keeper = next(p for p in data['players'] if p['player_id'] == '31')
                    self.assertTrue(keeper['is_goalkeeper'])
                    self.assertIn('기대 실점(xG) : 2.100 (1골)', keeper['candidates'])

    def test_off_target_xg_is_included_and_keeper_only_workbook_stays_zero(self):
        for options, expected in [({'off_target': True}, '2.300 (1골)'), ({'keeper_only': True}, '0.000 (0골)')]:
            keeper = next(p for p in analyze_card_workbook(workbook(**options))['players'] if p['player_id'] == '31')
            self.assertIn('기대 실점(xG) : ' + expected, keeper['candidates'])


class FlaCardTests(unittest.TestCase):
    def setUp(self):
        self.ns = main_helpers()
        self.sync = self.ns['_sync_goalkeeper_card_stats']
        self.stats = ['실점 : 1골', '기대 실점(xG) : 0.194 (1골)', '선방 : 6회 (승부차기 : 1회)', '캐칭 : 13회', '펀칭 : 3회']
        self.events = [
            {'xg': .194, 'is_goal': True, 'is_on_target': True, 'goalmouth_x': .7, 'goalmouth_y': .4},
            {'xg': .706, 'is_goal': False, 'is_on_target': True, 'goalmouth_x': .3, 'goalmouth_y': .6},
            {'xg': .7, 'is_goal': False, 'is_on_target': False},
            {'xg': .5, 'is_goal': False, 'is_on_target': False},
        ]

    def test_positive_partial_xg_is_replaced_and_penalty_detail_preserved(self):
        result = self.sync(self.stats, self.events)
        self.assertEqual(result[1], '기대 실점(xG) : 2.100 (1골)')
        self.assertRegex(result[2], r'선방\s*:?\s*1회 \(승부차기 : 1회\)')
        self.assertEqual(result[3:], self.stats[3:])

    def test_missing_fla_preserves_excel_but_explicit_zero_clears_old_values(self):
        self.assertEqual(self.sync(self.stats, None), self.stats)
        zero = self.sync(self.stats, [])
        self.assertEqual(zero[:2], ['실점 : 0골', '기대 실점(xG) : 0.000 (0골)'])

    def test_export_preserves_five_user_selected_stats_without_adding_a_sixth(self):
        stats = self.stats[:2] + ['패스 성공률(%) : 70% (7회)'] + self.stats[3:]
        result = self.sync(stats, self.events)
        self.assertEqual(len(result), 5)
        self.assertEqual(result[2:], stats[2:])

    def test_query_excludes_own_team_non_shots_and_other_matches(self):
        engine = create_engine('sqlite://')
        Base.metadata.create_all(engine, tables=[model.__table__ for model in (CompetitionClass, Match, Event)])
        match_id, other_id = uuid4(), uuid4()
        with Session(engine) as db:
            db.add_all([Match(id=match_id, name='Fixture'), Match(id=other_id, name='Other')])
            db.flush()
            query = self.ns['_goalkeeper_fla_shot_events']
            self.assertIsNone(query(db, match_id, 'AWAY'))
            for index, event in enumerate(self.events):
                db.add(Event(id=uuid4(), match_id=match_id, type='XG', team='HOME', clock_ms=index, **event))
            db.add(Event(id=uuid4(), match_id=match_id, type='ATTACK', team='HOME', clock_ms=5, xg=9))
            db.add(Event(id=uuid4(), match_id=other_id, type='XG', team='HOME', clock_ms=5, xg=9))
            db.flush()
            self.assertEqual(query(db, match_id, 'HOME'), [])
            away = query(db, match_id, 'AWAY')
            self.assertEqual(len(away), 4)
            self.assertAlmostEqual(sum(e['xg'] for e in away), 2.1)
        engine.dispose()

    def test_analysis_and_existing_submission_png_use_same_latest_fla_values(self):
        self.ns['_goalkeeper_fla_shot_events'] = Mock(return_value=self.events)
        match = Match(id=uuid4(), name='Fixture', metadata_json={})
        payload = {'players': [{'player_id': '31', 'team': 'away', 'is_goalkeeper': True, 'candidates': self.stats}]}
        enriched = self.ns['_enrich_fcm_analysis_with_lineup'](payload, match, Mock())
        render = Mock(wraps=build_card_image)
        self.ns.update({
            '_normalize_competition_class': lambda value: value,
            '_find_registered_template_path': Mock(return_value=None),
            '_fcm_workbook_path': Mock(return_value=Path(TEMP.name) / 'absent.xlsx'),
            '_fcm_shared_workbook_path': Mock(return_value=Path(TEMP.name) / 'absent.xlsx'),
            '_fcm_team_logo_path': Mock(return_value=None),
            'GOALKEEPER_TEMPLATE_PATH': GOALKEEPER_TEMPLATE_PATH,
            'build_card_image': render,
        })
        db = Mock()
        db.get.return_value = match
        submission = FcmSubmission(id=uuid4(), match_id=match.id, competition_class='DEMO', team_side='AWAY', team_name='테스트팀', player_id='31', player_name='검증 선수', card_type='GOALKEEPER', selected_stats=self.stats, created_at=datetime(2026, 9, 15), updated_at=datetime(2026, 9, 15))
        serialized = self.ns['_serialize_fcm_submission'](submission, db)
        filename, png = self.ns['_build_fcm_card_payload'](db, submission, 'DEMO', 1)
        self.assertEqual(render.call_args.kwargs['selected_stats'], enriched['players'][0]['candidates'])
        self.assertEqual(render.call_args.kwargs['selected_stats'], serialized['selected_stats'])
        self.assertEqual(submission.selected_stats, self.stats)
        self.assertIn('2.100', render.call_args.kwargs['selected_stats'][1])
        self.assertEqual(Image.open(io.BytesIO(png)).size, (1920, 1080))
        self.assertTrue(filename.endswith('.png'))


if __name__ == '__main__':
    unittest.main()
