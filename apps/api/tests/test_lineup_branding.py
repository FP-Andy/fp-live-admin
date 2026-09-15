"""Regression checks for KFA visual order and live Broadcast branding."""
import ast
import io
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from datetime import datetime
from unittest.mock import patch
from uuid import uuid4

TEMP = tempfile.TemporaryDirectory()
os.environ.setdefault('DATABASE_URL', 'sqlite:///' + str(Path(TEMP.name) / 'branding.sqlite3'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from app.auth import require_session_user
from app.branding_refresh import BrandingRefreshQueue
from app.db import Base, get_db
from app.lineup_pdf import parse_kfa_layout, parse_lineup_pdf
from app.models import CompetitionClass, Match, TeamLogo, User
from app.team_branding import create_team_logo_router, mark_manual_branding, match_team_names, reset_branding, resolve_branding, team_logo_urls

@compiles(JSONB, 'sqlite')
def jsonb_as_json(element, compiler, **kw):
    return 'JSON'

def two_columns(left, right):
    return left.ljust(80) + right

LAYOUT = '\n'.join([
    '홈구단FC     1   0   연장전반   0   0     원정구단',
    '필드 [상의]초록 [하의]초록 [양말]초록     필드 [상의]하늘 [하의]흰색 [양말]흰색',
    'GK [상의]노랑 [하의]노랑 [양말]노랑     GK [상의]보라 [하의]보라 [양말]밝은빨강',
    two_columns('선발출전선수', '선발출전선수'),
    two_columns('81 GK 홈선수  1', '51 GK 원정선수  1'),
    two_columns('5 M F 홈필드 (주장)  2', '7 FW 원정필드  2'),
    two_columns('후보선수', '후보선수'),
    two_columns('9 FW 홈후보  3', '10 MF 원정후보  3'),
    two_columns('교체선수', '교체선수'),
    two_columns('81 GK 중복  4', '51 GK 중복  4'),
])

class LineupTests(unittest.TestCase):
    def test_visual_columns_and_kit_parts(self):
        data = parse_kfa_layout([LAYOUT])
        self.assertEqual(data['team_names'], {'HOME': '홈구단FC', 'AWAY': '원정구단'})
        self.assertEqual([p['number'] for p in data['teams']['HOME']], ['5', '9', '81'])
        self.assertEqual(sum(p['starter'] for p in data['teams']['HOME']), 2)
        self.assertEqual(data['teams']['HOME'][0]['position'], 'MF')
        self.assertEqual(data['uniforms']['HOME']['field']['shirt']['hex'], '#15803d')
        self.assertEqual(data['uniforms']['AWAY']['goalkeeper']['socks']['label'], '밝은빨강')

    def test_pdf_object_order_does_not_determine_home(self):
        class Page:
            def extract_text(self, **kwargs):
                return LAYOUT if kwargs.get('extraction_mode') == 'layout' else '원정선수 먼저 나오는 PDF 내부 순서'
        class Reader:
            pages = [Page()]
        with patch('app.lineup_pdf.PdfReader', return_value=Reader()):
            self.assertEqual(parse_lineup_pdf(b'%PDF-1.7')['teams']['HOME'][-1]['name'], '홈선수')

    def test_team_match_and_manual_orientation_move_kits_together(self):
        automatic = parse_kfa_layout([LAYOUT], expected_teams={'HOME': '원정 구단 FC', 'AWAY': '홈구단'})
        manual = parse_kfa_layout([LAYOUT], first_team_side='AWAY')
        for data in (automatic, manual):
            self.assertEqual(data['team_names']['HOME'], '원정구단')
            self.assertEqual(data['uniforms']['HOME']['field']['shirt']['hex'], '#87ceeb')
        self.assertEqual(automatic['detected_by'], 'team_names')
        self.assertEqual(manual['detected_by'], 'manual')

    def test_unknown_colours_are_preserved_without_inventing_hex(self):
        data = parse_kfa_layout([LAYOUT.replace('[상의]초록', '[상의]진한청록/흰색')])
        part = data['uniforms']['HOME']['field']['shirt']
        self.assertEqual(part['colors'], ['진한청록', '흰색'])
        self.assertIsNone(part['hex'])

    def test_unreadable_duplicate_or_one_sided_roster_fails(self):
        for pages in [[''], [LAYOUT.replace('51 GK 원정선수  1', '').replace('7 FW 원정필드  2', '').replace('10 MF 원정후보  3', '')], [LAYOUT.replace('9 FW 홈후보', '81 FW 홈후보')]]:
            with self.assertRaises(ValueError):
                parse_kfa_layout(pages)
        with self.assertRaises(ValueError):
            parse_lineup_pdf(b'not a PDF')
        with self.assertRaises(ValueError):
            parse_lineup_pdf(b'x' * (20 * 1024 * 1024 + 1))

    def test_main_swap_keeps_team_names_and_uniforms_aligned(self):
        # Exercise the existing production helper without starting unrelated
        # media workers or requiring the production PostgreSQL service.
        source = ast.parse((Path(__file__).resolve().parents[1] / 'app/main.py').read_text())
        names = {'_swap_lineup_sides', '_lineup_sort_key', '_empty_lineup'}
        module = ast.Module(body=[node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
        import re
        namespace = {'Match': Match, 'datetime': datetime, 'HTTPException': HTTPException, 're': re}
        exec(compile(module, 'main-lineup-helpers', 'exec'), namespace)
        match = Match(name='Example', metadata_json={'lineups': parse_kfa_layout([LAYOUT])})
        swapped = namespace['_swap_lineup_sides'](match)
        self.assertEqual(swapped['team_names']['HOME'], '원정구단')
        self.assertEqual(swapped['uniforms']['HOME']['field']['shirt']['hex'], '#87ceeb')

class BrandingTests(unittest.TestCase):
    def setUp(self):
        self.metadata = {'lineups': parse_kfa_layout([LAYOUT])}

    def test_pdf_and_registry_defaults_update_after_state_is_saved(self):
        state = resolve_branding(self.metadata, {'HOME': '/crest-v1.png'})
        self.metadata['broadcast'] = {**state, 'scoreboard_visible': False}
        self.metadata['lineups']['uniforms']['HOME']['field']['shirt']['hex'] = '#2158e8'
        newer = resolve_branding(self.metadata, {'HOME': '/crest-v2.png'})
        self.assertEqual(newer['home_color'], '#2158e8')
        self.assertEqual(newer['home_logo_url'], '/crest-v2.png')
        self.assertEqual(newer['branding_sources']['home_color'], 'pdf')
        self.assertEqual(resolve_branding(self.metadata, {})['home_logo_url'], '')

    def test_manual_branding_wins_until_reset(self):
        state = resolve_branding(self.metadata, {'HOME': '/crest.png'})
        changes = {'home_color': '#ff7400', 'home_logo_url': '/manual.png'}
        self.metadata['broadcast'] = mark_manual_branding({**state, **changes, 'home_score': 3}, changes)
        state = resolve_branding(self.metadata, {'HOME': '/new-crest.png'})
        self.assertEqual(state['home_color'], '#ff7400')
        self.assertEqual(state['home_logo_url'], '/manual.png')
        reset = reset_branding(self.metadata)
        self.assertEqual(reset['broadcast']['home_score'], 3)
        self.assertEqual(resolve_branding(reset, {'HOME': '/new.png'})['home_logo_url'], '/new.png')
        self.assertEqual(resolve_branding(reset)['home_color'], '#15803d')

    def test_legacy_manual_and_default_palette_migrate_safely(self):
        self.metadata['broadcast'] = {'home_color': '#ff7900', 'away_color': '#112233', 'home_logo_url': '/existing.png'}
        state = resolve_branding(self.metadata, {'HOME': '/new.png'})
        self.assertEqual(state['home_color'], '#15803d')
        self.assertEqual(state['away_color'], '#112233')
        self.assertEqual(state['home_logo_url'], '/existing.png')

class TeamLogoApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = create_engine('sqlite:///' + str(Path(self.temp.name) / 'db.sqlite3'), pool_size=2, max_overflow=0, pool_timeout=.25)
        self.session = sessionmaker(self.engine)
        tables = [model.__table__ for model in (User, CompetitionClass, Match, TeamLogo)]
        Base.metadata.create_all(self.engine, tables=tables)
        self.changed = []
        self.branding_changed = self.changed.extend
        self.app = FastAPI()
        self.app.include_router(create_team_logo_router(Path(self.temp.name) / 'logos', lambda ids: self.branding_changed(ids)))
        def db_override():
            with self.session() as db:
                yield db
        self.app.dependency_overrides[get_db] = db_override
        self.client = TestClient(self.app)
        self.match_id = uuid4()
        with self.session() as db:
            db.add(CompetitionClass(code='K3', name='K3'))
            db.add(CompetitionClass(code='K4', name='K4'))
            db.add(Match(id=self.match_id, name='[K3 | 1R] 홈구단 FC vs 원정구단', competition_class='K3', metadata_json={}))
            db.commit()
        output = io.BytesIO()
        Image.new('RGBA', (64, 64), (255, 116, 0, 255)).save(output, format='PNG')
        self.image = output.getvalue()

    def tearDown(self):
        self.client.close(); self.engine.dispose(); self.temp.cleanup()

    def login(self):
        self.app.dependency_overrides[require_session_user] = lambda: User(id='qa-admin', name='QA', role='SUPERADMIN')

    def upload(self, name='홈구단FC', competition='K3', payload=None):
        return self.client.post('/api/fcm/team-logos', data={'competition_class': competition, 'team_name': name}, files={'file': ('crest.png', self.image if payload is None else payload, 'image/png')})

    def test_auth_required_for_reads_writes_and_delete(self):
        # Override the nested session resolver to avoid querying unrelated
        # authentication tables; production auth boundaries have their own suite.
        from app.auth import get_session_user
        self.app.dependency_overrides[get_session_user] = lambda: None
        self.assertEqual(self.client.get('/api/fcm/team-logos').status_code, 401)
        self.assertEqual(self.upload().status_code, 401)
        self.assertEqual(self.client.delete(f'/api/fcm/team-logos/{uuid4()}').status_code, 401)

    def test_logo_upsert_matching_competition_and_refresh(self):
        self.login()
        first = self.upload().json()
        self.assertIn(self.match_id, self.changed)
        second = self.upload('홈 구단 FC').json()
        self.assertEqual(first['id'], second['id'])
        self.assertNotEqual(first['logo_url'], second['logo_url'])
        self.assertEqual(len(self.client.get('/api/fcm/team-logos').json()), 1)
        with self.session() as db:
            match = db.get(Match, self.match_id)
            self.assertEqual(team_logo_urls(match)['HOME'], second['logo_url'])
            match.competition_class = 'K4'
            self.assertEqual(team_logo_urls(match)['HOME'], '')
        response = self.client.delete('/api/fcm/team-logos/' + second['id'])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get('/api/fcm/team-logos').json(), [])
        self.assertTrue((Path(self.temp.name) / 'logos' / Path(first['logo_url']).name).exists())

    def test_invalid_files_and_unknown_competitions_are_rejected(self):
        self.login()
        for response in (self.upload(payload=b'<svg/>'), self.upload(payload=b'x' * (5 * 1024 * 1024 + 1)), self.upload(competition='UNKNOWN'), self.upload(name='   ')):
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get('/api/fcm/team-logos').json(), [])

    def test_large_club_logo_upload_keeps_api_available_with_two_connections(self):
        self.login()
        with self.session() as db:
            db.add_all([Match(id=uuid4(), name='홈구단 FC vs 원정구단', competition_class='K3', metadata_json={}) for _ in range(79)])
            db.commit()
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()

        def render(match_id):
            with self.session() as db:
                db.get(Match, match_id)
                entered.set()
                release.wait(5)
            finished.set()

        queue = BrandingRefreshQueue(render, debounce_seconds=0)
        self.branding_changed = lambda ids: [queue.submit(mid) for mid in ids]
        try:
            self.assertEqual(self.upload().status_code, 200)
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.engine.pool.checkedout(), 1)
            # Historical rendering is deliberately blocked, with just one spare
            # connection for normal logo reads and subsequent uploads.
            for _ in range(3):
                self.assertEqual(self.client.get('/api/fcm/team-logos').status_code, 200)
                self.assertEqual(self.upload().status_code, 200)
            self.assertEqual(self.engine.pool.checkedout(), 1)
        finally:
            queue.close()
            release.set()
            self.assertTrue(finished.wait(2))

    def test_production_pdf_upload_and_broadcast_state_flow(self):
        from fastapi import Body, Depends, File, Form, UploadFile
        from fastapi.concurrency import run_in_threadpool
        from sqlalchemy.orm import Session
        from uuid import UUID
        import re
        source = ast.parse((Path(__file__).resolve().parents[1] / 'app/main.py').read_text())
        names = {'_default_broadcast_state', '_broadcast_state', '_broadcast_clock_ms', '_team_names_from_match',
                 '_parse_lineup_pdf', 'upload_match_lineup_pdf', 'put_broadcast_state', '_require_match_not_archived',
                 '_require_write_lock', '_resolve_user_id', '_is_superuser'}
        namespace = dict(app=self.app, Match=Match, User=User, UUID=UUID, Session=Session, File=File, Form=Form,
                         Depends=Depends, Body=Body, UploadFile=UploadFile, HTTPException=HTTPException,
                         get_db=get_db, _require_session_user=require_session_user, run_in_threadpool=run_in_threadpool,
                         datetime=datetime, re=re, parse_lineup_pdf=parse_lineup_pdf, match_team_names=match_team_names,
                         resolve_branding=resolve_branding, team_logo_urls=team_logo_urls, mark_manual_branding=mark_manual_branding,
                         reset_branding=reset_branding, _normalize_sport=lambda sport: sport or 'FOOTBALL',
                         _is_superuser=lambda user_id: user_id == 'qa-admin', _broadcast_snapshot_cache={},
                         _queue_broadcast_branding_refresh=lambda match_id: self.changed.append(match_id),
                         _on_team_branding_changed=lambda ids: self.changed.extend(ids),
                         _serialize_match=lambda match: {'id': str(match.id), 'metadata': match.metadata_json})
        nodes = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'production-pdf-broadcast-routes', 'exec'), namespace)
        self.login()
        with self.session() as db:
            db.get(Match, self.match_id).operator_id = 'another-operator'
            db.commit()
        class Page:
            def extract_text(self, **kwargs):
                self.extraction_mode = kwargs['extraction_mode']
                return LAYOUT
        class Reader:
            pages = [Page()]
        with patch('app.lineup_pdf.PdfReader', return_value=Reader()):
            uploaded = self.client.post(f'/api/matches/{self.match_id}/lineup/pdf', files={'file': ('kfa.pdf', b'%PDF-1.7', 'application/pdf')})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertEqual(uploaded.json()['match']['metadata']['lineups']['team_names']['HOME'], '홈구단FC')
        self.assertIn(self.match_id, self.changed)
        url = f'/api/broadcast/matches/{self.match_id}/state'
        automatic = self.client.post(url, json={'scoreboard_visible': False}).json()
        self.assertEqual(automatic['home_color'], '#15803d')
        self.assertNotIn('branding_sources', automatic)
        with self.session() as db:
            self.assertEqual(db.get(Match, self.match_id).metadata_json['broadcast']['branding_sources']['home_color'], 'pdf')
        edited = self.client.post(url, json={'home_color': '#123456'}).json()
        self.assertEqual(edited['home_color'], '#123456')
        self.assertNotIn('branding_sources', edited)
        with self.session() as db:
            self.assertEqual(db.get(Match, self.match_id).metadata_json['broadcast']['branding_sources']['home_color'], 'manual')
        reset = self.client.post(url, json={'branding_reset': True}).json()
        self.assertEqual(reset['home_color'], '#15803d')
        self.assertFalse(reset['scoreboard_visible'])
        with self.session() as db:
            match = db.get(Match, self.match_id)
            match.archived = True
            db.commit()
        response = self.client.post(f'/api/matches/{self.match_id}/lineup/pdf', files={'file': ('kfa.pdf', b'%PDF', 'application/pdf')})
        self.assertEqual(response.status_code, 409)

if __name__ == '__main__':
    unittest.main()
