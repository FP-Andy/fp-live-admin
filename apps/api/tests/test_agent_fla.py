"""FLA 에이전트 API(/api/agent/fla) — 실제 앱 라우트·인증, 임시 SQLite, 네트워크 차단.

증명하는 것(이사68 §6)
- 토큰 경계: 위조·만료·폐기·범위 부족·다른 라우트에서 무효·세션 쿠키/파트너 키/방송 키로 agent 경로 무효
- 금지 동작 403, 진행 중 경기 보호, plan/apply 충돌, revert, 상한, 감사
- 운영자 실시간 입력(보관함 재전송)과 부딪혀도 유실·중복·부활 없음
"""
from datetime import datetime, timedelta
import os
from pathlib import Path
import socket
import sys
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = tempfile.TemporaryDirectory(prefix="fpc-agent-fla-tests-")
QA_DATABASE = os.getenv('FPC_TEST_DATABASE_URL')  # CI 의 PostgreSQL 작업(행 잠금 포함)과 같은 규칙
if QA_DATABASE:
    from urllib.parse import urlparse
    parsed = urlparse(QA_DATABASE)
    assert parsed.path == '/fpc_release_qa', 'Only isolated fpc_release_qa is allowed'
os.environ.update(DATABASE_URL=QA_DATABASE or "sqlite:///" + str(Path(ROOT.name) / "test.sqlite"),
                  AWS_EC2_METADATA_DISABLED="true", MPLCONFIGDIR=str(Path(ROOT.name) / "mpl"),
                  XDG_CACHE_HOME=str(Path(ROOT.name) / "cache"),
                  HIGHLIGHT_RUNTIME_DIR=str(Path(ROOT.name) / "highlight"),
                  BROADCAST_INGEST_KEY="synthetic-broadcast-key")
sys.path.insert(0, os.getenv('FPC_API_SOURCE', str(Path(__file__).resolve().parents[1])))
NETWORK = patch.object(socket.socket, "connect", side_effect=AssertionError("No network in API regression tests"))
if not QA_DATABASE:
    NETWORK.start()
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from fastapi.testclient import TestClient
from app import main, auth, agent_fla
from app.auth_security import fingerprint, hash_secret
from app.db import Base, SessionLocal, engine
from app.models import (AdminAccount, AuditLog, AuthSession, CompetitionClass, Event, Match, MatchMarker, OperatorAccessPolicy,
                        PossessionSegment, State, User)
from app.agent_fla import AgentFlaChange, AgentFlaToken, AgentFlaTombstone


@compiles(JSONB, "sqlite")
def jsonb(element, compiler, **kwargs):
    return "JSON"


LINEUP = {"teams": {"HOME": [{"number": "7", "name": "홈칠번"}, {"number": "9", "name": "홈구번"}],
                    "AWAY": [{"number": "10", "name": "원정십번"}, {"number": "4", "name": "원정사번"}]}}
OLD = datetime.utcnow() - timedelta(hours=1)


class AgentFlaTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        agent_fla.rate_limiter.reset()
        self.password_hash = hash_secret("synthetic-test-only")
        self.archived, self.live, self.basketball = uuid4(), uuid4(), uuid4()
        self.sessions = {}
        with SessionLocal() as db:
            db.add(OperatorAccessPolicy(id="operator", code_hash=self.password_hash, version="test"))
            db.add(CompetitionClass(code="K3", name="K3"))
            for name, role in (("admin", "SUPERADMIN"), ("op", "OPERATOR")):
                db.add(User(id=name, name={"admin": "관리자", "op": "김현장"}[name], role=role))
                db.flush()
                if role == "SUPERADMIN":
                    db.add(AdminAccount(login=name, user_id=name, password_hash=self.password_hash, active=True))
                token = "v2_" + uuid4().hex
                db.add(AuthSession(token_hash=fingerprint(token), user_id=name, role=role,
                                   credential_version=fingerprint(self.password_hash) if role == "SUPERADMIN" else "test",
                                   expires_at=datetime.utcnow() + timedelta(hours=1)))
                self.sessions[name] = token
            meta = {"home_team": "홈FC", "away_team": "원정FC", "lineups": LINEUP}
            db.add_all([
                Match(id=self.archived, name="[K3 | 1R] 홈FC vs 원정FC", sport="FOOTBALL", archived=True,
                      archived_at=OLD, metadata_json=dict(meta), created_at=OLD),
                Match(id=self.live, name="[K3 | 2R] 홈FC vs 원정FC", sport="FOOTBALL", operator_id="op",
                      metadata_json={**meta, "fla_clock_revision": 3}, created_at=OLD),
                Match(id=self.basketball, name="농구", sport="BASKETBALL", metadata_json={}, created_at=OLD),
            ])
            db.flush()
            # 보관 경기: 전반 2골(홈), 후반 1골(원정), 후반 시작 = 전반 45+2:00
            self.goal1, self.goal2, self.goal3, self.shot, self.lane = (uuid4() for _ in range(5))
            db.add_all([
                MatchMarker(match_id=self.archived, marker_type="HALFTIME_START", clock_ms=2_820_000, created_at=OLD),
                self._ev(self.goal1, self.archived, 600_000, "HOME", goal=True, number="7", name="홈칠번"),
                self._ev(self.goal2, self.archived, 2_000_000, "HOME", goal=True, number="9", name="홈구번"),
                self._ev(self.goal3, self.archived, 2_820_000 + 20 * 60_000, "AWAY", goal=True, number="10", name="원정십번"),
                self._ev(self.shot, self.archived, 1_000_000, "AWAY"),
                Event(id=self.lane, match_id=self.archived, type="ATTACK_LANE", clock_ms=900_000, team="HOME", lane="LEFT", created_at=OLD),
                PossessionSegment(match_id=self.archived, team="HOME", start_ms=0, end_ms=60_000, created_at=OLD),
                PossessionSegment(match_id=self.archived, team="AWAY", start_ms=60_000, end_ms=120_000, created_at=OLD),
            ])
            # 진행 중 경기: 시계 30:00, 전반 골 1(홈, 오래됨)
            self.live_goal = uuid4()
            db.add_all([
                State(id=uuid4(), match_id=self.live, clock_ms=1_800_000, running=True, possession_team="HOME",
                      selected_team="HOME", attack_lr="L2R", created_at=datetime.utcnow()),
                self._ev(self.live_goal, self.live, 600_000, "HOME", goal=True, number="7", name="홈칠번"),
                PossessionSegment(match_id=self.live, team="AWAY", start_ms=0, end_ms=500_000, created_at=OLD),
                PossessionSegment(match_id=self.live, team="HOME", start_ms=500_000, end_ms=None, created_at=OLD),
            ])
            db.commit()
            self.seg_ids = [str(s.id) for s in db.query(PossessionSegment).filter(PossessionSegment.match_id == self.archived)
                            .order_by(PossessionSegment.start_ms).all()]
            self.live_seg_ids = [str(s.id) for s in db.query(PossessionSegment).filter(PossessionSegment.match_id == self.live)
                                 .order_by(PossessionSegment.start_ms).all()]
        self.admin = self.client("admin")
        self.op = self.client("op")
        self.anon = TestClient(main.app)
        self.token = self.issue("박기록")
        self.read_only = self.issue("이읽기", scopes=["fla:read"])

    def tearDown(self):
        for c in (self.admin, self.op, self.anon):
            c.close()

    @staticmethod
    def _ev(eid, mid, clock, team, goal=False, number=None, name=None):
        return Event(id=eid, match_id=mid, type="XG", clock_ms=clock, team=team, xg=0.3, xgot=0.4 if goal else None,
                     is_goal=goal, is_on_target=goal, shot_x=95.0, shot_y=34.0,
                     goalmouth_x=0.5 if goal else None, goalmouth_y=0.5 if goal else None,
                     player_number=number, player_name=name, created_at=OLD)

    def client(self, name):
        c = TestClient(main.app)
        c.cookies.set(auth.COOKIE_NAME, self.sessions[name])
        return c

    def issue(self, person, scopes=("fla:read", "fla:write")):
        r = self.admin.post("/api/admin/agent-fla/tokens", json={"person_name": person, "scopes": list(scopes)})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["token"]

    def h(self, token=None):
        return {"Authorization": "Bearer " + (token or self.token)}

    def plan(self, mid, ops, token=None, summary="테스트 정정"):
        return self.anon.post(f"/api/agent/fla/matches/{mid}/plan", json={"request_summary": summary, "ops": ops}, headers=self.h(token))

    def apply(self, plan_id, token=None):
        return self.anon.post(f"/api/agent/fla/plans/{plan_id}/apply", headers=self.h(token))

    def plan_apply(self, mid, ops, token=None):
        p = self.plan(mid, ops, token)
        self.assertEqual(p.status_code, 200, p.text)
        a = self.apply(p.json()["data"]["plan_id"], token)
        self.assertEqual(a.status_code, 200, a.text)
        return p.json()["data"], a.json()["data"]

    def event(self, eid):
        with SessionLocal() as db:
            return db.get(Event, eid)

    def errors(self, response):
        self.assertEqual(response.status_code, 422, response.text)
        return [e["code"] for e in response.json()["detail"]["errors"]]

    # ── 토큰 경계 ──────────────────────────────────────────────────────────

    def test_token_boundary_on_agent_routes(self):
        url = "/api/agent/fla/matches"
        self.assertEqual(self.anon.get(url, headers=self.h()).status_code, 200)
        cases = {
            "없음": {},
            "위조": {"Authorization": "Bearer fpcfla_" + "x" * 43},
            "접두어 없음": {"Authorization": "Bearer " + self.token[len("fpcfla_"):]},
            "Basic": {"Authorization": "Basic " + self.token},
            "X-API-Key 에 토큰": {"X-API-Key": self.token},
            "방송 키": {"X-Broadcast-Key": "synthetic-broadcast-key"},
            "세션 토큰을 Bearer 로": {"Authorization": "Bearer " + self.sessions["admin"]},
        }
        for label, headers in cases.items():
            with self.subTest(label):
                self.assertEqual(self.anon.get(url, headers=headers).status_code, 401)
        # 관리자 세션 쿠키·운영자 세션 쿠키는 agent 경로에서 통하지 않는다
        self.assertEqual(self.admin.get(url).status_code, 401)
        self.assertEqual(self.op.get(url).status_code, 401)
        # 토큰을 쿠키 이름으로 넣어도 무효
        c = TestClient(main.app)
        c.cookies.set(auth.COOKIE_NAME, self.token)
        self.assertEqual(c.get(url).status_code, 401)
        with patch.object(main, "PARTNER_API_KEY", "synthetic-partner-key", create=True):
            self.assertEqual(self.anon.get(url, headers={"X-API-Key": "synthetic-partner-key"}).status_code, 401)

    def test_expired_and_revoked_tokens(self):
        with SessionLocal() as db:
            row = db.query(AgentFlaToken).filter(AgentFlaToken.token_hash == fingerprint(self.token)).one()
            row.expires_at = datetime.utcnow() - timedelta(seconds=1)
            db.commit()
        r = self.anon.get("/api/agent/fla/me", headers=self.h())
        self.assertEqual((r.status_code, r.json()["detail"]), (401, "만료된 토큰입니다."))
        listed = self.admin.get("/api/admin/agent-fla/tokens").json()["items"]
        rid = next(t["id"] for t in listed if t["person_name"] == "이읽기")
        self.assertEqual(self.admin.post(f"/api/admin/agent-fla/tokens/{rid}/revoke").json()["state"], "revoked")
        r = self.anon.get("/api/agent/fla/me", headers=self.h(self.read_only))
        self.assertEqual((r.status_code, r.json()["detail"]), (401, "폐기된 토큰입니다."))

    def test_scope_is_enforced(self):
        self.assertEqual(self.plan(self.archived, [{"op": "delete_event", "event_id": str(self.shot)}], token=self.read_only).status_code, 403)
        w = self.issue("김쓰기", scopes=["fla:write"])
        self.assertEqual(self.anon.get("/api/agent/fla/matches", headers=self.h(w)).status_code, 403)

    def test_agent_token_opens_nothing_else(self):
        """다른 라우트는 Authorization 을 읽지 않는다 — 토큰은 세션이 필요한 곳에서 401/403 이다."""
        H = self.h()
        mid = self.live
        routes = [
            ("GET", "/api/session/me", None), ("GET", "/api/admin/access", None),
            ("GET", f"/api/admin/matches/{self.archived}/timeline-items", None),
            ("PATCH", f"/api/admin/matches/{self.archived}", {"name": "[K3 | 1R] A vs B"}),
            ("DELETE", f"/api/admin/matches/{self.archived}/timeline-items/EVENT/{self.shot}", None),
            ("POST", f"/api/matches/{mid}/events/xg", {"event_id": str(uuid4()), "team": "HOME", "xg": 0.1}),
            ("POST", f"/api/matches/{mid}/events/attack_lane", {"event_id": str(uuid4()), "team": "HOME", "lane": "LEFT"}),
            ("POST", f"/api/matches/{mid}/state", {"state_id": str(uuid4()), "clock_ms": 1, "running": False,
                                                   "possession_team": "NONE", "selected_team": "HOME", "attack_lr": "L2R"}),
            ("POST", f"/api/matches/{mid}/possession/reset", {}), ("POST", f"/api/matches/{mid}/events/reset", {}),
            ("POST", f"/api/matches/{mid}/lock/release", {"admin_takeover": True}),
            ("GET", "/api/admin/agent-fla/tokens", None), ("POST", "/api/admin/agent-fla/tokens", {"person_name": "x"}),
            ("GET", "/api/admin/agent-fla/changes", None), ("GET", f"/api/matches/{mid}/agent-edits", None),
            ("GET", "/api/outbox", None),
        ]
        already_open = []
        for method, path, body in routes:
            with self.subTest(path=path, method=method):
                r = self.anon.request(method, path, json=body, headers=H)
                if r.status_code < 400:
                    # 토큰과 상관없이 원래 열려 있는 라우트(서버작업 계획 §0-1, 이번 범위 밖)는 토큰 없이도 같은 결과여야 한다.
                    bare = self.anon.request(method, path, json=body)
                    self.assertEqual(bare.status_code, r.status_code)
                    already_open.append(f"{method} {path}")
                    continue
                self.assertIn(r.status_code, (401, 403, 405), f"{method} {path} -> {r.status_code} {r.text[:200]}")
        print("\n[토큰 무관하게 이미 열린 라우트]", already_open)
        self.assertEqual(already_open, ["GET /api/outbox"])
        with SessionLocal() as db:
            self.assertEqual(db.query(Event).filter(Event.match_id == mid).count(), 1)
            self.assertFalse(db.query(AgentFlaToken).filter(AgentFlaToken.label == "x").count())

    def test_token_is_hashed_and_shown_once(self):
        with SessionLocal() as db:
            rows = db.query(AgentFlaToken).all()
            self.assertTrue(all(r.token_hash == fingerprint(self.token) or r.token_hash != self.token for r in rows))
            self.assertFalse(any(self.token in str(v) for r in rows for v in vars(r).values()))
            audits = db.query(AuditLog).filter(AuditLog.action == "AGENT_FLA_TOKEN_ISSUED").all()
            self.assertFalse(any(self.token in str(a.details) for a in audits))
        listed = self.admin.get("/api/admin/agent-fla/tokens")
        self.assertNotIn(self.token, listed.text)
        self.assertNotIn("token_hash", listed.text)
        dup = self.admin.post("/api/admin/agent-fla/tokens", json={"person_name": "박기록"})
        self.assertEqual(dup.status_code, 409)  # 한 사람 한 토큰
        self.assertEqual(self.op.get("/api/admin/agent-fla/tokens").status_code, 403)  # 발급·목록은 SUPERADMIN 만

    def test_staff_row_cannot_log_in(self):
        with SessionLocal() as db:
            staff = db.query(User).filter(User.name == "박기록").one()
            self.assertEqual(staff.role, "STAFF")
            fake = "v2_" + uuid4().hex
            db.add(AuthSession(token_hash=fingerprint(fake), user_id=staff.id, role="STAFF", credential_version="x",
                               expires_at=datetime.utcnow() + timedelta(hours=1)))
            db.commit()
        c = TestClient(main.app)
        c.cookies.set(auth.COOKIE_NAME, fake)
        self.assertEqual(c.get("/api/session/me").status_code, 401)

    # ── 금지 동작 ──────────────────────────────────────────────────────────

    def test_forbidden_ops_are_403(self):
        for name in agent_fla.FORBIDDEN_OPS:
            with self.subTest(name):
                agent_fla.rate_limiter.reset()
                r = self.plan(self.archived, [{"op": name}])
                self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.plan(self.archived, [{"op": "unknown_thing"}]).status_code, 422)
        for path in ("archive", "unarchive", "stream/stop", "possession/reset", "events/reset", "lock/release", "delete"):
            with self.subTest(path):
                r = self.anon.post(f"/api/agent/fla/matches/{self.archived}/{path}", headers=self.h())
                self.assertIn(r.status_code, (404, 405))
        self.assertEqual(self.anon.get(f"/api/agent/fla/matches/{self.basketball}", headers=self.h()).status_code, 404)

    # ── 시각·값 규칙 ────────────────────────────────────────────────────────

    def test_clock_rules(self):
        ctx = agent_fla.ClockContext(Match(first_half_minutes=45, second_half_minutes=45), {"HALFTIME_START": 2_820_000})
        self.assertEqual(ctx.to_raw("1H", "45+1:10"), 2_770_000)
        self.assertEqual(ctx.to_raw("1H", "46:10"), 2_770_000)
        self.assertEqual(ctx.to_raw("2H", "45:00"), 2_820_000)
        self.assertEqual(ctx.to_raw("2H", "90+3:00"), 2_820_000 + 48 * 60_000)
        self.assertEqual(ctx.describe(2_830_000)["label"], "2H 45:10")
        self.assertEqual(ctx.describe(2_810_000)["label"], "1H 45+1:50")
        for half, text, code in (("1H", "47:30", "CLOCK_IN_NEXT_PERIOD"), ("2H", "30:00", "CLOCK_OUT_OF_HALF"),
                                 ("ET1", "95:00", "PERIOD_NOT_STARTED"), ("1H", "10:75", "BAD_CLOCK"),
                                 ("2H", "45+1:00", "BAD_CLOCK"), ("1H", "abc", "BAD_CLOCK"), ("1H", "45+21:00", "CLOCK_OUT_OF_HALF"),
                                 # 지시 02 L1: 추가시간 초 60 이상·전각 숫자
                                 ("1H", "45+0:99", "BAD_CLOCK"), ("1H", "45+1:60", "BAD_CLOCK"), ("1H", "５０:００", "BAD_CLOCK"),
                                 ("1H", "１0:00", "BAD_CLOCK")):
            with self.subTest(text):
                with self.assertRaises(agent_fla.RuleError) as raised:
                    ctx.to_raw(half, text)
                self.assertEqual(raised.exception.code, code)

    def test_value_rules(self):
        at = {"half": "1H", "clock": "20:00"}
        base = {"op": "add_shot", "team": "HOME", "at": at, "shot_x": 95, "shot_y": 34}
        self.assertEqual(self.errors(self.plan(self.archived, [{**base, "player_number": "99"}])), ["NUMBER_NOT_IN_LINEUP"])
        self.assertEqual(self.errors(self.plan(self.archived, [{**base, "player_number": "7", "player_name": "남"}])), ["NAME_MISMATCH"])
        self.assertEqual(self.errors(self.plan(self.archived, [{**base, "is_goal": True}])), ["GOALMOUTH_REQUIRED"])
        self.assertEqual(self.errors(self.plan(self.archived, [{**base, "at": {"half": "1H", "clock": "10:00"}}])), ["DUPLICATE_SUSPECT"])
        self.assertEqual(self.plan(self.archived, [{**base, "shot_x": 10}]).status_code, 422)  # 범위 밖
        self.assertEqual(self.plan(self.archived, [{**base, "extra": 1}]).status_code, 422)  # 모르는 필드
        ok = self.plan(self.archived, [{**base, "player_number": "9"}]).json()["data"]
        self.assertEqual(ok["items"][0]["after"]["player_name"], "홈구번")
        self.assertIn("XG_ESTIMATED", [w["code"] for w in ok["warnings"]])
        own = self.plan(self.archived, [{**base, "is_own_goal": True, "player_number": "9"}]).json()["data"]["items"][0]["after"]
        self.assertEqual((own["is_goal"], own["is_on_target"], own["xg"], own["player_number"]), (True, False, 0.0, None))
        self.assertEqual(self.errors(self.plan(self.archived, [{"op": "update_event", "event_id": str(self.lane), "set": {"xg": 0.2}}])),
                         ["FIELD_NOT_FOR_LANE"])
        too_big = [{"op": "delete_event", "event_id": str(uuid4())}] * (agent_fla.OPS_SAFETY_MAX + 1)
        self.assertEqual(self.plan(self.archived, too_big).status_code, 422)  # 요청 크기 안전값(한도 아님)

    # ── 정정 절차(보관 경기) ─────────────────────────────────────────────────

    def test_archived_procedures_and_score(self):
        p, a = self.plan_apply(self.archived, [{"op": "update_event", "event_id": str(self.goal2),
                                               "set": {"team": "AWAY", "player_number": "10"}}])
        self.assertEqual((p["score"]["before"], p["score"]["after"]), ({"HOME": 2, "AWAY": 1}, {"HOME": 1, "AWAY": 2}))
        self.assertIn("SCORE_CHANGE", [w["code"] for w in p["warnings"]])
        self.assertTrue(any(not f["auto"] for f in a["follow_ups"]))
        self.assertEqual((self.event(self.goal2).team, self.event(self.goal2).player_name), ("AWAY", "원정십번"))
        result = self.anon.get(f"/api/agent/fla/matches/{self.archived}", headers=self.h()).json()["data"]
        self.assertEqual(result["score"], {"HOME": 1, "AWAY": 2})
        # 하프 시작 시각: 후반 시작을 45+1:00 으로 → 1H 46:40 기록은 없음, 후반 기록 표시가 1분 밀린다
        p, _ = self.plan_apply(self.archived, [{"op": "set_period_start", "period": "2H", "previous_period_clock": "45+1:00"}])
        shift = next(w for w in p["warnings"] if w["code"] == "PERIOD_SHIFT")
        self.assertEqual(shift["examples"][0]["after"], "2H 66:00")
        # 점유 경계 이동: 앞 구간 끝과 뒤 구간 시작이 함께
        self.plan_apply(self.archived, [{"op": "move_possession_boundary", "segment_id": self.seg_ids[0],
                                         "new_end": {"half": "1H", "clock": "01:30"}}])
        with SessionLocal() as db:
            segs = db.query(PossessionSegment).filter(PossessionSegment.match_id == self.archived).order_by(PossessionSegment.start_ms).all()
            self.assertEqual([(s.start_ms, s.end_ms) for s in segs], [(0, 90_000), (90_000, 120_000)])
        # 경기 이름
        self.plan_apply(self.archived, [{"op": "rename_match", "name": "[K3 | 1R] 새홈 vs 원정FC"}])
        with SessionLocal() as db:
            m = db.get(Match, self.archived)
            self.assertEqual((m.name, m.metadata_json["home_team"]), ("[K3 | 1R] 새홈 vs 원정FC", "새홈"))

    # ── plan/apply 충돌 · revert ────────────────────────────────────────────

    def test_stale_plan_is_rejected(self):
        p = self.plan(self.archived, [{"op": "update_event", "event_id": str(self.goal1), "set": {"player_number": "9"}}]).json()["data"]
        # plan 뒤에 같은 기록을 관리자 기록 수정 화면이 고쳤다
        r = self.admin.patch(f"/api/admin/matches/{self.archived}/timeline-items/EVENT/{self.goal1}",
                             json={"kind": "EVENT", "type": "XG", "clock_ms": 610_000, "team": "HOME", "xg": 0.3,
                                   "is_goal": True, "is_on_target": True, "goalmouth_x": 0.5, "goalmouth_y": 0.5,
                                   "shot_x": 95, "shot_y": 34})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.apply(p["plan_id"])
        self.assertEqual((r.status_code, r.json()["detail"]["reason"]), (409, "stale_plan"))
        self.assertEqual(self.event(self.goal1).clock_ms, 610_000)  # 관리자 수정이 남고
        self.assertNotEqual(self.event(self.goal1).player_number, "9")  # 에이전트 plan 은 적용되지 않았다
        self.assertEqual(self.apply(p["plan_id"]).status_code, 409)  # 같은 plan 은 다시 시도해도 거부(재plan 필요)

    def test_plan_expiry_reuse_and_ownership(self):
        p = self.plan(self.archived, [{"op": "delete_event", "event_id": str(self.shot)}]).json()["data"]
        other = self.issue("남의토큰")
        self.assertEqual(self.apply(p["plan_id"], token=other).status_code, 404)
        with SessionLocal() as db:
            db.get(AgentFlaChange, p["plan_id"]).expires_at = datetime.utcnow() - timedelta(seconds=1)
            db.commit()
        self.assertEqual(self.apply(p["plan_id"]).status_code, 409)
        self.assertIsNotNone(self.event(self.shot))
        p = self.plan(self.archived, [{"op": "delete_event", "event_id": str(self.shot)}]).json()["data"]
        self.assertEqual(self.apply(p["plan_id"]).status_code, 200)
        self.assertEqual(self.apply(p["plan_id"]).status_code, 409)

    def test_revert_and_revert_conflict(self):
        _p, a = self.plan_apply(self.archived, [{"op": "delete_event", "event_id": str(self.goal1)},
                                                {"op": "update_event", "event_id": str(self.goal3), "set": {"at": {"half": "2H", "clock": "70:00"}}}])
        self.assertIsNone(self.event(self.goal1))
        r = self.anon.post(f"/api/agent/fla/changes/{a['change_id']}/revert", headers=self.h())
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.event(self.goal1).player_name, "홈칠번")
        self.assertEqual(self.event(self.goal3).clock_ms, 2_820_000 + 20 * 60_000)
        with SessionLocal() as db:
            self.assertIsNone(db.get(AgentFlaTombstone, self.goal1))
        # 다시 적용한 뒤 같은 기록을 또 고치면 앞 변경은 되돌릴 수 없다
        _p, a1 = self.plan_apply(self.archived, [{"op": "update_event", "event_id": str(self.goal1), "set": {"player_number": "9"}}])
        self.plan_apply(self.archived, [{"op": "update_event", "event_id": str(self.goal1), "set": {"at": {"half": "1H", "clock": "11:00"}}}])
        r = self.anon.post(f"/api/agent/fla/changes/{a1['change_id']}/revert", headers=self.h())
        self.assertEqual((r.status_code, r.json()["detail"]["reason"]), (409, "changed_after_apply"))
        self.assertEqual(self.anon.post(f"/api/agent/fla/changes/{a1['change_id']}/revert", headers=self.h(self.issue("남"))).status_code, 404)

    # ── 진행 중 경기 ────────────────────────────────────────────────────────

    def test_live_guards(self):
        cases = [
            ([{"op": "add_shot", "team": "HOME", "at": {"half": "1H", "clock": "35:00"}, "shot_x": 95, "shot_y": 30}], "LIVE_FUTURE_TIME"),
            ([{"op": "set_period_start", "period": "2H", "previous_period_clock": "20:00"}], "LIVE_PERIOD_MARKER"),
            ([{"op": "rename_match", "name": "[K3 | 2R] A vs B"}], "LIVE_RENAME"),
            ([{"op": "set_possession_team", "segment_id": self.live_seg_ids[1], "team": "AWAY"}], "SEGMENT_OPEN"),
            ([{"op": "move_possession_boundary", "segment_id": self.live_seg_ids[0], "new_end": {"half": "1H", "clock": "07:00"}}], "SEGMENT_OPEN"),
        ]
        for ops, code in cases:
            with self.subTest(code):
                self.assertEqual(self.errors(self.plan(self.live, ops)), [code])
        # 방금 들어온 운영자 기록은 30초 동안 못 건드린다
        fresh = uuid4()
        r = self.op.post(f"/api/matches/{self.live}/events/xg", json={"event_id": str(fresh), "clock_ms": 1_700_000, "team": "AWAY", "xg": 0.1})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.errors(self.plan(self.live, [{"op": "delete_event", "event_id": str(fresh)}])), ["LIVE_TOO_RECENT"])

    def test_live_edit_warns_broadcast_and_notifies_operator(self):
        p, a = self.plan_apply(self.live, [{"op": "update_event", "event_id": str(self.live_goal), "set": {"team": "AWAY", "player_number": "10"}}])
        codes = [w["code"] for w in p["warnings"]]
        self.assertIn("LIVE_BROADCAST_SCORE", codes)
        self.assertIn("OPERATOR_ACTIVE", codes)
        self.assertTrue(p["live"])
        # 운영자 화면 알림
        notes = self.op.get(f"/api/matches/{self.live}/agent-edits").json()["items"]
        self.assertEqual(notes[0]["message"], f"박기록님이 기록을 고쳤습니다({a['summary']})")
        self.assertIn("1H 10:00", notes[0]["message"])
        # 시계 명령 번호(fla_clock_revision)는 그대로 — 운영자 보관함의 명령과 엮이지 않는다
        with SessionLocal() as db:
            self.assertEqual(db.get(Match, self.live).metadata_json["fla_clock_revision"], 3)
        r = self.op.post(f"/api/matches/{self.live}/state", json={"state_id": str(uuid4()), "update_kind": "command", "command_revision": 3,
                                                                   "clock_ms": 1_805_000, "running": True, "possession_team": "AWAY",
                                                                   "selected_team": "HOME", "attack_lr": "L2R"})
        self.assertEqual((r.status_code, r.json()["command_revision"]), (200, 4))
        # 방송 수동 점수를 쓰는 경기면 경고
        with SessionLocal() as db:
            m = db.get(Match, self.live)
            m.metadata_json = {**m.metadata_json, "broadcast": {"home_score": 0, "away_score": 1}}
            db.commit()
        p = self.plan(self.live, [{"op": "update_event", "event_id": str(self.live_goal), "set": {"is_goal": False}}]).json()["data"]
        self.assertIn("BROADCAST_MANUAL_SCORE", [w["code"] for w in p["warnings"]])

    def test_operator_outbox_resend_no_loss_no_duplicate(self):
        """운영자 보관함 흉내: 같은 id 재전송·응답 유실·에이전트 수정이 겹쳐도 유실·중복·부활이 없다."""
        with patch.object(agent_fla, "LIVE_SETTLE_SECONDS", 0):
            shot_a, shot_b, shot_c = uuid4(), uuid4(), uuid4()
            body = lambda eid, clock, team="HOME": {"event_id": str(eid), "clock_ms": clock, "team": team, "xg": 0.12,
                                                    "shot_x": 92.0, "shot_y": 30.0}
            # A·B: 서버에 저장됐지만 운영자 화면은 응답을 못 받았다고 치자(보관함에 남아 다시 보낼 예정)
            for eid, clock in ((shot_a, 1_200_000), (shot_b, 1_300_000)):
                self.assertEqual(self.op.post(f"/api/matches/{self.live}/events/xg", json=body(eid, clock)).status_code, 200)
            # 에이전트: A 삭제, B 시각 수정
            _p, a = self.plan_apply(self.live, [{"op": "delete_event", "event_id": str(shot_a)},
                                                {"op": "update_event", "event_id": str(shot_b), "set": {"at": {"half": "1H", "clock": "21:00"}}}])
            # 그 사이 운영자의 새 입력 C(상관없음)
            self.assertEqual(self.op.post(f"/api/matches/{self.live}/events/xg", json=body(shot_c, 1_750_000, "AWAY")).status_code, 200)
            # 보관함 재전송: A 는 되살아나지 않고 저장 확인만, B 는 409(보관함은 '이미 저장됨'으로 처리)
            ra = self.op.post(f"/api/matches/{self.live}/events/xg", json=body(shot_a, 1_200_000))
            self.assertEqual((ra.status_code, ra.json().get("deleted_by_agent"), ra.json()["event_id"]), (200, True, str(shot_a)))
            rb = self.op.post(f"/api/matches/{self.live}/events/xg", json=body(shot_b, 1_300_000))
            self.assertEqual(rb.status_code, 409)
            self.assertRegex(rb.json()["detail"], "different match or payload")  # 보관함 classify → done
            rc = self.op.post(f"/api/matches/{self.live}/events/xg", json=body(shot_c, 1_750_000, "AWAY"))
            self.assertTrue(rc.json()["idempotent"])
            with SessionLocal() as db:
                rows = db.query(Event).filter(Event.match_id == self.live).all()
                ids = sorted(str(r.id) for r in rows)
                self.assertEqual(ids, sorted([str(self.live_goal), str(shot_b), str(shot_c)]))  # 유실 0·중복 0·부활 0
                self.assertEqual(db.get(Event, shot_b).clock_ms, 1_260_000)
            # 운영자 화면이 다시 받는 요약에 고친 내용이 있다(캐시 비움)
            summary = self.op.get(f"/api/matches/{self.live}/summary").json()
            self.assertEqual({e["id"]: e["clock_ms"] for e in summary["events"]}[str(shot_b)], 1_260_000)
            self.assertNotIn(str(shot_a), [e["id"] for e in summary["events"]])
            # 되돌리기: A 가 같은 id 로 돌아오고 삭제표식이 지워진다 → 이후 재전송은 평범한 멱등 응답
            self.assertEqual(self.anon.post(f"/api/agent/fla/changes/{a['change_id']}/revert", headers=self.h()).status_code, 200)
            self.assertIsNotNone(self.event(shot_a))
            ra = self.op.post(f"/api/matches/{self.live}/events/xg", json=body(shot_a, 1_200_000))
            self.assertEqual((ra.status_code, ra.json().get("deleted_by_agent")), (200, None))

    def test_unrelated_new_input_passes_but_clash_rejects(self):
        add = [{"op": "add_shot", "team": "AWAY", "at": {"half": "1H", "clock": "25:00"}, "shot_x": 95, "shot_y": 30}]
        p = self.plan(self.live, add).json()["data"]
        # 상관없는 새 입력(다른 시각) → apply 통과
        self.op.post(f"/api/matches/{self.live}/events/attack_lane", json={"event_id": str(uuid4()), "clock_ms": 1_790_000, "team": "HOME", "lane": "LEFT"})
        self.assertEqual(self.apply(p["plan_id"]).status_code, 200)
        # 넣으려는 슈팅과 같은 팀·2초 차이 새 입력 → 재plan 요구
        add2 = [{"op": "add_shot", "team": "AWAY", "at": {"half": "1H", "clock": "27:00"}, "shot_x": 95, "shot_y": 30}]
        p = self.plan(self.live, add2).json()["data"]
        self.op.post(f"/api/matches/{self.live}/events/xg", json={"event_id": str(uuid4()), "clock_ms": 1_622_000, "team": "AWAY", "xg": 0.1})
        r = self.apply(p["plan_id"])
        self.assertEqual((r.status_code, r.json()["detail"]["reason"]), (409, "new_input_clash"))

    # ── 상한 · 감사 ────────────────────────────────────────────────────────

    def test_rate_and_daily_limits(self):
        with patch.object(agent_fla, "RATE_PER_MINUTE", 3):
            agent_fla.rate_limiter.reset()
            codes = [self.anon.get("/api/agent/fla/me", headers=self.h()).status_code for _ in range(4)]
            self.assertEqual(codes, [200, 200, 200, 429])
        agent_fla.rate_limiter.reset()
        with patch.object(agent_fla, "DAILY_WRITES", 1):
            self.plan_apply(self.archived, [{"op": "delete_event", "event_id": str(self.shot)}])
            p = self.plan(self.archived, [{"op": "delete_event", "event_id": str(self.lane)}]).json()["data"]
            self.assertEqual(self.apply(p["plan_id"]).status_code, 429)

    def test_audit_has_real_name_token_and_before_after(self):
        _p, a = self.plan_apply(self.archived, [{"op": "update_event", "event_id": str(self.goal1), "set": {"player_number": "9"}}])
        self.plan(self.archived, [{"op": "add_shot", "team": "HOME", "at": {"half": "1H", "clock": "10:01"}, "shot_x": 95, "shot_y": 30}])
        with SessionLocal() as db:
            row = db.query(AuditLog).filter(AuditLog.action == "AGENT_FLA_APPLY").one()
            token = db.query(AgentFlaToken).filter(AgentFlaToken.token_hash == fingerprint(self.token)).one()
            self.assertEqual((row.actor_name, row.actor_role, row.match_id), ("박기록", "STAFF", str(self.archived)))
            self.assertEqual(row.details["token_id"], token.id)
            self.assertEqual(row.details["request_summary"], "테스트 정정")
            item = row.details["items"][0]
            self.assertEqual((item["before"]["player_number"], item["after"]["player_number"]), ("7", "9"))
            self.assertTrue(db.query(AuditLog).filter(AuditLog.action == "AGENT_FLA_PLAN_REJECTED").count())
        listed = self.admin.get(f"/api/admin/agent-fla/changes?match_id={self.archived}").json()["items"]
        self.assertEqual((listed[0]["change_id"], listed[0]["actor_name"]), (a["change_id"], "박기록"))

    def test_editor_keeps_own_goal_flag(self):
        """기록 수정 화면은 is_own_goal 을 보내지 않는다 — 저장된 자책골 표시가 지워지면 안 된다."""
        with SessionLocal() as db:
            e = db.get(Event, self.shot)
            e.is_own_goal, e.is_goal = True, True
            db.commit()
        r = self.admin.patch(f"/api/admin/matches/{self.archived}/timeline-items/EVENT/{self.shot}",
                             json={"kind": "EVENT", "type": "XG", "clock_ms": 1_000_000, "team": "AWAY", "xg": 0.0, "is_goal": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.event(self.shot).is_own_goal)

    def test_reads(self):
        d = self.anon.get(f"/api/agent/fla/matches/{self.archived}", headers=self.h()).json()["data"]
        self.assertEqual(d["score"], {"HOME": 2, "AWAY": 1})
        self.assertEqual(d["markers"][0]["previous_period_clock"], "45+2:00")
        self.assertNotIn("metadata", d)
        self.assertEqual(d["lineups"]["HOME"][0], {"number": "7", "name": "홈칠번", "position": None, "is_substitute": False})
        t = self.anon.get(f"/api/agent/fla/matches/{self.archived}/timeline?half=2H", headers=self.h()).json()["data"]
        self.assertEqual([e["label"] for e in t["events"]], ["2H 65:00"])
        listed = self.anon.get("/api/agent/fla/matches?status=LIVE", headers=self.h()).json()
        self.assertEqual([m["match_id"] for m in listed["data"]], [str(self.live)])
        self.assertNotIn(str(self.basketball), self.anon.get("/api/agent/fla/matches", headers=self.h()).text)
        rules = self.anon.get("/api/agent/fla/rules", headers=self.h()).json()["data"]
        self.assertIn("대표에게 문의", rules["markdown"])
        self.assertEqual(self.anon.get(f"/api/agent/fla/matches/{self.archived}/result", headers=self.h()).status_code, 200)


    # ── 지시 02(보안 검증 반영) ─────────────────────────────────────────────

    def _make_live_second_half(self):
        """진행 중 경기를 후반으로: 후반 시작 raw 25:00, 지금 raw 40:00(=2H 60:00), 후반 슈팅 하나."""
        with SessionLocal() as db:
            db.add(MatchMarker(match_id=self.live, marker_type="HALFTIME_START", clock_ms=1_500_000, created_at=OLD))
            db.add(State(id=uuid4(), match_id=self.live, clock_ms=2_400_000, running=True, possession_team="HOME",
                         selected_team="HOME", attack_lr="L2R", created_at=datetime.utcnow() + timedelta(seconds=1)))
            db.add(self._ev(uuid4(), self.live, 1_800_000, "AWAY"))
            db.commit()

    def _fla_clock(self):
        snap = self.anon.get(f"/api/broadcast/matches/{self.live}/snapshot").json()
        return snap["match"]["fla_clock"]

    def test_r1_live_period_marker_cannot_move_server_clock(self):
        self._make_live_second_half()
        before = self._fla_clock()
        # 재현 시나리오(검증 R1): 진행 중 후반 시작 표시를 옮겨 지금 시계를 10분 당기려 한다 → plan 단계에서 거부
        r = self.plan(self.live, [{"op": "set_period_start", "period": "2H", "previous_period_clock": "35:00"}])
        self.assertEqual(self.errors(r), ["LIVE_PERIOD_MARKER"])
        self.assertEqual(self._fla_clock(), before)
        # 일반 검사: 어떤 op 로든 진행 중 마커·지금 시계 표시가 바뀌면 거부
        with SessionLocal() as db:
            v = agent_fla._Virtual(db, db.get(Match, self.live))
            marker = next(iter(v.markers.values()))
            marker.clock_ms = 2_100_000
            with self.assertRaises(agent_fla.RuleError) as raised:
                agent_fla._live_clock_guard(v)
            self.assertEqual(raised.exception.code, "LIVE_CLOCK_CHANGE")
            # apply 때도: 진행 중 경기에 마커를 쓰는 변경 묶음은 적용하지 않는다(plan 을 우회해 만든 행이라도)
            token = db.query(AgentFlaToken).filter(AgentFlaToken.token_hash == fingerprint(self.token)).one()
            mid = db.query(MatchMarker).filter(MatchMarker.match_id == self.live).one()
            snap = agent_fla._snap(mid, agent_fla.MARKER_COLS)
            moved = {**snap, "clock_ms": 2_100_000}
            row = AgentFlaChange(token_id=token.id, user_id=token.user_id, actor_name="박기록", match_id=self.live,
                                 status="planned", live=True, request_summary="우회 시도", summary="", ops=[],
                                 items=[{"key": f"marker:{mid.id}", "kind": "marker", "action": "update", "before": snap,
                                         "after": moved, "before_fp": agent_fla._fp(snap), "after_fp": agent_fla._fp(moved)}],
                                 preview={}, created_at=datetime.utcnow(), expires_at=datetime.utcnow() + timedelta(minutes=5))
            db.add(row)
            db.commit()
            plan_id = row.id
        r = self.apply(plan_id)
        self.assertEqual((r.status_code, r.json()["detail"]["reason"]), (409, "live_clock_change"))
        self.assertEqual(self._fla_clock(), before)
        with SessionLocal() as db:
            self.assertEqual(db.query(MatchMarker).filter(MatchMarker.match_id == self.live).one().clock_ms, 1_500_000)
        # 진행 중에도 지난 기록 수정은 그대로 된다(시계 불변)
        self.plan_apply(self.live, [{"op": "update_event", "event_id": str(self.live_goal), "set": {"player_number": "9"}}])
        self.assertEqual(self._fla_clock(), before)
        # 보관 뒤에는 에이전트로 하프 시작 시각을 고칠 수 있다
        self.plan_apply(self.archived, [{"op": "set_period_start", "period": "2H", "previous_period_clock": "45+1:30"}])

    @unittest.skipUnless(QA_DATABASE, "병렬 잠금은 PostgreSQL 에서만 의미가 있다(CI 의 PostgreSQL 작업)")
    def test_r2_parallel_requests_cannot_pass_daily_limits(self):
        with SessionLocal() as db:
            ids = [uuid4() for _ in range(8)]
            db.add_all([Event(id=i, match_id=self.archived, type="ATTACK_LANE", clock_ms=300_000 + n * 10_000, team="AWAY",
                              lane="LEFT", created_at=OLD) for n, i in enumerate(ids)])
            db.commit()
        plans = [self.plan(self.archived, [{"op": "update_event", "event_id": str(i), "set": {"lane": "RIGHT"}}]).json()["data"]["plan_id"]
                 for i in ids]
        results, barrier = [], threading.Barrier(len(plans))

        def go(pid):
            client = TestClient(main.app)
            barrier.wait()
            results.append(client.post(f"/api/agent/fla/plans/{pid}/apply", headers=self.h()).status_code)
            client.close()

        with patch.object(agent_fla, "DAILY_WRITES", 3):
            threads = [threading.Thread(target=go, args=(p,)) for p in plans]
            [t.start() for t in threads]
            [t.join() for t in threads]
        self.assertEqual(sorted(results), [200] * 3 + [429] * 5)
        with SessionLocal() as db:
            self.assertEqual(db.query(AgentFlaChange).filter(AgentFlaChange.status == "applied").count(), 3)
        # 하루 plan 한도도 같은 방식
        agent_fla.rate_limiter.reset()
        results.clear()
        barrier = threading.Barrier(6)

        def plan_go():
            client = TestClient(main.app)
            barrier.wait()
            results.append(client.post(f"/api/agent/fla/matches/{self.archived}/plan", headers=self.h(),
                                       json={"request_summary": "병렬", "ops": [{"op": "delete_event", "event_id": str(self.shot)}]}).status_code)
            client.close()

        with SessionLocal() as db:
            used = db.query(AgentFlaChange).count()
        with patch.object(agent_fla, "DAILY_PLANS", used + 2):
            threads = [threading.Thread(target=plan_go) for _ in range(6)]
            [t.start() for t in threads]
            [t.join() for t in threads]
        self.assertEqual(sorted(results), [200] * 2 + [429] * 4)

    def test_r3_deactivated_admin_token_stops_and_bootstrap_revokes(self):
        r = self.admin.post("/api/admin/agent-fla/tokens", json={"person_name": "관리자", "user_id": "admin"})
        self.assertEqual(r.status_code, 200, r.text)
        admin_token = r.json()["token"]
        self.assertEqual(self.anon.get("/api/agent/fla/me", headers=self.h(admin_token)).status_code, 200)
        with SessionLocal() as db:
            db.get(AdminAccount, "admin").active = False
            db.commit()
        r = self.anon.get("/api/agent/fla/me", headers=self.h(admin_token))
        self.assertEqual((r.status_code, r.json()["detail"]), (401, "이 토큰에 묶인 관리자 계정이 비활성입니다."))
        self.assertEqual(self.plan(self.archived, [{"op": "delete_event", "event_id": str(self.shot)}], token=admin_token).status_code, 401)
        # 매니페스트에서 빠져 비활성화되면 토큰도 폐기된다
        with SessionLocal() as db:
            db.get(AdminAccount, "admin").active = True
            db.commit()
        manifest = Path(ROOT.name) / "admins.json"
        manifest.write_text(json.dumps({"version": 1, "accounts": [{"login": "boss", "name": "보스", "password_hash": self.password_hash}]}))
        with SessionLocal() as db:
            auth.bootstrap_admin_accounts(db, str(manifest))
        with SessionLocal() as db:
            row = db.query(AgentFlaToken).filter(AgentFlaToken.token_hash == fingerprint(admin_token)).one()
            self.assertIsNotNone(row.revoked_at)
            self.assertEqual(row.revoked_by, "system:admin_deactivated")
            self.assertTrue(db.query(AuditLog).filter(AuditLog.action == "AGENT_FLA_TOKEN_REVOKED", AuditLog.target_id == row.id).count())
            staff = db.query(AgentFlaToken).filter(AgentFlaToken.token_hash == fingerprint(self.token)).one()
            self.assertIsNone(staff.revoked_at)  # 직원 토큰은 그대로

    def test_l2_tombstone_only_for_same_match_and_kind(self):
        other_live = uuid4()
        with SessionLocal() as db:
            db.add(Match(id=other_live, name="[K3 | 3R] A vs B", sport="FOOTBALL", operator_id="op", metadata_json={}, created_at=OLD))
            db.commit()
        with patch.object(agent_fla, "LIVE_SETTLE_SECONDS", 0):
            gone = uuid4()
            body = {"event_id": str(gone), "clock_ms": 1_200_000, "team": "HOME", "xg": 0.1, "shot_x": 92.0, "shot_y": 30.0}
            self.assertEqual(self.op.post(f"/api/matches/{self.live}/events/xg", json=body).status_code, 200)
            self.plan_apply(self.live, [{"op": "delete_event", "event_id": str(gone)}])
        r = self.op.post(f"/api/matches/{self.live}/events/xg", json=body)
        self.assertEqual((r.status_code, r.json().get("deleted_by_agent")), (200, True))
        r = self.op.post(f"/api/matches/{other_live}/events/xg", json=body)
        self.assertEqual(r.status_code, 409)
        r = self.op.post(f"/api/matches/{self.live}/events/attack_lane", json={"event_id": str(gone), "clock_ms": 1_200_000, "team": "HOME", "lane": "LEFT"})
        self.assertEqual(r.status_code, 409)
        with SessionLocal() as db:
            self.assertIsNone(db.get(Event, gone))

    def test_l3_flag_values(self):
        cases = {None: True, "1": True, "true": True, "YES": True, " on ": True,
                 "0": False, "false": False, "off": False, "disabled": False, "enabled": False, "": False, "2": False}
        for value, expected in cases.items():
            with self.subTest(value=value):
                env = {k: v for k, v in os.environ.items() if k != "I68_FLAG"}
                if value is not None:
                    env["I68_FLAG"] = value
                with patch.dict(os.environ, env, clear=True):
                    self.assertIs(agent_fla._env_flag("I68_FLAG"), expected)

    def test_l4_admin_can_revert_after_token_revoked(self):
        _p, a = self.plan_apply(self.live, [{"op": "update_event", "event_id": str(self.live_goal), "set": {"is_goal": False}}])
        self.assertFalse(self.event(self.live_goal).is_goal)
        url = f"/api/admin/agent-fla/changes/{a['change_id']}/revert"
        self.assertEqual(self.anon.post(url, headers=self.h()).status_code, 401)  # 토큰으로는 안 됨
        self.assertEqual(self.op.post(url).status_code, 403)  # 운영자 세션도 안 됨
        tid = next(t["id"] for t in self.admin.get("/api/admin/agent-fla/tokens").json()["items"] if t["person_name"] == "박기록")
        self.admin.post(f"/api/admin/agent-fla/tokens/{tid}/revoke")
        r = self.admin.post(url)
        self.assertEqual((r.status_code, r.json()["status"], r.json()["reverted_by"]), (200, "reverted", "관리자"))
        self.assertTrue(self.event(self.live_goal).is_goal)
        with SessionLocal() as db:
            audit = db.query(AuditLog).filter(AuditLog.action == "AGENT_FLA_REVERT").one()
            self.assertEqual((audit.actor_name, audit.actor_role, audit.details["by_admin"], audit.details["staff"]),
                             ("관리자", "SUPERADMIN", True, "박기록"))
        notes = self.op.get(f"/api/matches/{self.live}/agent-edits").json()["items"]
        self.assertTrue(notes[0]["message"].startswith("관리자님이 박기록님의 수정을 되돌렸습니다"))
        self.assertEqual(self.admin.post(url).status_code, 409)  # 두 번은 안 됨
        # 충돌 검사도 같다: 적용 뒤 같은 기록이 바뀌었으면 거부
        token2 = self.issue("박기록")
        _p, b = self.plan_apply(self.archived, [{"op": "update_event", "event_id": str(self.goal1), "set": {"player_number": "9"}}], token=token2)
        self.plan_apply(self.archived, [{"op": "update_event", "event_id": str(self.goal1), "set": {"at": {"half": "1H", "clock": "11:00"}}}], token=token2)
        r = self.admin.post(f"/api/admin/agent-fla/changes/{b['change_id']}/revert")
        self.assertEqual((r.status_code, r.json()["detail"]["reason"]), (409, "changed_after_apply"))

    # ── 지시 03(한도 기본 해제) ─────────────────────────────────────────────

    def test_d03_limits_are_off_by_default_and_can_be_enabled(self):
        # 이 테스트 프로세스에는 AGENT_FLA_* 한도 환경변수가 없다 → 전부 한도 없음
        for name in ("RATE_PER_MINUTE", "WRITE_RATE_PER_MINUTE", "DAILY_WRITES", "DAILY_PLANS", "MAX_ITEMS"):
            self.assertIsNone(getattr(agent_fla, name), name)
        for raw, expected in ((None, None), ("", None), ("0", None), ("-3", None), ("abc", None), (" 5 ", 5)):
            with self.subTest(raw=raw):
                env = {k: v for k, v in os.environ.items() if k != "I68_LIMIT"}
                if raw is not None:
                    env["I68_LIMIT"] = raw
                with patch.dict(os.environ, env, clear=True):
                    self.assertEqual(agent_fla._env_limit("I68_LIMIT"), expected)
        # 분당 호출 한도 없음
        self.assertEqual({self.anon.get("/api/agent/fla/me", headers=self.h()).status_code for _ in range(80)}, {200})
        me = self.anon.get("/api/agent/fla/me", headers=self.h()).json()["data"]["limits"]
        self.assertEqual((me["writes_per_day"], me["items_per_plan"], me["calls_per_minute"]), (None, None, None))
        # 한 번 항목 수 한도 없음: 25건을 한 plan 으로
        with SessionLocal() as db:
            ids = [uuid4() for _ in range(25)]
            db.add_all([Event(id=i, match_id=self.archived, type="ATTACK_LANE", clock_ms=300_000 + n * 10_000, team="AWAY",
                              lane="LEFT", created_at=OLD) for n, i in enumerate(ids)])
            db.commit()
        ops = [{"op": "update_event", "event_id": str(i), "set": {"lane": "RIGHT"}} for i in ids]
        self.assertEqual(self.plan(self.archived, ops).json()["data"]["item_count"], 25)
        # 하루 수정 한도 없음: 연달아 적용·되돌리기
        for i in ids[:5]:
            _p, a = self.plan_apply(self.archived, [{"op": "update_event", "event_id": str(i), "set": {"lane": "CENTER"}}])
            self.assertEqual(self.anon.post(f"/api/agent/fla/changes/{a['change_id']}/revert", headers=self.h()).status_code, 200)
        # 설정으로 켜면 건다(MAX_ITEMS=0 은 이제 '전부 거부'가 아니라 '없음')
        with patch.object(agent_fla, "MAX_ITEMS", 20):
            self.assertEqual(self.errors(self.plan(self.archived, ops)), ["TOO_MANY_ITEMS"])
        with patch.dict(os.environ, {"AGENT_FLA_MAX_ITEMS": "0"}):
            self.assertIsNone(agent_fla._env_limit("AGENT_FLA_MAX_ITEMS"))
        with patch.object(agent_fla, "ITEMS_SAFETY_MAX", 10):
            self.assertEqual(self.errors(self.plan(self.archived, ops)), ["REQUEST_TOO_LARGE"])

if __name__ == "__main__":
    unittest.main()
