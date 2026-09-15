"""Full application release QA against an explicitly isolated PostgreSQL clone.

Run separately from the SQLite unit suite with FPC_RELEASE_QA=1. Background
delivery is stopped so cloned webhook subscriptions can never contact partners.
Baseline files contain read-only production snapshots and stay outside Git.
"""
import asyncio
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlparse
from uuid import uuid4


@unittest.skipUnless(os.getenv('FPC_RELEASE_QA') == '1', 'isolated PostgreSQL release QA only')
class ReleaseIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert urlparse(os.environ['DATABASE_URL']).path == '/fpc_release_qa', 'Production database is forbidden'
        from fastapi.testclient import TestClient
        from app import main
        from app.auth_security import hash_secret
        from app.models import AdminAccount
        cls.main = main
        cls.temp = tempfile.TemporaryDirectory()
        manifest = Path(cls.temp.name) / 'qa-accounts.json'
        manifest.write_text(json.dumps({'version': 1, 'accounts': [
            {'login': 'release-qa', 'name': 'Release QA', 'password_hash': hash_secret('isolated-qa-password')}
        ]}))
        cls.env = patch.dict(os.environ, {'FPC_ADMIN_ACCOUNTS_FILE': str(manifest), 'PARTNER_API_KEY': 'qa-partner-key'})
        cls.env.start()

        async def disabled_delivery(stop):
            await stop.wait()

        cls.workers = [patch.object(main, name, disabled_delivery) for name in (
            'outbox_worker', 'system_monitor_worker', 'schedule_slack_worker', 'broadcast_asset_worker')]
        for worker in cls.workers:
            worker.start()
        cls.refresh = patch.object(main, '_queue_broadcast_branding_refresh')
        cls.refresh.start()
        cls.client_context = TestClient(main.app)
        cls.client = cls.client_context.__enter__()
        with main.SessionLocal() as db:
            assert db.query(AdminAccount).filter(AdminAccount.active.is_(True)).count() == 1
        login = cls.client.post('/api/session/login', json={
            'name': 'release-qa', 'access_key': 'isolated-qa-password', 'mode': 'ADMIN'})
        assert login.status_code == 200, login.status_code
        cls.user = login.json()
        cls.headers = {'X-API-Key': 'qa-partner-key'}

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.refresh.stop()
        for worker in cls.workers:
            worker.stop()
        cls.env.stop()
        cls.temp.cleanup()

    def new_match(self):
        from app.models import Match
        mid = uuid4()
        with self.main.SessionLocal() as db:
            db.add(Match(id=mid, name='Isolated QA HOME vs AWAY', competition_class='K3',
                         metadata_json={'home_team': 'QA HOME', 'away_team': 'QA AWAY'}))
            db.commit()
        return str(mid)

    def state(self, mid, clock, team, **kwargs):
        return self.client.post(f'/api/matches/{mid}/state', json={
            'state_id': str(uuid4()), 'clock_ms': clock, 'running': True,
            'possession_team': team, 'selected_team': 'HOME', 'attack_lr': 'L2R', **kwargs})

    def test_00_frozen_openapi_contract(self):
        baseline = json.loads(Path('/qa/production-openapi.json').read_text())
        current = self.client.get('/openapi.json').json()
        protected = [p for p in baseline['paths'] if p.startswith('/api/v1/') or p in {
            '/api/matches/{match_id}/state', '/api/matches/{match_id}/events/attack_lane',
            '/api/matches/{match_id}/events/xg', '/api/matches/{match_id}/lock/acquire',
            '/api/matches/{match_id}/lock/release', '/api/xg/estimate', '/api/xgot/estimate',
            '/api/broadcast/matches/{match_id}/state'}]
        references = set()

        def refs(value):
            if isinstance(value, dict):
                if '$ref' in value:
                    references.add(value['$ref'].split('/')[-1])
                for child in value.values():
                    refs(child)
            elif isinstance(value, list):
                for child in value:
                    refs(child)

        for path in protected:
            self.assertEqual(baseline['paths'][path], current['paths'][path], path)
            refs(baseline['paths'][path])
        checked = set()
        while references - checked:
            name = next(iter(references - checked))
            old = baseline['components']['schemas'][name]
            self.assertEqual(old, current['components']['schemas'][name], name)
            checked.add(name)
            refs(old)
        print(f'Frozen contract: {len(protected)} paths, {len(checked)} referenced schemas identical')

    def test_01_archived_production_responses(self):
        baseline = json.loads(Path('/qa/production-responses.json').read_text())
        def stable(value):
            if isinstance(value, dict):
                return {k: stable(v) for k, v in value.items() if k not in {'generated_at', 'updated_at', 'server_time'}}
            if isinstance(value, list):
                return [stable(v) for v in value]
            return value
        for path, old in baseline.items():
            response = self.client.get(path, headers=self.headers)
            self.assertEqual(response.status_code, 200, path)
            self.assertEqual(stable(old), stable(response.json()), path)
        print(f'Archived broadcast responses: {len(baseline)} endpoints identical')

    def test_admin_operator_permissions_and_lock_takeover(self):
        from fastapi.testclient import TestClient
        self.assertEqual(self.client.get('/api/admin/access').status_code, 200)
        self.assertEqual(self.client.put('/api/admin/access/operator-code', json={'code': 'release-operator-code'}).status_code, 200)
        operator = TestClient(self.main.app)
        response = operator.post('/api/session/login', json={
            'name': 'free operator name', 'access_key': 'release-operator-code', 'mode': 'OPERATOR'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['role'], 'OPERATOR')
        self.assertEqual(operator.get('/api/admin/access').status_code, 403)
        mid = self.new_match()
        lock = f'/api/matches/{mid}/lock/acquire'
        self.assertEqual(operator.post(lock, json={}).status_code, 200)
        self.assertEqual(self.state(mid, 0, 'HOME').status_code, 403)
        self.assertEqual(self.client.post(lock, json={}).status_code, 200)
        self.assertEqual(self.state(mid, 0, 'HOME').status_code, 200)
        self.client.put('/api/admin/access/operator-code', json={'code': 'rotated-release-code'})
        self.assertEqual(operator.get('/api/session/me').status_code, 401)

    def test_state_idempotency_stale_clock_rewind_and_possession(self):
        from app.models import State, PossessionSegment
        mid = self.new_match()
        sid = str(uuid4())
        first = self.state(mid, 0, 'HOME', state_id=sid)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(set(first.json()), {'ok', 'state_id'})
        self.assertTrue(self.state(mid, 0, 'HOME', state_id=sid).json()['idempotent'])
        self.assertEqual(self.state(mid, 10000, 'AWAY').status_code, 200)
        self.assertEqual(self.state(mid, 20000, 'NONE', running=False).status_code, 200)
        stale = self.state(mid, 5000, 'HOME').json()
        self.assertEqual(stale['reason'], 'stale_clock')
        from uuid import UUID
        with self.main.SessionLocal() as db:
            self.assertEqual(db.query(State).filter(State.match_id == UUID(mid)).count(), 3)
            segments = db.query(PossessionSegment).filter(PossessionSegment.match_id == UUID(mid)).all()
            self.assertEqual({s.team: s.end_ms-s.start_ms for s in segments}, {'HOME': 10000, 'AWAY': 10000})
        self.assertEqual(self.state(mid, 15000, 'HOME', allow_clock_rewind=True).status_code, 200)

    def test_events_webhook_payloads_partner_auth_and_archive_guard(self):
        from app.models import Match, Outbox, WebhookSubscription
        from uuid import UUID
        mid = self.new_match()
        callback = 'http://127.0.0.1:9/never-deliver-qa'
        with self.main.SessionLocal() as db:
            # Delivery workers are disabled for the entire test process.
            db.add(WebhookSubscription(callback_url=callback, events=['STATE', 'EVENT'], active=True))
            db.commit()
        self.state(mid, 0, 'HOME')
        lane = {'event_id': str(uuid4()), 'clock_ms': 12000, 'team': 'HOME', 'lane': 'LEFT'}
        shot = {'event_id': str(uuid4()), 'clock_ms': 16000, 'team': 'AWAY', 'xg': 0.194,
                'is_goal': True, 'is_on_target': True, 'goalmouth_x': 0.2, 'goalmouth_y': 0.3,
                'shot_x': 90, 'shot_y': 30, 'shot_pace_band': 'HIGH', 'under_pressure': True,
                'one_on_one': True, 'is_header': False, 'is_weak_foot': False}
        for kind, body in [('attack_lane', lane), ('xg', shot)]:
            path = f'/api/matches/{mid}/events/{kind}'
            response = self.client.post(path, json=body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(self.client.post(path, json=body).json()['idempotent'])
        path = f'/api/v1/matches/{mid}/events'
        self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.get(path, headers={'X-API-Key': 'wrong'}).status_code, 401)
        events = self.client.get(path, headers=self.headers).json()
        self.assertEqual(len(events['events']), 2)
        self.assertEqual(events['events'][1]['xg'], 0.194)
        self.assertEqual(events['events'][1]['shot_pace_band'], 'HIGH')
        filtered = self.client.get(path, params={'since': events['events'][0]['created_at']}, headers=self.headers).json()
        self.assertEqual(len(filtered['events']), 1)
        with self.main.SessionLocal() as db:
            payloads = [r.payload for r in db.query(Outbox).filter(Outbox.target_url == callback).all()
                        if r.payload.get('match_id') == mid]
            self.assertEqual(len(payloads), 3)
            state = next(p for p in payloads if p['kind'] == 'STATE')
            self.assertEqual(set(state), {'kind','state_id','idempotency_key','match_id','clock_ms','running',
                                         'possession_team','selected_team','attack_lr','created_at'})
            event = next(p for p in payloads if p.get('type') == 'XG')
            self.assertEqual(event['shot_pace_band'], 'HIGH')
            self.assertEqual(event['idempotency_key'], shot['event_id'])
            match = db.get(Match, UUID(mid)); match.archived = True; db.commit()
        self.assertEqual(self.state(mid, 20000, 'HOME').status_code, 409)

    def test_public_branding_keeps_existing_shape_and_private_sources(self):
        from app.models import Match
        from uuid import UUID
        mid = self.new_match()
        with self.main.SessionLocal() as db:
            match = db.get(Match, UUID(mid))
            match.metadata_json = {**match.metadata_json, 'lineups': {'uniforms': {
                'HOME': {'field': {'shirt': {'hex': '#15803d'}}}}}}
            db.commit()
        path = f'/api/broadcast/matches/{mid}/state'
        state = self.client.get(path).json()
        self.assertEqual(state['home_color'], '#15803d')
        self.assertNotIn('branding_sources', state)
        for body in [{'scoreboard_visible': False}, {'home_color': '#123456'}, {'branding_reset': True}]:
            response = self.client.post(path, json=body)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('branding_sources', response.json())
        with self.main.SessionLocal() as db:
            match = db.get(Match, UUID(mid))
            self.assertEqual(match.metadata_json['broadcast']['branding_sources']['home_color'], 'pdf')
            payload = self.main._broadcast_public_match(match, db)
            self.assertEqual(set(payload['branding']), {'home_color','away_color','home_logo_url','away_logo_url'})
            self.assertNotIn('branding_sources', self.main._build_broadcast_snapshot(match, db)['broadcast_state'])

    def test_real_kfa_pdf_upload_and_team_logo(self):
        from PIL import Image
        mid = self.new_match()
        response = self.client.post(f'/api/matches/{mid}/lineup/pdf', files={
            'file': ('kfa.pdf', Path('/qa/kfa-sample.pdf').read_bytes(), 'application/pdf')})
        self.assertEqual(response.status_code, 200, response.text)
        lineup = response.json()['match']['metadata']['lineups']
        self.assertEqual(lineup['team_names'], {'HOME': '경주한수원FC', 'AWAY': '전북현대모터스'})
        for side in ('HOME', 'AWAY'):
            self.assertEqual(len(lineup['teams'][side]), 20)
            self.assertEqual(sum(p['starter'] for p in lineup['teams'][side]), 11)
            self.assertTrue(lineup['uniforms'][side]['field']['shirt']['hex'].startswith('#'))
        png = io.BytesIO()
        Image.new('RGBA', (64, 64), '#ff7400').save(png, format='PNG')
        response = self.client.post('/api/fcm/team-logos', data={'competition_class': 'K3', 'team_name': 'QA HOME'},
                                    files={'file': ('logo.png', png.getvalue(), 'image/png')})
        self.assertEqual(response.status_code, 200, response.text)
        logo_url = response.json()['logo_url']
        self.assertEqual(self.client.get(logo_url).status_code, 200)
        state = self.client.get(f'/api/broadcast/matches/{mid}/state').json()
        self.assertEqual(state['home_logo_url'], logo_url)
        self.assertEqual(state['home_color'], lineup['uniforms']['HOME']['field']['shirt']['hex'])

    def test_goalkeeper_saved_card_values_and_real_png_export(self):
        from PIL import Image
        from app.models import Match
        from uuid import UUID
        mid = self.new_match()
        for index, xg in enumerate([.194, .706, .7, .5]):
            response = self.client.post(f'/api/matches/{mid}/events/xg', json={
                'event_id': str(uuid4()), 'clock_ms': index * 1000, 'team': 'HOME', 'xg': xg,
                'is_goal': index == 0, 'is_on_target': index < 2, 'goalmouth_x': .3, 'goalmouth_y': .5})
            self.assertEqual(response.status_code, 200)
        with self.main.SessionLocal() as db:
            db.get(Match, UUID(mid)).archived = True
            db.commit()
        response = self.client.post(f'/api/fcm/matches/{mid}/submission', json={
            'team_side': 'AWAY', 'team_name': 'QA AWAY', 'player_id': '31', 'player_name': '골키퍼 QA',
            'card_type': 'GOALKEEPER', 'selected_stats': [
                '실점 : 1골', '기대 실점(xG) : 0.194 (1골)', '선방 : 6회', '캐칭 : 13회', '펀칭 : 3회']})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['selected_stats'][1], '기대 실점(xG) : 2.100 (1골)')
        self.assertEqual(len(response.json()['selected_stats']), 5)
        response = self.client.get('/api/fcm/generate', params={
            'league': 'K3', 'round': 1, 'match_id': mid, 'team_side': 'AWAY'})
        self.assertEqual(response.status_code, 200, response.text[:200] if response.status_code != 200 else '')
        self.assertEqual(response.headers['content-type'], 'image/png')
        with Image.open(io.BytesIO(response.content)) as image:
            self.assertEqual(image.size, (1920, 1080))


if __name__ == '__main__':
    unittest.main(verbosity=2)
