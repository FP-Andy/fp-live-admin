"""FCM 데이터 제출 미리보기(히트맵·패스맵)와 카드 생성이 같은 그림을 쓰는지.

- 히트맵·패스맵은 팀+등번호로 거른다(FPA 로그 워크북은 한 파일에 양 팀, 같은 등번호).
- 데이터 파일 선택(팀별 → 공용)은 카드 생성과 미리보기가 같은 헬퍼를 쓴다.
- FPA 로그 반영은 공용 파일 + 선택 팀의 팀별 파일을 바꾸고 다른 팀 파일은 그대로 둔다.
"""
import ast
import base64
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from typing import Any
from unittest.mock import Mock
from uuid import UUID, uuid4

TEMP = tempfile.TemporaryDirectory()
os.environ.setdefault('DATABASE_URL', 'sqlite:///' + str(Path(TEMP.name) / 'db.sqlite3'))
os.environ.setdefault('MPLCONFIGDIR', str(Path(tempfile.gettempdir()) / 'fpc-matplotlib-tests'))
os.environ.setdefault('XDG_CACHE_HOME', str(Path(tempfile.gettempdir()) / 'fpc-cache-tests'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pandas as pd
from fastapi import HTTPException, Query
from PIL import Image

from app import fcm_cards
from app.fcm_cards import _fit_to_box, _goalkeeper_event_markers, _player_rows, build_card_image, render_player_maps
from app.models import FcmSubmission, Match

MAIN_PATH = Path(__file__).resolve().parents[1] / 'app/main.py'
HELPERS = {
    '_normalize_fcm_team_side', '_fcm_workbook_path', '_fcm_shared_workbook_path', '_fcm_card_workbook_source',
    '_fcm_workbook_meta_path', '_write_fcm_workbook', '_read_fcm_workbook_meta', '_store_fcm_uploaded_workbook',
    '_store_fcm_fpa_log_workbook', '_fcm_png_base64', '_fcm_player_maps_payload', '_build_fcm_card_payload',
    'analyze_fcm_from_saved_fpa_logs',
}


def main_helpers(runtime_dir: Path) -> dict:
    """main.py 를 import 하지 않고(워커가 뜬다) 필요한 함수만 실행한다. 데코레이터는 뗀다."""
    source = ast.parse(MAIN_PATH.read_text())
    nodes = []
    for node in source.body:
        if isinstance(node, ast.FunctionDef) and node.name in HELPERS:
            node.decorator_list = []
            nodes.append(node)
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)] + nodes, type_ignores=[])
    namespace = {
        'FCM_RUNTIME_DIR': runtime_dir, 'Path': Path, 'UUID': UUID, 'Any': Any, 'json': json, 'io': io,
        'base64': base64, 'datetime': datetime, 'timezone': timezone, 'threading': threading,
        'HTTPException': HTTPException, 'Query': Query, 'Depends': lambda dependency: None,
        'get_db': None, '_require_session_user': None, 'render_player_maps': render_player_maps,
        '_fcm_player_maps_cache': {}, '_fcm_player_maps_cache_lock': threading.Lock(), '_FCM_PLAYER_MAPS_CACHE_LIMIT': 48,
        'Match': Match,
    }
    exec(compile(ast.fix_missing_locations(module), 'main-fcm-map-helpers', 'exec'), namespace)
    return namespace


def row(player, team, action='Pass', x=50.0, y=30.0, ex=70.0, ey=34.0, tags='Success'):
    return {
        'Player': player, 'Team': team, 'Action': action, 'Tags': tags,
        'StartX': x, 'StartY': y, 'EndX': ex, 'EndY': ey,
        'StartX_adj': x, 'StartY_adj': y, 'EndX_adj': ex, 'EndY_adj': ey,
    }


def workbook(rows, drop_team=False):
    df = pd.DataFrame(rows)
    if drop_team:
        df = df.drop(columns=['Team'])
    output = io.BytesIO()
    df.to_excel(output, sheet_name='Data', index=False)
    return output.getvalue()


def seed_like_rows():
    # 로컬 시드 c40e6c7f… 와 같은 모양: home 7번 7행, away 7번 1행(away 7번은 다른 자리).
    rows = [row(7, 'home', 'Pass', 20 + index * 6, 20 + index * 3, 40 + index * 6, 25 + index * 3) for index in range(6)]
    rows.append(row(7, 'home', 'Intercept', 44, 24))
    rows.append(row(7, 'away', 'Pass', 95, 60, 100, 64, 'Key Pass, Success'))
    rows += [row(30, 'home', 'Shot', 89, 38), row(30, 'home', 'Cross', 88, 5, 98, 39), row(30, 'home', 'Pass', 60, 30, 80, 34)]
    return rows


class TeamFilterTests(unittest.TestCase):
    def test_same_number_on_both_sides_is_split_by_side(self):
        df = pd.DataFrame(seed_like_rows())
        number_only, _ = _player_rows(df, '7')
        home, home_other = _player_rows(df, '7', 'HOME', 'FC 한빛')
        away, away_other = _player_rows(df, '7', 'AWAY', '성수 유나이티드')
        self.assertEqual(len(number_only), 8)  # 예전: 등번호만 → 양 팀 8행 섞임
        self.assertEqual((len(home), home_other), (7, 1))
        self.assertEqual((len(away), away_other), (1, 7))
        self.assertEqual(set(away['Team']), {'away'})

    def test_team_name_column_uses_team_name(self):
        df = pd.DataFrame([row(7, 'FC 한빛'), row(7, 'FC 한빛'), row(7, '성수 유나이티드')])
        home, other = _player_rows(df, '7', 'HOME', 'FC 한빛')
        self.assertEqual((len(home), other), (2, 1))
        # 공백·대소문자 차이는 같은 팀으로 본다.
        away, _ = _player_rows(df, '7', 'AWAY', '성수유나이티드')
        self.assertEqual(len(away), 1)

    def test_team_name_missing_from_data_keeps_old_number_only(self):
        df = pd.DataFrame([row(7, 'Hanbit'), row(7, 'Seongsu')])
        rows, other = _player_rows(df, '7', 'HOME', 'FC 한빛')
        self.assertEqual((len(rows), other), (2, 0))

    def test_without_team_column_or_team_info_filters_number_only(self):
        df = pd.DataFrame(seed_like_rows()).drop(columns=['Team'])
        self.assertEqual(len(_player_rows(df, '7', 'HOME', 'FC 한빛')[0]), 8)
        self.assertEqual(len(_player_rows(pd.DataFrame(seed_like_rows()), '7')[0]), 8)

    def test_float_player_numbers_match(self):
        df = pd.DataFrame([row(7.0, 'home'), row('7', 'home')])
        self.assertEqual(len(_player_rows(df, '7', 'HOME')[0]), 2)


class RenderRuleTests(unittest.TestCase):
    def test_maps_counts_and_side_split(self):
        data = workbook(seed_like_rows())
        home = render_player_maps(data, '7', 'HOME', 'FC 한빛')
        away = render_player_maps(data, '7', 'AWAY', '성수 유나이티드')
        self.assertEqual((home.heatmap_points, home.passes, home.key_passes, home.other_team_rows), (7, 6, 0, 1))
        self.assertIsNotNone(home.heatmap)
        self.assertIsNotNone(home.passmap)
        # 원정 7번은 1행 — 3점 미만이라 히트맵 없음, 패스맵은 있음(키패스 1).
        self.assertEqual((away.heatmap_points, away.passes, away.key_passes), (1, 1, 1))
        self.assertIsNone(away.heatmap)
        self.assertIsNotNone(away.passmap)

    def test_fewer_than_three_points_has_no_heatmap(self):
        data = workbook([row(9, 'home'), row(9, 'home')])
        maps = render_player_maps(data, '9', 'HOME')
        self.assertEqual(maps.heatmap_points, 2)
        self.assertIsNone(maps.heatmap)
        self.assertIsNone(fcm_cards._render_reference_heatmap(data, '9', 'HOME'))

    def test_no_pass_or_cross_has_no_passmap(self):
        data = workbook([row(9, 'home', 'Shot'), row(9, 'home', 'Tackle'), row(9, 'home', 'Dribble')])
        maps = render_player_maps(data, '9', 'HOME')
        self.assertEqual(maps.passes, 0)
        self.assertIsNone(maps.passmap)
        self.assertIsNotNone(maps.heatmap)

    def test_wrappers_match_combined_renderer(self):
        data = workbook(seed_like_rows())
        maps = render_player_maps(data, '7', 'HOME', 'FC 한빛')
        heat = fcm_cards._render_reference_heatmap(data, '7', 'HOME', 'FC 한빛')
        self.assertEqual(heat.tobytes(), maps.heatmap.tobytes())
        old_style = fcm_cards._render_reference_heatmap(data, '7')  # 팀 없이 = 예전 동작(8행)
        self.assertNotEqual(old_style.tobytes(), maps.heatmap.tobytes())

    def test_goalkeeper_markers_use_team_and_number(self):
        rows = [row(1, 'home', 'Save', 10, 30), row(1, 'away', 'Save', 95, 30), row(1, 'away', 'Save', 95, 40)]
        rows.append(row(9, 'away', 'Goal', 90, 34))
        saves, conceded = _goalkeeper_event_markers(workbook(rows), '1', None, team_side='HOME', team_name='')
        self.assertEqual(len(saves), 1)
        self.assertEqual(len(conceded), 1)  # 원정 9번 골은 홈 골키퍼 실점
        saves_old, _ = _goalkeeper_event_markers(workbook(rows), '1', None)
        self.assertEqual(len(saves_old), 3)


class WorkbookFileTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.runtime = Path(self.dir.name)
        self.ns = main_helpers(self.runtime)
        self.match_id = uuid4()

    def tearDown(self):
        self.dir.cleanup()

    def path(self, name):
        return self.runtime / f'{self.match_id}_{name}.xlsx'

    def test_source_prefers_team_file_then_shared(self):
        source = self.ns['_fcm_card_workbook_source']
        self.assertEqual(source(self.match_id, 'HOME'), (None, None))
        self.path('shared').write_bytes(b'shared')
        self.assertEqual(source(self.match_id, 'HOME'), (self.path('shared'), 'shared'))
        self.path('home').write_bytes(b'home')
        self.assertEqual(source(self.match_id, 'HOME'), (self.path('home'), 'team'))
        self.assertEqual(source(self.match_id, 'AWAY'), (self.path('shared'), 'shared'))

    def test_fpa_log_replaces_selected_team_file_and_keeps_other_team(self):
        for name in ('shared', 'home', 'away'):
            self.path(name).write_bytes(f'old-{name}'.encode())
        self.ns['_store_fcm_fpa_log_workbook'](self.match_id, b'new-log', 'HOME')
        self.assertEqual(self.path('shared').read_bytes(), b'new-log')
        self.assertEqual(self.path('home').read_bytes(), b'new-log')
        self.assertEqual(self.path('away').read_bytes(), b'old-away')
        meta = self.ns['_read_fcm_workbook_meta'](self.path('home'))
        self.assertEqual(meta['origin'], 'fpa_log')
        self.assertIsNone(meta['filename'])
        self.assertTrue(meta['written_at'].endswith('+00:00'))
        self.assertIsNone(self.ns['_read_fcm_workbook_meta'](self.path('away')))

    def test_fpa_log_without_team_keeps_old_behavior(self):
        self.path('home').write_bytes(b'old-home')
        self.ns['_store_fcm_fpa_log_workbook'](self.match_id, b'new-log', None)
        self.assertEqual(self.path('shared').read_bytes(), b'new-log')
        self.assertEqual(self.path('home').read_bytes(), b'old-home')
        self.assertFalse(self.path('away').exists())

    def test_upload_writes_shared_and_team_with_filename_meta(self):
        self.ns['_store_fcm_uploaded_workbook'](self.match_id, b'up', 'away', '3R_FPA.xlsx')
        self.assertEqual(self.path('shared').read_bytes(), b'up')
        self.assertEqual(self.path('away').read_bytes(), b'up')
        self.assertFalse(self.path('home').exists())
        meta = self.ns['_read_fcm_workbook_meta'](self.path('away'))
        self.assertEqual((meta['origin'], meta['filename']), ('upload', '3R_FPA.xlsx'))
        self.assertTrue((self.runtime / f'{self.match_id}_away.meta.json').exists())

    def test_analyze_fpa_logs_endpoint_passes_selected_team(self):
        build = Mock(return_value=b'log-workbook')
        self.ns.update({
            'FpaSavedLog': object, '_build_fpa_workbook_from_saved_log': build,
            'analyze_card_workbook': Mock(return_value={'players': []}),
            '_enrich_fcm_analysis_with_lineup': Mock(side_effect=lambda payload, match, db: payload),
        })
        self.path('away').write_bytes(b'away-upload')
        db = Mock()
        db.get.return_value = Mock()
        self.ns['analyze_fcm_from_saved_fpa_logs'](self.match_id, team_side='home', db=db, _user=None)
        self.assertEqual(self.path('home').read_bytes(), b'log-workbook')
        self.assertEqual(self.path('shared').read_bytes(), b'log-workbook')
        self.assertEqual(self.path('away').read_bytes(), b'away-upload')
        with self.assertRaises(HTTPException):
            self.ns['analyze_fcm_from_saved_fpa_logs'](self.match_id, team_side='both', db=db, _user=None)

    def test_player_maps_payload(self):
        payload = self.ns['_fcm_player_maps_payload']
        empty = payload(self.match_id, 'HOME', '7', 'FC 한빛')
        self.assertIsNone(empty['source'])
        self.assertIsNone(empty['heatmap_png'])
        self.ns['_store_fcm_fpa_log_workbook'](self.match_id, workbook(seed_like_rows()), 'HOME')
        home = payload(self.match_id, 'HOME', '7', 'FC 한빛')
        self.assertEqual(home['source']['kind'], 'team')
        self.assertEqual(home['source']['origin'], 'fpa_log')
        self.assertEqual((home['heatmap_points'], home['passes'], home['same_number_other_team']), (7, 6, True))
        expected = render_player_maps(workbook(seed_like_rows()), '7', 'HOME', 'FC 한빛').heatmap
        decoded = Image.open(io.BytesIO(base64.b64decode(home['heatmap_png']))).convert('RGBA')
        self.assertEqual(decoded.size, expected.size)
        self.assertEqual(decoded.tobytes(), expected.tobytes())
        away = payload(self.match_id, 'AWAY', '7', '성수 유나이티드')
        self.assertEqual(away['source']['kind'], 'shared')
        self.assertIsNone(away['heatmap_png'])
        self.assertIsNotNone(away['passmap_png'])
        self.assertEqual(away['card_type_hint'], 'PLAYER')
        # 같은 파일·같은 선수는 캐시에서 돌려준다.
        self.assertEqual(payload(self.match_id, 'HOME', '7', 'FC 한빛')['heatmap_png'], home['heatmap_png'])
        self.assertEqual(len(self.ns['_fcm_player_maps_cache']), 2)

    def test_old_file_without_meta_has_no_origin(self):
        self.path('shared').write_bytes(workbook(seed_like_rows()))
        result = self.ns['_fcm_player_maps_payload'](self.match_id, 'HOME', '30', 'FC 한빛')
        self.assertEqual(result['source']['kind'], 'shared')
        self.assertIsNone(result['source']['origin'])
        self.assertEqual(result['heatmap_points'], 3)

    def test_card_payload_passes_team_and_uses_same_source(self):
        self.ns['_store_fcm_fpa_log_workbook'](self.match_id, b'home-log', 'HOME')
        render = Mock(return_value=b'png')
        self.ns.update({
            '_find_registered_template_path': Mock(return_value=None),
            'find_template_path': Mock(return_value=Path('/tmp/bg.png')),
            'GOALKEEPER_TEMPLATE_PATH': Path('/tmp/gk.png'),
            '_fcm_team_logo_path': Mock(return_value=None),
            '_goalkeeper_fla_shot_events': Mock(return_value=None),
            '_sync_goalkeeper_card_stats': Mock(side_effect=lambda stats, events: stats),
            'build_card_image': render,
        })
        db = Mock()
        db.get.return_value = Match(id=self.match_id, name='Fixture', metadata_json={})
        submission = FcmSubmission(
            id=uuid4(), match_id=self.match_id, competition_class='DEMO', team_side='HOME', team_name='FC 한빛',
            player_id='7', player_name='검증', card_type='PLAYER', selected_stats=['Goal : 1골'], penalty_shootout=[],
        )
        self.ns['_build_fcm_card_payload'](db, submission, 'DEMO', 1)
        kwargs = render.call_args.kwargs
        self.assertEqual((kwargs['team_side'], kwargs['team_name']), ('HOME', 'FC 한빛'))
        self.assertEqual(kwargs['workbook_bytes'], b'home-log')
        submission.team_side = 'AWAY'
        submission.card_type = 'GOALKEEPER'
        self.ns['_build_fcm_card_payload'](db, submission, 'DEMO', 1)
        kwargs = render.call_args.kwargs
        self.assertEqual(kwargs['team_side'], 'AWAY')
        self.assertEqual(kwargs['workbook_bytes'], b'home-log')  # 원정 팀별 파일 없음 → 공용 파일


@unittest.skipUnless(fcm_cards.FONT_REGULAR.exists() and fcm_cards.FONT_BOLD.exists(), '카드 폰트가 없는 환경(운영 이미지는 볼륨으로 붙인다)')
class CardPixelTests(unittest.TestCase):
    def test_card_map_boxes_equal_preview_images(self):
        background = Path(TEMP.name) / 'bg.png'
        Image.new('RGBA', (1920, 1080), (12, 40, 30, 255)).save(background)
        data = workbook(seed_like_rows())
        png = build_card_image(
            background_path=background, player_id='7', player_name='검증', selected_stats=['Goal : 1골'],
            workbook_bytes=data, team_side='HOME', team_name='FC 한빛',
        )
        card = Image.open(io.BytesIO(png)).convert('RGBA')
        maps = render_player_maps(data, '7', 'HOME', 'FC 한빛')
        layout = fcm_cards.FcmCardLayout()
        base = Image.open(background).convert('RGBA')
        for image, box in ((maps.heatmap, layout.heatmap_box), (maps.passmap, layout.passmap_box)):
            x, y, w, h = box
            expected = base.crop((x, y, x + w, y + h))
            expected.alpha_composite(_fit_to_box(image, box))
            self.assertEqual(card.crop((x, y, x + w, y + h)).tobytes(), expected.tobytes())


if __name__ == '__main__':
    unittest.main()
