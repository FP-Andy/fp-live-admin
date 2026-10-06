"""Real application routes/auth/middleware; temporary SQLite, no startup workers.

Run in its own Python process. All sockets are blocked, including imports.
PostgreSQL transaction contention remains a separate release check.
"""
from datetime import datetime, timedelta
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = tempfile.TemporaryDirectory(prefix="fpc-match-write-tests-")
QA_DATABASE=os.getenv('FPC_TEST_DATABASE_URL')
if QA_DATABASE:
    from urllib.parse import urlparse
    parsed=urlparse(QA_DATABASE)
    assert parsed.hostname in ('127.0.0.1','localhost') and parsed.path=='/fpc_release_qa', 'Only isolated loopback fpc_release_qa is allowed'
os.environ.update(DATABASE_URL=QA_DATABASE or "sqlite:///" + str(Path(ROOT.name) / "test.sqlite"),
                  AWS_EC2_METADATA_DISABLED="true", MPLCONFIGDIR=str(Path(ROOT.name) / "mpl"),
                  XDG_CACHE_HOME=str(Path(ROOT.name) / "cache"),
                  HIGHLIGHT_RUNTIME_DIR=str(Path(ROOT.name) / "highlight"))
sys.path.insert(0, os.getenv('FPC_API_SOURCE', str(Path(__file__).resolve().parents[1])))
NETWORK = patch.object(socket.socket, "connect", side_effect=AssertionError("No network in API regression tests"))
if not QA_DATABASE:
    NETWORK.start()
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from fastapi.testclient import TestClient
from app import main, auth
from app.auth_security import fingerprint, hash_secret
from app.db import Base, SessionLocal, engine
from app.models import AdminAccount, AuthSession, User, OperatorAccessPolicy, Match, State, Event, MatchMarker, MatchHighlight, Outbox, AuditLog


@compiles(JSONB, "sqlite")
def jsonb(element, compiler, **kwargs):
    return "JSON"


class MatchWriteAccess(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password_hash = hash_secret("synthetic-test-only")

    def setUp(self):
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        self.mid, self.other = uuid4(), uuid4()
        self.clients = {}
        with SessionLocal() as db:
            db.add(OperatorAccessPolicy(id="operator", code_hash=self.password_hash, version="test"))
            for name, role in (("owner", "OPERATOR"), ("other", "OPERATOR"), ("admin", "SUPERADMIN")):
                db.add(User(id=name, name=name, role=role))
                db.flush()
                if role == "SUPERADMIN":
                    db.add(AdminAccount(login=name, user_id=name, password_hash=self.password_hash, active=True))
                token = "v2_" + uuid4().hex
                db.add(AuthSession(token_hash=fingerprint(token), user_id=name, role=role,
                       credential_version=fingerprint(self.password_hash) if role == "SUPERADMIN" else "test",
                       expires_at=datetime.utcnow() + timedelta(hours=1)))
                # Not a context manager: do not start production startup jobs.
                client = TestClient(main.app)
                client.cookies.set(auth.COOKIE_NAME, token)
                self.clients[name] = client
            self.clients["anonymous"] = TestClient(main.app)
            db.add_all([Match(id=self.mid, name="Synthetic match", sport="FOOTBALL", operator_id="owner", metadata_json={}),
                        Match(id=self.other, name="Other match", sport="FOOTBALL", metadata_json={})])
            db.commit()
        self.url = f"/api/matches/{self.mid}"

    def tearDown(self):
        for client in self.clients.values():
            client.close()

    def state(self):
        return {"state_id": str(uuid4()), "clock_ms": 1200, "running": True,
                "possession_team": "HOME", "selected_team": "HOME", "attack_lr": "L2R"}

    def writes(self):
        return [("/state", self.state()), ("/events/attack_lane", {"event_id": str(uuid4()), "clock_ms": 1300, "team": "HOME", "lane": "LEFT"}),
                ("/events/xg", {"event_id": str(uuid4()), "clock_ms": 1400, "team": "HOME", "xg": .2}),
                ("/markers", {"clock_ms": 1500, "marker_type": "HALFTIME_START"}),
                ("/highlights", {"clock_ms": 1600}), ("/lock/acquire", {}), ("/lock/release", {}),
                ("/events/reset", {}), ("/possession/reset", {})]

    def counts(self):
        with SessionLocal() as db:
            return [db.query(model).count() for model in (State, Event, MatchMarker, MatchHighlight, Outbox, AuditLog)]

    def test_anonymous_and_spoofed_ids_cannot_write_or_trigger_side_effects(self):
        before = self.counts()
        for suffix, body in self.writes():
            with self.subTest(suffix=suffix):
                self.assertEqual(self.clients["anonymous"].post(self.url + suffix, json={**body, "user_id": "owner", "admin_takeover": True}).status_code, 401)
                self.assertEqual(self.clients["other"].post(self.url + suffix, json={**body, "user_id": "owner", "admin_takeover": True}).status_code, 403)
        self.assertEqual(self.counts(), before)
        with SessionLocal() as db:
            self.assertEqual(db.get(Match, self.mid).operator_id, "owner")
        self.assertIsNone(main.worker_task)

    def test_unassigned_match_still_requires_a_session(self):
        path = f"/api/matches/{self.other}/state"
        self.assertEqual(self.clients["anonymous"].post(path, json=self.state()).status_code, 401)
        self.assertEqual(self.clients["owner"].post(path, json=self.state()).status_code, 200)

    def test_shared_policy_preserves_basketball_and_manual_lineup_writes(self):
        with SessionLocal() as db:
            db.get(Match, self.other).sport = 'BASKETBALL'
            db.get(Match, self.other).operator_id = 'owner'
            db.commit()
        basketball = f'/api/matches/{self.other}/basketball-state'
        body = {'events': [], 'lineups': {'HOME': [], 'AWAY': []}, 'timer': {'running': False}}
        for persona, expected in [('anonymous', 401), ('other', 403), ('owner', 200), ('admin', 200)]:
            body.update(request_id=str(uuid4()),revision=self.clients['owner'].get(basketball).json().get('revision',0))
            self.assertEqual(self.clients[persona].put(basketball, json=body).status_code, expected)
        player = {'side': 'HOME', 'number': '7', 'name': 'Synthetic player'}
        path = self.url + '/lineup/manual/player'
        for persona, expected in [('anonymous', 401), ('other', 403), ('owner', 200), ('admin', 200)]:
            response = self.clients[persona].post(path, json=player)
            self.assertEqual(response.status_code, expected, response.text)

    def test_owner_writes_and_administrator_takeover_remain_available(self):
        owner = self.clients["owner"]
        for suffix, body in self.writes()[:5]:
            response = owner.post(self.url + suffix, json={**body, "user_id": "owner"})
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(owner.post(self.url + "/lock/acquire", json={"admin_takeover": True}).status_code, 403)
        self.assertEqual(self.clients["other"].post(self.url + "/lock/acquire", json={}).status_code, 409)
        self.assertEqual(self.clients["admin"].post(self.url + "/state", json=self.state()).status_code, 200)
        self.assertEqual(self.clients["admin"].post(self.url + "/lock/acquire", json={"admin_takeover": True}).status_code, 200)
        self.assertEqual(owner.post(self.url + "/state", json=self.state()).status_code, 403)
        self.assertEqual(self.clients["admin"].post(self.url + "/lock/release", json={}).status_code, 200)
        self.assertEqual(owner.post(self.url + "/lock/acquire", json={}).status_code, 200)

    def test_archived_and_logged_out_sessions_are_read_only(self):
        with SessionLocal() as db:
            db.get(Match, self.mid).archived = True
            db.commit()
        self.assertEqual(self.clients["admin"].post(self.url + "/state", json=self.state()).status_code, 409)
        self.clients["owner"].post("/api/session/logout")
        self.assertEqual(self.clients["owner"].post(self.url + "/highlights", json={"clock_ms": 2000}).status_code, 401)

    def test_highlight_retry_uses_original_id_and_time_after_committed_response_loss(self):
        body = {"clock_ms": 345678, "request_id": str(uuid4())}
        first = self.clients["owner"].post(self.url + "/highlights", json=body)
        self.assertEqual(first.status_code, 200, first.text)
        # Treat the first response as lost: replay only the original request.
        again = self.clients["owner"].post(self.url + "/highlights", json=body)
        self.assertTrue(again.json()["idempotent"])
        self.assertEqual(first.json()["highlight"], again.json()["highlight"])
        self.assertEqual(self.clients["owner"].post(self.url + "/highlights", json={**body, "clock_ms": 999999}).status_code, 409)
        self.assertEqual(self.clients["owner"].post(f"/api/matches/{self.other}/highlights", json=body).status_code, 409)
        distinct = self.clients["owner"].post(self.url + "/highlights", json={**body, "request_id": str(uuid4())})
        self.assertEqual(distinct.status_code, 200)
        with SessionLocal() as db:
            self.assertEqual(db.query(MatchHighlight).count(), 2)
            self.assertEqual(db.query(AuditLog).filter_by(action="MATCH_HIGHLIGHT_ADD").count(), 2)

    def test_legacy_highlight_creation_and_delete_authorization(self):
        response = self.clients["owner"].post(self.url + "/highlights", json={"clock_ms": 1234})
        self.assertEqual(response.status_code, 200)
        path = self.url + "/highlights/" + response.json()["highlight"]["id"]
        self.assertEqual(self.clients["anonymous"].delete(path).status_code, 401)
        self.assertEqual(self.clients["other"].delete(path).status_code, 403)
        self.assertEqual(self.clients["owner"].delete(path).status_code, 200)

    def test_basketball_rejects_other_sports_without_mutating_metadata(self):
        for verb in ('get', 'put'):
            kwargs = {'json': {'events': []}} if verb == 'put' else {}
            response = getattr(self.clients['owner'], verb)(self.url + '/basketball-state', **kwargs)
            self.assertEqual(response.status_code, 409)
        with SessionLocal() as db:
            self.assertEqual(db.get(Match, self.mid).metadata_json, {})

    def test_request_id_reuse_compares_match_action_and_normalized_content(self):
        owner = self.clients['owner']
        for suffix, body in self.writes()[:3]:
            self.assertEqual(owner.post(self.url + suffix, json=body).status_code, 200)
            before = self.counts()
            self.assertTrue(owner.post(self.url + suffix, json=body).json()['idempotent'])
            self.assertEqual(owner.post(self.url + suffix, json={**body, 'clock_ms': 5000}).status_code, 409)
            self.assertEqual(owner.post(f'/api/matches/{self.other}' + suffix, json=body).status_code, 409)
            self.assertEqual(self.counts(), before)
        body = {'event_id': str(uuid4()), 'clock_ms': 1600, 'team': 'HOME', 'xg': .3, 'player_name': '  Player  '}
        self.assertEqual(owner.post(self.url + '/events/xg', json=body).status_code, 200)
        self.assertTrue(owner.post(self.url + '/events/xg', json={**body, 'player_name': 'Player'}).json()['idempotent'])
        self.assertEqual(owner.post(self.url + '/events/attack_lane', json={**body, 'lane': 'LEFT'}).status_code, 409)

    def test_basketball_versions_retries_deletion_and_timer_patch(self):
        with SessionLocal() as db:
            db.get(Match,self.mid).sport='BASKETBALL'; db.commit()
        client=self.clients['owner']; path=self.url+'/basketball-state'
        first={'request_id':str(uuid4()),'revision':0,'events':[{'id':str(uuid4()),'type':'SHOT','team':'HOME','points':2,'homeScoreAfter':2}]}
        self.assertEqual(client.put(path,json={'events':[]}).status_code,428)
        self.assertEqual(client.put(path,json=first).json()['revision'],1)
        self.assertTrue(client.put(path,json=first).json()['idempotent'])
        self.assertEqual(client.put(path,json={**first,'events':[]}).status_code,409)
        self.assertEqual(client.put(path,json={**first,'request_id':str(uuid4())}).status_code,409)
        timer={'request_id':str(uuid4()),'revision':1,'timer':{'clock':'09:55','period':1}}
        self.assertEqual(client.put(path,json=timer).json()['revision'],2)
        self.assertEqual(client.get(path).json()['events'],first['events'])
        self.assertEqual(client.put(path,json={'request_id':str(uuid4()),'revision':2,'events':[]}).json()['revision'],3)
        self.assertEqual(client.get(path).json()['events'],[])
        self.assertEqual(client.put(path,json=first).json()['current_revision'],3)
        self.assertEqual(client.get(path).json()['events'],[])

    def test_basketball_webhook_state_covers_edit_and_delete_with_revision(self):
        with SessionLocal() as db:
            db.get(Match,self.mid).sport='BASKETBALL'; db.commit()
        client=self.clients['owner']; path=self.url+'/basketball-state'; eid=str(uuid4())
        versions=[[{'id':eid,'type':'SHOT','team':'HOME','points':2,'homeScoreAfter':2}],
                  [{'id':eid,'type':'SHOT','team':'HOME','points':3,'homeScoreAfter':3}],[]]
        with patch.dict(os.environ,{'WEBHOOK_EVENT_URL':'https://fixture.invalid/events'}):
            for revision,events in enumerate(versions):
                response=client.put(path,json={'request_id':str(uuid4()),'revision':revision,'events':events})
                self.assertEqual(response.status_code,200,response.text)
        with SessionLocal() as db:
            snapshots=db.query(Outbox).filter_by(kind='BASKETBALL_STATE').order_by(Outbox.created_at).all()
            self.assertEqual([r.payload['revision'] for r in snapshots],[1,2,3])
            self.assertEqual(snapshots[1].payload['event_changes']['upsert'],versions[1])
            self.assertEqual(snapshots[2].payload['event_changes']['deleted'],[eid])
            self.assertEqual(db.query(Outbox).filter_by(kind='BASKETBALL_EVENT').count(),1)
            # Receiver contract: discard duplicated/stale revisions; reload on gaps.
            received_revision=0; received={}
            for row in [snapshots[0],snapshots[0],snapshots[1],snapshots[2],snapshots[1]]:
                p=row.payload
                if p['revision']<=received_revision:continue
                self.assertEqual(p['revision'],received_revision+1)
                for e in p['event_changes']['upsert']:received[e['id']]=e
                for ident in p['event_changes']['deleted']:received.pop(ident,None)
                received_revision=p['revision']
            self.assertEqual(received,{})

    @unittest.skipUnless(QA_DATABASE, 'Requires isolated PostgreSQL row locks')
    def test_postgres_two_writers_and_ownership_lock(self):
        from concurrent.futures import ThreadPoolExecutor
        import threading
        with SessionLocal() as db:
            db.get(Match,self.mid).sport='BASKETBALL';db.commit()
        barrier=threading.Barrier(2)
        def write(person):
            barrier.wait()
            return self.clients[person].put(self.url+'/basketball-state',json={'request_id':str(uuid4()),'revision':0,'events':[{'id':person}]}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(write,['owner','admin']))
        self.assertEqual(sorted(results),[200,409])
        with SessionLocal() as db:
            self.assertEqual(db.get(Match,self.mid).metadata_json['basketball_fla']['revision'],1)
        # Hold the row, change ownership, then release the waiting write. The
        # request must evaluate ownership after the database lock is acquired.
        started=threading.Event()
        with SessionLocal() as db, ThreadPoolExecutor(max_workers=1) as pool:
            row=db.query(Match).filter_by(id=self.mid).with_for_update().one()
            def pending():
                started.set()
                return self.clients['owner'].post(self.url+'/state',json=self.state()).status_code
            future=pool.submit(pending);started.wait(2)
            row.operator_id='admin';db.commit()
            self.assertEqual(future.result(timeout=5),403)

    def test_clock_commands_survive_newer_samples_and_reject_delayed_controls(self):
        client=self.clients['owner']; path=self.url+'/state'
        def command(revision,clock,running,**extra):
            return {**self.state(),'command_revision':revision,'update_kind':'command','clock_ms':clock,'running':running,**extra}
        start=client.post(path,json=command(0,1000,True));self.assertEqual(start.json()['command_revision'],1)
        sample={**self.state(),'command_revision':1,'update_kind':'sample','clock_ms':1400}
        self.assertEqual(client.post(path,json=sample).status_code,200)
        stop=command(1,1200,False)
        response=client.post(path,json=stop)
        self.assertEqual(response.json()['state']['clock_ms'],1400)
        self.assertFalse(response.json()['state']['running'])
        self.assertEqual(response.json()['command_revision'],2)
        self.assertTrue(client.post(path,json=stop).json()['idempotent'])
        stale=client.post(path,json={**sample,'state_id':str(uuid4()),'clock_ms':2000}).json()
        self.assertTrue(stale['ignored']);self.assertFalse(stale['state']['running'])
        self.assertEqual(client.post(path,json=command(1,1500,True)).status_code,409)
        self.assertEqual(client.post(path,json=command(2,1450,True)).json()['command_revision'],3)
        reset=client.post(path,json=command(3,0,False,allow_clock_rewind=True,possession_team='NONE'))
        self.assertEqual(reset.json()['state']['clock_ms'],0)
        self.assertEqual(reset.json()['command_revision'],4)
        self.assertEqual(client.post(path,json=self.state()).status_code,428)

    def test_real_cors_middleware_and_routes(self):
        response = self.clients["anonymous"].options(self.url + "/state", headers={
            "Origin": "http://localhost:4354", "Access-Control-Request-Method": "POST"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("access-control-allow-origin", response.headers)
        self.assertEqual(self.clients["anonymous"].post(f"/matches/{self.mid}/state", json=self.state()).status_code, 404)


if __name__ == "__main__":
    unittest.main()
