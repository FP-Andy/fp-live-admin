"""xFP 검증 조회(T6, 2026-11-25) — REST·MCP 가 같은 조회 서비스를 쓰는지, 조인·누락 사유·권한·허용 목록·읽기 전용.

고정하는 것
1. 권한: REST 는 관리자 세션만(비로그인·운영자 차단). MCP 는 읽기 토큰만(없음·틀림·미설정 401, 허용 안 된 Origin 403).
2. 조인: requestId(+side)+clipKey+seq. 어긋난 행(팀·코드·등번호)·FPC 에만/저장본에만 있는 행·신청 미연결 행이
   사유 코드와 함께 **남는다**(집계에서 사라지지 않음).
3. 자체전: A 묶음은 A 원래 클립 + A 저장본, B 묶음은 B 원래 클립 + B 짝 저장본 — 값이 섞이지 않는다.
4. 미계산 null 과 관측된 0 구분, xrc = receptionXg.
5. 같은 필터면 REST 와 MCP 의 행 수·집계가 같고, 페이지를 순회해도 중복·누락이 없다.
6. 응답에 이름·playerId·userId·스토리지 키·서명 URL 이 없다. 조회를 반복해도 잡·클립·액션이 바뀌지 않는다.
7. 듀얼: 원본 장면 행과 확실히 맞을 때만 original(유효 태깅 수, 잔상·중복 제외), 아니면 좌표 없음.

Run (실제 앱 라우트, 임시 SQLite, 네트워크 차단 — test_match_write_access 픽스처):
  PYTHONPATH=apps/api:apps/api/tests python -m unittest test_xfp_validation -v
"""
import copy
import json
from datetime import datetime, timedelta
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_match_write_access as fixture  # noqa: E402  (환경변수·네트워크 차단·SQLite JSONB 를 먼저 건다)
from fastapi.testclient import TestClient  # noqa: E402
from app import auth, main, xfp_validation as svc, xfp_validation_api as api  # noqa: E402
from app.auth_security import fingerprint, hash_secret  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.models import (  # noqa: E402
    AdminAccount, AuditLog, AuthSession, HighlightClip, HighlightClipAction, HighlightJob, OperatorAccessPolicy, User,
)

MCP_TOKEN = "mcp-test-token-only"
LINEUP_A = [{"playerId": "101", "name": "김에이", "jerseyNumber": 7}]
LINEUP_B = [{"playerId": "201", "name": "이비", "jerseyNumber": 9}]

# 원본 장면 — seq1(Key Pass·홈 7)·seq2(Shot·홈 10) 은 행과 맞고, seq3 행은 등번호가 달라(5 vs 4) 연결하지 않는다.
SCENES_460 = {"schema": 1, "scenes": [
    {"rows": [
        {"Team": "home", "Player": "7", "Action": "Pass", "Tags": "Key Pass", "Time": "00:02", "Coord": "60,30"},
        {"Team": "home", "Player": "10", "Action": "Shot", "Time": "00:04", "Coord": "95,34"},
    ], "beforeDots": [
        {"id": "h7", "teamSide": "home", "number": "7", "meter_x": 60, "meter_y": 30},
        {"id": "h10", "teamSide": "home", "number": "10", "meter_x": 80, "meter_y": 40},
        {"id": "h10", "teamSide": "home", "number": "10", "meter_x": 80, "meter_y": 40},   # 같은 id 중복
        {"id": "a4", "team": "opponent", "number": "4", "meter_x": 85, "meter_y": 35},     # 상대(절대 편 없음 → 행위자 기준)
        {"id": "g1", "teamSide": "away", "ghost": True, "meter_x": 1, "meter_y": 1},     # 잔상
    ], "afterDots": [
        {"id": "h10", "teamSide": "home", "number": "10", "meter_x": 95, "meter_y": 34},
        {"id": "a4", "teamSide": "away", "number": "4", "meter_x": 90, "meter_y": 34},
        {"id": "a5", "teamSide": "away", "number": "5", "meter_x": 90, "meter_y": 34},  # 같은 편 같은 좌표 중복
    ], "passArrows": [{"side": "before", "x1": 60, "y1": 30, "x2": 80, "y2": 40, "code": "p"}], "primary": 0},
    {"rows": [{"Team": "away", "Player": "5", "Action": "Tackle", "Time": "00:00"}],
     "beforeDots": [], "afterDots": [], "passArrows": []},
]}


def published(target, request_id, side, resolved, clips, status="FOUND"):
    return {"target": target, "requestId": request_id, "side": side, "resolvedRequestId": resolved,
            "status": status, "requestStatus": "DONE" if status == "FOUND" else None,
            "pipelineVersion": "xFP v0.2" if clips else None, "clipCount": len(clips), "clips": clips}


def pclip(key, actions, *, fpc_key=None, display=False):
    return {"clipKey": key, "fpcClipKey": fpc_key or key, "startTimeSeconds": 100.0, "endTimeSeconds": 112.0,
            "mainAction": "Pass", "pipelineVersion": "xFP v0.2", "displayOnly": display, "actions": actions}


def pact(seq, code, team, jersey, *, score=None, pc=None, epv=None, xg=None, xgot=None, xrc=None, start=None):
    return {"seq": seq, "actionCode": code, "teamSide": team, "jersey": jersey, "xfpScore": score,
            "xfpPercentile": None, "xg": xg, "xgot": xgot, "epv": epv, "pc": pc, "xrc": xrc,
            "clipPrimary": seq == 1, "startOffset": start, "endOffset": None, "storedIn": "both"}


PUBLISHED = {
    "460": published("460", 460, None, 460, [
        pclip("fpc-460-001", [
            pact(1, "G2", "home", "7", score=82, pc=0.466, epv=0.0, xrc=0.093, start=2.0),
            pact(2, "G1", "away", "10", score=98, xg=0.104, xgot=0.0),             # 팀이 다르다 → TEAM_MISMATCH
            pact(3, "S9", "away", "8"),                                            # 등번호가 다르다 → JERSEY_MISMATCH
            pact(4, "P1", "home", "11", score=60, pc=0.1, epv=0.2, xrc=0.05),      # FPC 에 없음 → FPC_ACTION_MISSING
        ]),
        pclip("fpc-460-gone", [pact(1, "P1", "home", "3", pc=0.2, epv=0.1, xrc=0.0)]),  # FPC 클립 없음
    ]),
    "470:A": published("470:A", 470, "A", 470, [
        pclip("fpc-470-001", [pact(1, "G2", "home", "7", pc=0.11, epv=0.22, xrc=0.5, score=70)]),
        pclip("fpc-470-003", [pact(1, None, "away", None)], display=True),
    ]),
    "470:B": published("470:B", 470, "B", 9470, [
        pclip("fpc-470-002:B", [pact(1, "G2", "away", "9", pc=0.99, epv=0.88, xrc=0.9, score=91)], fpc_key="fpc-470-002"),
        pclip("fpc-470-003:B", [pact(1, "G1", "away", "9", xg=0.3, score=95)], fpc_key="fpc-470-003"),
    ]),
    "480": published("480", 480, None, 480, [pclip("fpc-480-001", [pact(1, "P3", "home", "7", pc=0.0, epv=None)])]),
    "481": published("481", 481, None, None, [], status="NOT_FOUND"),
}


class FakeFetcher:
    def __init__(self, data=None, fail=False):
        self.data = data if data is not None else PUBLISHED
        self.fail = fail
        self.calls = []

    def __call__(self, targets):
        self.calls.append(list(targets))
        if self.fail:
            return {t: {"target": t, "status": "BACKEND_UNAVAILABLE", "clips": []} for t in targets}
        return {t: copy.deepcopy(self.data[t]) for t in targets if t in self.data}


class XfpValidationTest(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        svc.clear_cache()
        self.clients = {}
        pw = hash_secret("synthetic-test-only")
        with SessionLocal() as db:
            db.add(OperatorAccessPolicy(id="operator", code_hash=pw, version="test"))
            for name, role in (("admin", "SUPERADMIN"), ("op", "OPERATOR")):
                db.add(User(id=name, name=name, role=role))
                db.flush()
                if role == "SUPERADMIN":
                    db.add(AdminAccount(login=name, user_id=name, password_hash=pw, active=True))
                token = "v2_" + uuid4().hex
                db.add(AuthSession(token_hash=fingerprint(token), user_id=name, role=role,
                                   credential_version=fingerprint(pw) if role == "SUPERADMIN" else "test",
                                   expires_at=datetime.utcnow() + timedelta(hours=1)))
                client = TestClient(main.app)
                client.cookies.set(auth.COOKIE_NAME, token)
                self.clients[name] = client
            self.clients["anon"] = TestClient(main.app)
            self._seed(db)
            db.commit()
        self.fetcher = FakeFetcher()
        main.app.dependency_overrides[api.get_fetcher] = lambda: self.fetcher
        self.addCleanup(main.app.dependency_overrides.clear)
        env = patch.dict(os.environ, {"FPC_XFP_MCP_TOKEN": MCP_TOKEN, "FPC_XFP_MCP_ALLOWED_ORIGINS": "",
                                      "FPC_CONSOLE_BASE_URL": "https://console.test"})
        env.start()
        self.addCleanup(env.stop)
        self.mcp = TestClient(main.app)
        # 서명 URL·원본 영상 경로를 부르면 바로 실패하게 — 조회는 스토리지에 닿지 않는다.
        guard = patch.object(main, "highlight_default_storage", side_effect=AssertionError("storage must not be used"))
        guard.start()
        self.addCleanup(guard.stop)

    def tearDown(self):
        for c in list(self.clients.values()) + [self.mcp]:
            c.close()

    # ── 픽스처 ──
    def _seed(self, db):
        t0 = datetime(2026, 11, 20, 3, 0, 0)
        jobs = [
            ("fpc-460", t0, {"analysis_request_id": 460, "clip_archived": True, "callback_status": "sent",
                             "manifest": {"lineup": LINEUP_A}, "fpa_link": {"our_side": "home"},
                             "display_name": "일반 경기 #460"}),
            ("fpc-470", t0 + timedelta(hours=1), {
                "analysis_request_id": 470, "callback_status": "sent", "fpa_link": {"our_side": "home"},
                "manifest": {"matchKind": "SCRIMMAGE", "lineup": LINEUP_A, "opponentLineup": LINEUP_B},
                "scrimmage": {"A": {"side": "home", "callback_status": "sent"}, "B": {"side": "away", "callback_status": "sent"}},
                "display_name": "자체전 #470"}),
            ("fpc-480", t0 + timedelta(hours=2), {"standalone": True, "display_name": "사전 작업",
                                                  "links": {"home": {"analysis_request_id": "480", "lineup": LINEUP_A},
                                                            "away": {"analysis_request_id": "481", "lineup": LINEUP_B}}}),
            ("fpc-999", t0 + timedelta(hours=3), {"display_name": "대회(신청 없음)"}),
        ]
        for jid, created, meta in jobs:
            db.add(HighlightJob(id=jid, mode="fineplay", status="done", job_metadata=meta, created_at=created))
        db.add(HighlightJob(id="other-ai", mode="ai", status="done", job_metadata={"analysis_request_id": 460}))
        clips = [
            # (id, job, order, team_side, is_goal, render?, scenes)
            ("fpc-460-001", "fpc-460", 0, "home", False, True, SCENES_460),
            ("fpc-460-002", "fpc-460", 1, "home", False, False, None),
            ("fpc-470-001", "fpc-470", 0, "home", False, True, None),
            ("fpc-470-002", "fpc-470", 1, "away", False, True, None),
            ("fpc-470-003", "fpc-470", 2, "away", True, True, None),
            ("fpc-480-001", "fpc-480", 0, "home", False, True, None),
            ("fpc-480-002", "fpc-480", 1, "away", False, True, None),
            ("fpc-999-001", "fpc-999", 0, "home", False, True, None),
        ]
        for cid, jid, order, side, goal, render, scenes in clips:
            db.add(HighlightClip(id=cid, job_id=jid, order_index=order, team_side=side, is_goal=goal,
                                 source_video_id="src-video-secret", start_sec=100.0, end_sec=112.0,
                                 duration_seconds=12.0, fpa_scenes=scenes,
                                 horizontal_s3_key=f"highlights/secret/{cid}.mp4" if render else None,
                                 thumbnail_s3_key=f"highlights/secret/{cid}.jpg"))
        # (clip, seq, action, team, jersey, name, pid, uid, metrics, start, extra)
        actions = [
            ("fpc-460-001", 1, "Pass", "home", "7", "김에이", "101", 101,
             dict(pc=0.466, epv=0.0, reception_xg=0.093, xg=None), 2.0, {"tags": "Key Pass", "x": 60, "y": 30, "groupIndex": 1}),
            ("fpc-460-001", 2, "Shot", "home", "10", None, None, None, dict(xg=0.104, xgot=0.0), 5.0,
             {"tags": "On Target", "x": 95, "y": 34}),
            ("fpc-460-001", 3, "Tackle", "away", "4", None, None, None, {}, None, None),
            ("fpc-460-002", 1, "Pass", "home", "7", "김에이", "101", 101, dict(pc=0.2, epv=0.1, reception_xg=0.01), 1.0,
             {"tags": "Key Pass"}),
            ("fpc-470-001", 1, "Pass", "home", "7", "김에이", "101", 101, dict(pc=0.1, epv=0.2, reception_xg=0.4), 1.0,
             {"tags": "Key Pass"}),
            ("fpc-470-002", 1, "Pass", "away", "9", "이비", "201", 201, dict(pc=0.9, epv=0.8, reception_xg=0.8), 1.0,
             {"tags": "Key Pass"}),
            ("fpc-470-003", 1, "Shot", "away", "9", "이비", "201", 201, dict(xg=0.3), 1.0, {"tags": "Goal"}),
            ("fpc-480-001", 1, "Pass", "home", "7", None, None, None, dict(pc=0.0), 1.0, None),
            ("fpc-480-002", 1, "Pass", "away", "9", None, None, None, dict(pc=0.3), 1.0, None),
            ("fpc-999-001", 1, "Pass", "home", "7", None, None, None, dict(pc=0.3, epv=0.1, reception_xg=0.2), 1.0,
             {"tags": "Key Pass"}),
        ]
        for n, (cid, seq, name, team, jersey, pname, pid, uid, metrics, start, extra) in enumerate(actions, start=1):
            db.add(HighlightClipAction(id=n, clip_id=cid, seq=seq, action_name=name, team_side=team, jersey=jersey,
                                       player_name=pname, player_id=pid, user_id=uid, start_offset=start,
                                       end_offset=None, extra=extra, **metrics))

    # ── 호출 도우미 ──
    def rest(self, path, client="admin", **params):
        return self.clients[client].get(f"/api/highlight/xfp-validation/{path}", params=params)

    def rpc(self, method, params=None, *, token=MCP_TOKEN, rid=1, headers=None):
        h = {"Authorization": f"Bearer {token}"} if token is not None else {}
        h.update(headers or {})
        body = {"jsonrpc": "2.0", "method": method, **({"id": rid} if rid is not None else {})}
        if params is not None:
            body["params"] = params
        return self.mcp.post(api.MCP_PATH, json=body, headers=h)

    def tool(self, name, args=None):
        r = self.rpc("tools/call", {"name": name, "arguments": args or {}})
        self.assertEqual(r.status_code, 200, r.text)
        result = r.json()["result"]
        self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
        return result

    def all_rows(self, **filters):
        return self.tool("search_xfp_actions", {**filters, "limit": 200})["structuredContent"]["actions"]

    def row(self, key):
        return next(r for r in self.all_rows() if r["rowKey"] == key)

    def snapshot(self):
        with SessionLocal() as db:
            return (
                sorted((j.id, json.dumps(j.job_metadata, sort_keys=True, ensure_ascii=False)) for j in db.query(HighlightJob)),
                sorted((c.id, c.start_sec, c.end_sec, json.dumps(c.fpa_scenes, sort_keys=True)) for c in db.query(HighlightClip)),
                sorted((a.clip_id, a.seq, a.action_name, a.pc, a.epv, a.start_offset) for a in db.query(HighlightClipAction)),
            )

    # ── 1. 권한 ──
    def test_rest_requires_admin_session(self):
        self.assertIn(self.rest("actions", client="anon").status_code, (401, 403))
        self.assertEqual(self.rest("actions", client="op").status_code, 403)
        # MCP 토큰으로는 콘솔 REST 를 못 연다(이 경로는 Authorization 을 읽지 않는다)
        r = self.clients["anon"].get("/api/highlight/xfp-validation/actions", headers={"Authorization": f"Bearer {MCP_TOKEN}"})
        self.assertIn(r.status_code, (401, 403))
        self.assertEqual(self.rest("actions").status_code, 200)

    def test_mcp_token_gate(self):
        self.assertEqual(self.rpc("tools/list", token=None).status_code, 401)
        self.assertEqual(self.rpc("tools/list", token="wrong").status_code, 401)
        r = self.rpc("tools/list", token=None, headers={"Authorization": MCP_TOKEN})  # Bearer 접두 없음
        self.assertEqual(r.status_code, 401)
        self.assertIn("xfp.validation.read", r.headers.get("www-authenticate", ""))
        # 세션 쿠키로는 MCP 에 못 붙는다
        cookie_only = self.clients["admin"].post(api.MCP_PATH, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(cookie_only.status_code, 401)
        with patch.dict(os.environ, {"FPC_XFP_MCP_TOKEN": "", "FPC_XFP_MCP_TOKEN_NEXT": ""}):
            self.assertEqual(self.rpc("tools/list", token="").status_code, 401)  # 미설정이면 전부 401
        with patch.dict(os.environ, {"FPC_XFP_MCP_TOKEN_NEXT": "rotated-next"}):
            self.assertEqual(self.rpc("tools/list", token="rotated-next").status_code, 200)
        self.assertEqual(self.rpc("tools/list", headers={"Origin": "https://evil.example"}).status_code, 403)
        self.assertEqual(self.mcp.get(api.MCP_PATH).status_code, 405)

    def test_mcp_protocol(self):
        r = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                    "clientInfo": {"name": "t", "version": "0"}})
        self.assertEqual(r.status_code, 200)
        res = r.json()["result"]
        self.assertEqual(res["protocolVersion"], "2025-06-18")
        self.assertIn("tools", res["capabilities"])
        self.assertEqual(self.rpc("notifications/initialized", rid=None).status_code, 202)
        tools = self.rpc("tools/list").json()["result"]["tools"]
        self.assertEqual({t["name"] for t in tools},
                         {"list_xfp_matches", "search_xfp_actions", "get_xfp_action_detail", "summarize_xfp"})
        self.assertTrue(all(t["annotations"]["readOnlyHint"] for t in tools))
        self.assertEqual(self.rpc("tools/call", {"name": "send_results", "arguments": {}}).json()["error"]["code"], -32602)
        self.assertEqual(self.rpc("resources/read", {}).json()["error"]["code"], -32601)
        bad = self.tool("search_xfp_actions", {"actionCode": ["G2"]})  # 오타 인자 — 조용히 전체를 주지 않는다
        self.assertTrue(bad["isError"])

    # ── 2·3. 조인·누락 사유·자체전 ──
    def test_join_states_and_reasons_stay_in_results(self):
        rows = {r["rowKey"]: r for r in self.all_rows()}
        k = "fpc-460|-|fpc-460-001|"
        self.assertEqual(rows[k + "1"]["join"], "matched")
        self.assertEqual(rows[k + "1"]["issues"], [])
        self.assertEqual(rows[k + "2"]["join"], "mismatch")
        self.assertIn("TEAM_MISMATCH", rows[k + "2"]["issues"])
        self.assertEqual(rows[k + "3"]["join"], "mismatch")
        self.assertIn("JERSEY_MISMATCH", rows[k + "3"]["issues"])
        self.assertEqual(rows[k + "4"]["join"], "publishedOnly")
        self.assertEqual(rows[k + "4"]["issues"], ["FPC_ACTION_MISSING"])
        self.assertEqual(rows["fpc-460|-|fpc-460-002|1"]["issues"], ["NOT_PUBLISHED"])
        self.assertEqual(rows["fpc-460|-|fpc-460-gone|1"]["issues"], ["FPC_CLIP_MISSING"])
        self.assertFalse(rows["fpc-460|-|fpc-460-gone|1"]["video"]["playable"])
        self.assertEqual(rows["fpc-999|-|fpc-999-001|1"]["issues"], ["NO_REQUEST_LINK"])
        self.assertEqual(rows["fpc-480|away|fpc-480-002|1"]["issues"], ["REQUEST_NOT_FOUND"])
        # 다른 모드(ai) 작업은 범위가 아니다
        self.assertFalse(any(r["jobId"] == "other-ai" for r in rows.values()))
        summary = self.tool("summarize_xfp")["structuredContent"]
        self.assertEqual(summary["scope"]["rows"], len(rows))
        self.assertEqual(sum(summary["join"].values()), len(rows))
        self.assertEqual(summary["issues"]["NO_REQUEST_LINK"], 1)

    def test_scrimmage_sides_do_not_mix(self):
        a = self.all_rows(jobIds=["fpc-470"], side=["A"])
        b = self.all_rows(jobIds=["fpc-470"], side=["B"])
        self.assertEqual([r["clipKey"] for r in a], ["fpc-470-001"])  # A 표시용 골(003)은 점수 대상이 아니다
        self.assertEqual([r["clipKey"] for r in b], ["fpc-470-002", "fpc-470-003"])
        self.assertEqual(a[0]["published"]["pc"], 0.11)
        self.assertEqual(a[0]["requestId"], 470)
        self.assertEqual(b[0]["published"]["pc"], 0.99)
        self.assertEqual(b[0]["resolvedRequestId"], 9470)
        self.assertEqual(b[0]["published"]["clipKey"], "fpc-470-002:B")
        self.assertEqual(b[1]["published"]["actionCode"], "G1")
        self.assertTrue(all(r["join"] in ("matched", "mismatch") for r in a + b))
        self.assertIn("side=B", b[0]["video"]["consoleUrl"])
        # 백엔드에는 묶음별 대상으로 물었다
        asked = {t for call in self.fetcher.calls for t in call}
        self.assertEqual(asked, {"470:A", "470:B"})

    def test_null_and_zero_are_distinct(self):
        r1 = self.row("fpc-460|-|fpc-460-001|1")
        self.assertEqual(r1["published"]["epv"], 0.0)
        self.assertIsNone(r1["published"]["xg"])
        self.assertEqual(r1["published"]["xrc"], 0.093)
        self.assertEqual(r1["fpcCurrent"]["epv"], 0.0)
        self.assertIsNone(r1["fpcCurrent"]["xg"])
        self.assertEqual(r1["fpcCurrent"]["xrc"], 0.093)
        r = self.row("fpc-480|home|fpc-480-001|1")
        self.assertEqual(r["published"]["pc"], 0.0)
        self.assertIsNone(r["published"]["epv"])
        s = self.tool("summarize_xfp", {"jobIds": ["fpc-480"]})["structuredContent"]
        self.assertEqual(s["models"]["pc"]["publishedPresent"], 1)
        self.assertEqual(s["models"]["pc"]["publishedZero"], 1)
        self.assertEqual(s["models"]["epv"]["publishedPresent"], 0)
        # hasModels 는 0 을 '있음' 으로 센다
        self.assertEqual(len(self.all_rows(jobIds=["fpc-480"], hasModels=["pc"])), 1)

    def test_example_key_pass_with_pc_epv_xrc(self):
        rows = self.all_rows(actions=["Key Pass"], hasModels=["pc", "epv", "xrc"])
        self.assertEqual(sorted(r["rowKey"] for r in rows),
                         ["fpc-460|-|fpc-460-001|1", "fpc-470|A|fpc-470-001|1", "fpc-470|B|fpc-470-002|1"])
        for r in rows:
            self.assertIn("clipId=", r["video"]["consoleUrl"])
            self.assertIn("&t=", r["video"]["consoleUrl"])
        # fpcCurrent 기준이면 저장본이 없는 FPC 값도 잡힌다(460-002·999-001)
        cur = self.all_rows(actions=["Key Pass"], hasModels=["pc", "epv", "xrc"], valueSource="fpcCurrent")
        self.assertEqual(len(cur), 5)
        self.assertEqual(len(self.all_rows(minValue={"pc": 0.4}, hasModels=["pc"])), 2)

    # ── 5. REST = MCP, 페이지 ──
    def test_rest_and_mcp_agree_and_paging_is_complete(self):
        filters = {"hasModels": ["pc"]}
        mcp_rows = self.all_rows(**filters)
        rest = self.rest("actions", hasModels="pc", limit=200).json()
        self.assertEqual(rest["total"], len(mcp_rows))
        self.assertEqual([r["rowKey"] for r in rest["actions"]], [r["rowKey"] for r in mcp_rows])
        self.assertEqual(self.rest("summary", hasModels="pc").json(),
                         self.tool("summarize_xfp", filters)["structuredContent"])
        self.assertEqual(self.rest("matches").json(), self.tool("list_xfp_matches")["structuredContent"])
        # limit=2 로 끝까지 순회 — 중복·누락 없음
        seen, cursor = [], None
        while True:
            page = self.tool("search_xfp_actions", {**filters, "limit": 2, **({"cursor": cursor} if cursor else {})})
            data = page["structuredContent"]
            seen += [r["rowKey"] for r in data["actions"]]
            cursor = data["nextCursor"]
            if not cursor:
                break
        self.assertEqual(seen, [r["rowKey"] for r in mcp_rows])
        self.assertEqual(len(seen), len(set(seen)))
        # 필터를 바꾼 커서는 거절
        first = self.tool("search_xfp_actions", {**filters, "limit": 1})["structuredContent"]["nextCursor"]
        bad = self.tool("search_xfp_actions", {"hasModels": ["epv"], "cursor": first})
        self.assertTrue(bad["isError"])
        self.assertEqual(self.rest("actions", hasModels="epv", cursor=first).status_code, 400)

    # ── 6. 허용 목록·읽기 전용·감사 ──
    def test_no_personal_or_storage_fields_and_read_only(self):
        before = self.snapshot()
        bodies = [json.dumps(self.tool(name, args)["structuredContent"], ensure_ascii=False) for name, args in (
            ("list_xfp_matches", {}), ("search_xfp_actions", {"limit": 200}), ("summarize_xfp", {}),
            ("get_xfp_action_detail", {"rowKey": "fpc-460|-|fpc-460-001|1"}),
        )]
        bodies += [self.rest(p).text for p in ("matches", "actions", "summary")]
        for body in bodies:
            for banned in ("김에이", "이비", "playerName", "playerId", "userId", "highlights/secret", "src-video-secret",
                           "sourceVideoId", "S3Key", "s3_key", "X-Amz", "lineup", "video_url", "presigned"):
                self.assertNotIn(banned, body, banned)
        self.assertEqual(self.snapshot(), before)
        # 반복 조회도 같은 값
        self.assertEqual(self.all_rows(), self.all_rows())
        with SessionLocal() as db:
            audits = db.query(AuditLog).filter(AuditLog.target_type == "xfp_validation").all()
            self.assertGreaterEqual(len(audits), 7)
            principals = {a.actor_id for a in audits}
            self.assertIn("mcp-token:current", principals)
            self.assertIn("admin:admin", principals)
            for a in audits:
                self.assertEqual(set(a.details), {"scope", "result"})
                self.assertNotIn("actions", json.dumps(a.details))  # 결과는 숫자 요약만

    def test_backend_unavailable_rows_remain(self):
        self.fetcher.fail = True
        rows = self.all_rows(jobIds=["fpc-460"])
        self.assertTrue(rows)
        self.assertTrue(all("BACKEND_UNAVAILABLE" in r["issues"] for r in rows))
        self.assertTrue(all(r["published"] is None for r in rows))

    # ── 7. 듀얼·영상 시점 ──
    def test_dual_summary_and_detail(self):
        r1 = self.row("fpc-460|-|fpc-460-001|1")
        self.assertEqual(r1["dual"]["source"], "original")
        self.assertEqual(r1["dual"]["sceneIndex"], 1)
        # before: h7·h10(중복 1개 제외)·a4(상대=away) / 잔상 제외 → home 2, away 1
        self.assertEqual(r1["dual"]["before"], {"home": 2, "away": 1, "unknownSide": 0})
        # after: h10, a4, a5(a4 와 같은 편·같은 좌표 → 제외)
        self.assertEqual(r1["dual"]["after"], {"home": 1, "away": 1, "unknownSide": 0})
        self.assertNotIn("coordinates", r1["dual"])  # 좌표는 상세에서만
        r3 = self.row("fpc-460|-|fpc-460-001|3")
        self.assertEqual(r3["dual"]["source"], "missing")  # 행 등번호가 달라 연결 안 함, 원시값도 없음
        self.assertIsNone(r3["dual"]["before"])
        r_other = self.row("fpc-470|A|fpc-470-001|1")
        self.assertEqual(r_other["dual"]["source"], "metricsOnly")
        detail = self.tool("get_xfp_action_detail", {"rowKey": "fpc-460|-|fpc-460-001|1"})["structuredContent"]["action"]
        coords = detail["dual"]["coordinates"]
        self.assertEqual(len(coords["beforeDots"]), 3)
        self.assertEqual(coords["passArrows"][0]["x2"], 80)
        missing = self.tool("get_xfp_action_detail", {"rowKey": "fpc-460|-|fpc-460-001|3"})["structuredContent"]["action"]
        self.assertNotIn("coordinates", missing["dual"])
        self.assertTrue(self.tool("get_xfp_action_detail", {"rowKey": "nope|-|x|1"})["isError"])

    def test_video_time_source_and_links(self):
        r1 = self.row("fpc-460|-|fpc-460-001|1")
        v = r1["video"]
        self.assertEqual((v["clipStartSec"], v["clipEndSec"]), (100.0, 112.0))
        self.assertEqual(v["actionStartSec"], 2.0)
        self.assertEqual(v["timeSource"], "recorded")  # 듀얼 행 Time 00:02 = 저장 오프셋 2.0
        self.assertTrue(v["playable"])
        self.assertEqual(v["consoleUrl"],
                         "https://console.test/admin/highlight/clips?jobId=fpc-460&clipId=fpc-460-001&t=2&ts=recorded")
        r2 = self.row("fpc-460|-|fpc-460-001|2")
        self.assertEqual(r2["video"]["timeSource"], "unknown")  # Time 00:04 ≠ 오프셋 5.0(손으로 맞췄거나 분할)
        r3 = self.row("fpc-460|-|fpc-460-001|3")
        self.assertIsNone(r3["video"]["actionStartSec"])
        self.assertTrue(r3["video"]["consoleUrl"].endswith("&t=0&ts=unknown"))
        nr = self.row("fpc-460|-|fpc-460-002|1")
        self.assertFalse(nr["video"]["playable"])
        self.assertEqual(nr["video"]["unplayableReason"], "NO_RENDERED_CLIP")


if __name__ == "__main__":
    unittest.main()
