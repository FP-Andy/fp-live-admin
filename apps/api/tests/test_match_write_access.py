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
os.environ.update(DATABASE_URL="sqlite:///" + str(Path(ROOT.name) / "test.sqlite"),
                  AWS_EC2_METADATA_DISABLED="true", MPLCONFIGDIR=str(Path(ROOT.name) / "mpl"),
                  XDG_CACHE_HOME=str(Path(ROOT.name) / "cache"),
                  HIGHLIGHT_RUNTIME_DIR=str(Path(ROOT.name) / "highlight"))
sys.path.insert(0, os.getenv('FPC_API_SOURCE', str(Path(__file__).resolve().parents[1])))
NETWORK = patch.object(socket.socket, "connect", side_effect=AssertionError("No network in API regression tests"))
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

    def test_real_cors_middleware_and_routes(self):
        response = self.clients["anonymous"].options(self.url + "/state", headers={
            "Origin": "http://localhost:4354", "Access-Control-Request-Method": "POST"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("access-control-allow-origin", response.headers)
        self.assertEqual(self.clients["anonymous"].post(f"/matches/{self.mid}/state", json=self.state()).status_code, 404)


if __name__ == "__main__":
    unittest.main()
