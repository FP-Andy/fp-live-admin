"""자체전 '신청 1건, 결과 2경기' (ADR-X-0010, 2026-11-19) — A 묶음·B 묶음 분할 전송.

두 가지를 고정한다.

1. 운영 호환성 — 자체전이 아닌 잡(일반·사전 작업·하이라이트만)의 FinePlay 전송 payload 가
   분할 코드 전후로 **한 바이트도 안 바뀐다.** 기대 해시는 분할 코드를 넣기 전 커밋(68661d0 =
   09d84a1 + origin/main 833be83 + #263)에서 같은 픽스처로 뽑은 값이다. 이 해시가 바뀌면
   운영 FinePlay 로 나가는 계약이 바뀐 것이다 — 의도한 변경인지 먼저 확인할 것.
2. 자체전 분할 — A 묶음(A 클립 + B 골 표시용)·B 묶음(B 클립 + A 골 표시용), 표시용 클립은
   선수 연결 없음, 원래 클립 안 반대편 액션은 식별 필드 없음, 점수는 묶음 관점, 0클립 묶음도 전송,
   재전송 멱등, 잡 메타 묶음별 상태.

Run (실제 앱 라우트, 임시 SQLite, 네트워크 차단 — test_match_write_access 픽스처):
  PYTHONPATH=apps/api:apps/api/tests python -m unittest test_scrimmage_split -v
"""
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_match_write_access as fixture  # noqa: E402
from app.models import HighlightClip, HighlightClipAction, HighlightJob, Match  # noqa: E402

LINEUP_A = [
    {"playerId": "101", "name": "김에이", "jerseyNumber": 7},
    {"playerId": "102", "name": "박에이", "jerseyNumber": 10},
    {"playerId": "103", "name": "최에이", "jerseyNumber": 1},
]
LINEUP_B = [
    {"playerId": "201", "name": "이비", "jerseyNumber": 7},
    {"playerId": "202", "name": "정비", "jerseyNumber": 9},
]
STATE = {"beforeDots": [{"id": "h7", "group": "home", "jersey": "7", "x": 20, "y": 30}],
         "afterDots": [{"id": "h7", "group": "home", "jersey": "7", "x": 60, "y": 40}]}
FINAL = {"home": 2, "away": 1, "confirmed_at": "2026-11-11T03:00:00Z"}

# (clip id 꼬리, team_side, is_goal, [(seq, action, side, jersey, player_id, user_id, extra)])
# player_id 는 '저장 시점' 값이다 — 자체전은 #265 로 반대편도 B 라인업으로 매칭돼 저장된다.
CLIPS = [
    ("001", "home", True, [
        (1, "Pass", "home", "7", "101", 101, {"sceneState": STATE}),
        (2, "Shot", "home", "10", "102", 102, {"tags": "Goal", "x": 90, "y": 50}),
        (3, "Tackle", "away", "9", "202", 202, None),
    ]),
    ("002", "away", True, [
        (1, "Pass", "away", "9", "202", 202, None),
        (2, "Shot", "away", "7", "201", 201, {"tags": "Goal", "x": 10, "y": 50}),
        (3, "Save", "home", "1", "103", 103, None),
    ]),
    ("003", "away", False, [
        (1, "Dribble", "away", "9", "202", 202, None),
    ]),
    ("004", None, False, [
        (1, "Pass", "home", "7", "101", 101, None),
    ]),
    ("005", "home", False, []),
]
# 분할 코드 이전(68661d0)에서 뽑은 해시. 아래 _canon 으로 직렬화한 값.
EXPECTED_SHA256 = {
    "normal": "072004943f8729e3c6eec249f1d1701669e8d7b5994e448538bb3a7f428acf09",
    "normal_basic": "6684777abf840d7743ec07419f755f8a245e5bd50c5dbec1e14bb43c0f6e1052",
    "standalone_home": "72969c3e2c6d8311ae465b1d6a0da4a46556fa348fd24681eda56d4051f5f624",
    "standalone_away": "fd570b4f6fd32f5177b13e1d221b2410e26beebff13bb8a252e369bf456e3ecf",
    "scrimmage_merged_builder": "3d6507d9ef6c0084ef2baa27c42536dc80ba87d58e36d33eaa981fb546af0bfc",
    "resend_normal": "daa79b4e35f24663b1d9fe9ea45a743d68ba81896ea6d341811aedd90cc16e0d",
    "resend_basic": "3a139622d3f0c0585f3ab2d1b13cf5dc48a21693cf855155def7c36358d76c45",
    "resend_standalone_home": "d69f0b96efab2eb270caba80dd9c11c297f16c523d238fb754c0122f10594095",
    "resend_standalone_away": "7b71207fb1e567dab2cda5d6b18e96b4e6b3e4f25961c591f25f7caa4dee6957",
    "callback_normal": "daa79b4e35f24663b1d9fe9ea45a743d68ba81896ea6d341811aedd90cc16e0d",
}


def _canon(payload) -> str:
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _sha(payload) -> str:
    return hashlib.sha256(_canon(payload).encode()).hexdigest()


def _manifest(rid, *, scrimmage=False):
    m = {"analysisRequestId": int(rid), "team": {"teamId": "T1", "teamName": "우리팀"},
         "opponent": {"name": "상대팀"}, "lineup": LINEUP_A}
    if scrimmage:
        m["matchKind"] = "SCRIMMAGE"
        m["opponentLineup"] = LINEUP_B
    return m


def _meta(rid, *, tier="xfp", scrimmage=False, our_side="home", final=True):
    meta = {"analysis_request_id": rid, "manifest": _manifest(rid, scrimmage=scrimmage),
            "fpa_link": {"our_side": our_side},
            "plan": {"tier": tier, "options": ["XFP_SINGLE"] if tier == "xfp" else ["BASIC_HIGHLIGHT"],
                     "source": "manifest"}}
    if final:
        meta["final_score"] = dict(FINAL)
    return meta


def _standalone_meta():
    return {"standalone": True, "plan": {"tier": "xfp", "options": [], "source": "standalone"},
            "final_score": dict(FINAL),
            "links": {
                "home": {"analysis_request_id": "701", "team_id": "TH", "lineup": LINEUP_A,
                         "plan": {"tier": "xfp", "options": ["XFP_SINGLE"], "source": "link"}},
                "away": {"analysis_request_id": "702", "team_id": "TA", "lineup": LINEUP_B,
                         "plan": {"tier": "basic", "options": ["BASIC_HIGHLIGHT"], "source": "link"}},
            }}


class _Base(fixture.MatchWriteAccess):
    def setUp(self):
        super().setUp()
        self.client = self.clients["admin"]
        self.storage = SimpleNamespace(configured=False, bucket="fixture")
        p = patch.object(fixture.main, "highlight_default_storage", return_value=self.storage)
        p.start()
        self.addCleanup(p.stop)
        self.fineplay = SimpleNamespace(configured=True, post_results=Mock(return_value={}))
        p = patch.object(fixture.main, "fineplay_default_client", return_value=self.fineplay)
        p.start()
        self.addCleanup(p.stop)

    _action_id = 0

    def add_job(self, job_id, metadata, *, clips=CLIPS):
        match_id = uuid4()
        with fixture.SessionLocal() as db:
            db.add(Match(id=match_id, name=f"match {job_id}", sport="FOOTBALL", metadata_json={}))
            db.add(HighlightJob(id=job_id, mode="fineplay", status="done", original_filename="x.mp4",
                                job_metadata=metadata))
            db.flush()
            for order, (tail, side, goal, actions) in enumerate(clips):
                clip_id = f"fpc-{job_id}-{tail}"
                db.add(HighlightClip(id=clip_id, job_id=job_id, match_id=match_id, order_index=order,
                                     team_side=side, is_goal=goal, source_video_id="v1",
                                     start_sec=float(order * 10), end_sec=float(order * 10 + 6),
                                     duration_seconds=6.0, main_action="슈팅" if goal else None,
                                     horizontal_s3_key=f"highlights/T1/{job_id}/{clip_id}.mp4",
                                     thumbnail_s3_key=f"highlights/T1/{job_id}/{clip_id}.jpg"))
                db.flush()
                for seq, name, a_side, jersey, pid, uid, extra in actions:
                    type(self)._action_id += 1  # SQLite 는 BigInteger PK 자동 증가가 안 된다
                    db.add(HighlightClipAction(id=type(self)._action_id, clip_id=clip_id, seq=seq, action_name=name, team_side=a_side,
                                               jersey=jersey, player_id=pid, user_id=uid,
                                               player_name=f"선수{pid}", start_offset=float(seq - 1),
                                               end_offset=float(seq), extra=extra))
            db.commit()
        return match_id

    def build(self, job_id, **kwargs):
        with fixture.SessionLocal() as db:
            job = db.get(HighlightJob, job_id)
            clips = (db.query(HighlightClip).filter(HighlightClip.job_id == job_id)
                     .order_by(HighlightClip.order_index).all())
            _job, our_side, labels, _lineup = fixture.main._clip_job_context(db, clips[0])
            kwargs.setdefault("our_side", our_side)
            return fixture.main._build_clip_result_payload(db, clips, job, labels=labels, **kwargs)

    def meta(self, job_id):
        with fixture.SessionLocal() as db:
            return dict(db.get(HighlightJob, job_id).job_metadata or {})

    def sent(self):
        return [c.args[0] for c in self.fineplay.post_results.call_args_list]


class NonScrimmagePayloadUnchangedTest(_Base):
    """운영 호환성 — 자체전이 아닌 잡은 분할 코드 전후 같은 바이트."""

    def check(self, name, payload):
        text = _canon(payload)
        self.assertNotIn("scrimmageSide", text)
        self.assertNotIn("displayOnly", text)
        self.assertEqual(_sha(payload), EXPECTED_SHA256[name], f"{name} payload changed:\n{text}")

    def test_builder_output_is_byte_identical(self):
        self.add_job("501", _meta("501"))
        self.add_job("502", _meta("502", tier="basic"))
        self.add_job("pre-7", _standalone_meta())
        self.add_job("503", _meta("503", scrimmage=True))
        self.check("normal", self.build("501", rid="501", team_id="T1"))
        self.check("normal_basic", self.build("502", rid="502", team_id="T1", include_analysis=False))
        for side, rid, team in (("home", "701", "TH"), ("away", "702", "TA")):
            lineup = LINEUP_A if side == "home" else LINEUP_B
            self.check(f"standalone_{side}", self.build(
                "pre-7", our_side=side, rid=rid, team_id=team, lineup=lineup, side_filter=side))
        # 자체전 잡이라도 분할 인자를 주지 않으면(옛 호출) 출력은 그대로다.
        self.check("scrimmage_merged_builder", self.build(
            "503", rid="503", team_id="T1", opponent_lineup=LINEUP_B))

    def test_resend_endpoint_sends_byte_identical_payloads(self):
        normal = self.add_job("501", _meta("501"))
        basic = self.add_job("502", _meta("502", tier="basic"))
        pre = self.add_job("pre-7", _standalone_meta())
        r = self.client.post(f"/api/highlight/clip-results/matches/{normal}/resend", json={})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"callback_status": "sent", "clips": 5})
        self.check("resend_normal", self.sent()[-1])
        self.assertEqual(self.meta("501")["callback_status"], "sent")
        self.assertNotIn("scrimmage", self.meta("501"))

        r = self.client.post(f"/api/highlight/clip-results/matches/{basic}/resend", json={})
        self.assertEqual(r.status_code, 200, r.text)
        self.check("resend_basic", self.sent()[-1])

        r = self.client.post(f"/api/highlight/clip-results/matches/{pre}/resend", json={})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"callback_status": {"home": "sent", "away": "sent"},
                                    "sides": ["away", "home"]})
        home, away = self.sent()[-2:]
        self.check("resend_standalone_home", home)
        self.check("resend_standalone_away", away)
        self.assertEqual(self.meta("pre-7")["callback_status"], "home: sent, away: sent")

        # 기록해 둔 payload 재전송(잡 단위) — 일반 잡은 저장값 그대로.
        r = self.client.post("/api/highlight/fineplay-jobs/501/resend-callback")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"callback_status": "sent"})
        self.check("callback_normal", self.sent()[-1])
        view = self.client.get("/api/highlight/fineplay-jobs/501/final-score").json()
        self.assertTrue(view["sent"])
        self.assertNotIn("scrimmage", view)


IDENTITY = ("playerId", "userId", "playerName", "jersey")


def _clip(payload, tail):
    return next(c for c in payload["clips"] if c["clipKey"].endswith("-" + tail))


class ScrimmageSplitTest(_Base):
    """자체전 — A 묶음(A 클립 + B 골 표시용)·B 묶음(B 클립 + A 골 표시용)."""

    def setUp(self):
        super().setUp()
        self.match = self.add_job("503", _meta("503", scrimmage=True))
        self.url = f"/api/highlight/clip-results/matches/{self.match}/resend"

    def send(self, **body):
        return self.client.post(self.url, json=body)

    def test_both_bundles_sent_with_own_clips_and_opponent_goals_display_only(self):
        r = self.send()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"callback_status": {"A": "sent", "B": "sent"}, "sides": ["A", "B"],
                                    "scrimmage": True, "clips": {"A": 3, "B": 2}})
        a, b = self.sent()
        for payload, letter in ((a, "A"), (b, "B")):
            self.assertEqual(payload["scrimmageSide"], letter)
            self.assertEqual(payload["analysisRequestId"], "503")   # 두 묶음 모두 원 신청 id
            self.assertEqual(payload["teamId"], "T1")
            self.assertNotIn(":", "".join(c["clipKey"] for c in payload["clips"]))  # 접미사는 서버가 붙인다
        # A = 홈(our_side): 홈 클립 + team_side 없는 옛 클립 + 원정 골(표시용). 원정 장면(003)은 빠진다.
        self.assertEqual([(c["clipKey"][-3:], bool(c.get("displayOnly"))) for c in a["clips"]],
                         [("001", False), ("002", True), ("004", False), ("005", False)])
        # B = 원정: 원정 클립 + 홈 골(표시용). 옛 클립(004)·홈 장면(005)은 빠진다.
        self.assertEqual([(c["clipKey"][-3:], bool(c.get("displayOnly"))) for c in b["clips"]],
                         [("001", True), ("002", False), ("003", False)])

        for payload in (a, b):
            for clip in payload["clips"]:
                if not clip.get("displayOnly"):
                    self.assertNotIn("displayOnly", clip)
                    continue
                # 표시용 — 선수 연결이 하나도 없다. 영상·구간·골·장면 좌표는 그대로.
                self.assertTrue(clip["isGoal"])
                self.assertNotIn("involvedPlayers", clip)
                view = clip["teamView"]
                self.assertEqual(view["highlightTeam"], "OPPONENT")
                self.assertNotIn("mainPlayerName", view)
                for action in view["actions"]:
                    for key in IDENTITY:
                        self.assertNotIn(key, action)
                self.assertTrue(clip["highlightVideo"]["horizontalS3Key"])
                self.assertIn("startTime", clip)
        self.assertTrue(_clip(b, "001")["teamView"]["actions"][0]["sceneData"])

        # 원래 클립 — 그 편 선수만 그 편 라인업으로 연결, 반대편 액션은 식별 필드(등번호 포함)가 없다.
        a1 = _clip(a, "001")["teamView"]["actions"]
        self.assertEqual([x.get("playerId") for x in a1[:2]], ["101", "102"])
        self.assertEqual(a1[0]["userId"], 101)
        for key in IDENTITY:
            self.assertNotIn(key, a1[2])                      # 홈 공격 클립 안 원정 태클
        self.assertEqual({p["playerId"] for p in _clip(a, "001")["involvedPlayers"]}, {"101", "102"})
        self.assertNotIn("9", _clip(a, "001")["teamView"].get("involvedJerseys", []))
        b2 = _clip(b, "002")["teamView"]["actions"]
        self.assertEqual([x.get("playerId") for x in b2[:2]], ["202", "201"])  # B 라인업으로 재매칭
        self.assertEqual(_clip(b, "002")["teamView"]["highlightTeam"], "OURS")
        for key in IDENTITY:
            self.assertNotIn(key, b2[2])                      # 원정 골 클립 안 홈 선방
        self.assertEqual({p["playerId"] for p in _clip(b, "002")["involvedPlayers"]}, {"201", "202"})
        all_a = {p["playerId"] for c in a["clips"] for p in c.get("involvedPlayers") or []}
        all_b = {p["playerId"] for c in b["clips"] for p in c.get("involvedPlayers") or []}
        self.assertTrue(all_a <= {"101", "102", "103"} and all_b <= {"201", "202"}, (all_a, all_b))

        # 점수 — 묶음 관점(A 묶음 우리=A, B 묶음 우리=B).
        self.assertEqual((a["finalScore"]["our"], a["finalScore"]["opponent"]), (2, 1))
        self.assertEqual((b["finalScore"]["our"], b["finalScore"]["opponent"]), (1, 2))

        meta = self.meta("503")
        self.assertEqual(meta["callback_status"], "sent")
        self.assertNotIn("result_payload", meta)           # 합본은 따로 쓰지 않는다
        self.assertEqual({k: (v["side"], v["callback_status"], v["clips"], v["display_clips"], v["player_match"])
                          for k, v in meta["scrimmage"].items()},
                         {"A": ("home", "sent", 3, 1, "3/3"), "B": ("away", "sent", 2, 1, "3/3")})
        self.assertEqual(_canon(meta["scrimmage"]["A"]["result_payload"]), _canon(a))
        self.assertEqual(_canon(meta["scrimmage"]["B"]["result_payload"]), _canon(b))

        rows = self.client.get("/api/highlight/clip-results/matches").json()
        row = next(x for x in rows if x["job_id"] == "503")
        self.assertEqual({k: v["callback_status"] for k, v in row["scrimmage"].items()}, {"A": "sent", "B": "sent"})
        self.assertEqual(row["scrimmage"]["B"]["label"], "B팀")

    def test_zero_clip_bundle_is_still_sent_and_a_follows_our_side(self):
        # A = 원정(our_side away). 원정 장면 클립 하나뿐 — B(홈) 묶음은 클립 0개지만 보낸다.
        match = self.add_job("504", _meta("504", scrimmage=True, our_side="away"),
                             clips=[("001", "away", False, [(1, "Pass", "away", "7", None, None, None)])])
        r = self.client.post(f"/api/highlight/clip-results/matches/{match}/resend", json={})
        self.assertEqual(r.status_code, 200, r.text)
        a, b = self.sent()
        self.assertEqual(len(a["clips"]), 1)
        self.assertEqual(a["clips"][0]["teamView"]["actions"][0]["playerId"], "101")  # 원정 = A 라인업
        self.assertEqual((b["scrimmageSide"], b["clips"]), ("B", []))
        self.assertEqual((a["finalScore"]["our"], b["finalScore"]["our"]), (1, 2))
        self.assertEqual(self.meta("504")["scrimmage"]["B"]["callback_status"], "sent")

    def test_one_bundle_at_a_time_is_idempotent(self):
        r = self.send(side="B")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["callback_status"], {"B": "sent"})
        self.assertEqual([p["scrimmageSide"] for p in self.sent()], ["B"])
        self.assertEqual(self.meta("503")["callback_status"], "A: 안 보냄, B: sent")
        self.assertNotIn("A", self.meta("503")["scrimmage"])
        self.send(side="B")
        first, second = self.sent()
        self.assertEqual(_canon(first), _canon(second))      # 같은 묶음을 다시 보내면 같은 내용
        self.send(side="a")
        self.assertEqual(self.meta("503")["callback_status"], "sent")
        self.assertEqual(self.send(side="C").status_code, 400)
        normal = self.add_job("501", _meta("501"))
        calls = self.fineplay.post_results.call_count
        bad = self.client.post(f"/api/highlight/clip-results/matches/{normal}/resend", json={"side": "A"})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.fineplay.post_results.call_count, calls)

    def test_failed_bundle_is_recorded_and_other_still_sent(self):
        self.fineplay.post_results.side_effect = [None, RuntimeError("HTTP 502")]
        r = self.send()
        self.assertEqual(r.status_code, 502)
        meta = self.meta("503")
        self.assertEqual(meta["scrimmage"]["A"]["callback_status"], "sent")
        self.assertTrue(meta["scrimmage"]["B"]["callback_status"].startswith("failed"))
        self.assertTrue(meta["callback_status"].startswith("A: sent, B: failed"))

    def test_resend_callback_resends_stored_bundles_not_the_merged_payload(self):
        with fixture.SessionLocal() as db:   # produce 가 남긴 합본 — 자체전에선 보내면 안 된다
            job = db.get(HighlightJob, "503")
            job.job_metadata = {**job.job_metadata, "result_payload": {"analysisRequestId": "503", "clips": []}}
            db.commit()
        r = self.client.post("/api/highlight/fineplay-jobs/503/resend-callback")   # 기록 없음 → DB 로 만든다
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"callback_status": {"A": "sent", "B": "sent"}, "sides": ["A", "B"],
                                    "scrimmage": True})
        built = self.sent()
        self.assertEqual([p["scrimmageSide"] for p in built], ["A", "B"])
        r = self.client.post("/api/highlight/fineplay-jobs/503/resend-callback", json={"side": "A"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(_canon(self.sent()[-1]), _canon(built[0]))
        self.assertEqual(self.meta("503")["result_payload"], {"analysisRequestId": "503", "clips": []})

    def test_final_score_change_resends_each_bundle_from_its_own_view(self):
        self.send()
        res = self.client.put("/api/highlight/fineplay-jobs/503/final-score", json={"home": 3, "away": 0})
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body["resent"], {"A": "sent", "B": "sent"})
        self.assertEqual(body["scrimmage"], {"A": "sent", "B": "sent"})
        self.assertTrue(body["sent"])
        a, b = self.sent()[-2:]
        self.assertEqual((a["scrimmageSide"], a["finalScore"]["our"], a["finalScore"]["opponent"]), ("A", 3, 0))
        self.assertEqual((b["scrimmageSide"], b["finalScore"]["our"], b["finalScore"]["opponent"]), ("B", 0, 3))
        self.assertEqual(self.meta("503")["scrimmage"]["B"]["result_payload"]["finalScore"]["our"], 0)

    def test_highlight_only_split_keeps_video_fields_only(self):
        match = self.add_job("505", _meta("505", tier="basic", scrimmage=True))
        r = self.client.post(f"/api/highlight/clip-results/matches/{match}/resend", json={})
        self.assertEqual(r.status_code, 200, r.text)
        a, b = self.sent()
        allowed = {"clipKey", "fpcClipId", "sourceVideoId", "startTime", "endTime", "highlightVideo",
                   "mainAction", "title", "isGoal", "displayOnly"}
        self.assertEqual([(c["clipKey"][-3:], c.get("displayOnly", False)) for c in a["clips"]],
                         [("001", False), ("002", True), ("004", False), ("005", False)])
        self.assertEqual([(c["clipKey"][-3:], c.get("displayOnly", False)) for c in b["clips"]],
                         [("001", True), ("002", False), ("003", False)])
        for clip in a["clips"] + b["clips"]:
            self.assertLessEqual(set(clip), allowed)
        self.assertEqual(self.meta("505")["scrimmage"]["A"].get("player_match"), None)

    def test_job_list_brief_drops_bundle_payloads(self):
        from app.highlight_jobs import serialize_job
        self.send()
        with fixture.SessionLocal() as db:
            brief = serialize_job(db.get(HighlightJob, "503"), brief=True)["job_metadata"]["scrimmage"]
        self.assertEqual(set(brief), {"A", "B"})
        self.assertNotIn("result_payload", brief["A"])
        self.assertEqual(brief["A"]["callback_status"], "sent")


class ScrimmageHelpersTest(unittest.TestCase):
    def test_only_non_standalone_scrimmage_is_split(self):
        from app import fineplay_scrimmage as fs
        self.assertIsNone(fs.bundle_sides(_meta("1")))
        self.assertIsNone(fs.bundle_sides({**_meta("1", scrimmage=True), "standalone": True}))
        self.assertIsNone(fs.bundle_sides(_standalone_meta()))
        self.assertEqual(fs.bundle_sides(_meta("1", scrimmage=True)), {"A": "home", "B": "away"})
        self.assertEqual(fs.bundle_sides(_meta("1", scrimmage=True, our_side="away")), {"A": "away", "B": "home"})
        self.assertEqual(fs.bundle_lineup(_meta("1", scrimmage=True), "B"), LINEUP_B)

    def test_clip_roles(self):
        from app.fineplay_scrimmage import clip_role
        self.assertEqual(clip_role("home", False, side="home", letter="A"), "own")
        self.assertEqual(clip_role("away", True, side="home", letter="A"), "display")
        self.assertIsNone(clip_role("away", False, side="home", letter="A"))
        self.assertEqual(clip_role(None, True, side="home", letter="A"), "own")   # 옛 클립은 A 에만
        self.assertIsNone(clip_role(None, True, side="away", letter="B"))

    def test_new_produce_holds_sent_bundles(self):
        from app import fineplay_scrimmage as fs
        meta = _meta("1", scrimmage=True)
        fs.record(meta, "A", side="home", status="sent", payload={"clips": []})
        fs.record(meta, "B", side="away", status="sent", payload={"clips": []})
        self.assertEqual(meta["callback_status"], "sent")
        fs.hold_all(meta, "held (x)")
        self.assertEqual({k: v["callback_status"] for k, v in meta["scrimmage"].items()},
                         {"A": "held (x)", "B": "held (x)"})
        self.assertIn("result_payload", meta["scrimmage"]["A"])   # 기록은 남긴다


def load_tests(loader, tests, pattern):
    """픽스처(MatchWriteAccess)에서 물려받은 테스트는 그 파일에서 돈다 — 여기 것만 모은다."""
    suite = unittest.TestSuite()
    for case in (NonScrimmagePayloadUnchangedTest, ScrimmageSplitTest, ScrimmageHelpersTest):
        for name in loader.getTestCaseNames(case):
            if name in vars(case):
                suite.addTest(case(name))
    return suite


if __name__ == "__main__":
    unittest.main()
