"""GPU 유휴 자동 종료: 가짜 제어 Lambda(httpx MockTransport) + 고정 시각으로 판단 규칙을 고정한다.

실제 제어 함수(main._highlight_worker_control_request)를 그대로 거치므로 요청 형식·
인증 헤더·실패 처리까지 함께 검증한다. 네트워크는 fixture 가 막아 둔다.
"""
import json
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_match_write_access as fixture
from app import gpu_auto_stop as gas
from app import main
from app.models import AuditLog, BroadcastOverlayProject, HighlightJob

REAL_CLIENT = httpx.Client
T0 = datetime(2026, 11, 4, 1, 0)  # 10:00 KST


class FakeLambda:
    """media-control Lambda 흉내. status/stop 호출 횟수와 상태를 기억한다."""

    def __init__(self, state="running"):
        self.state = state
        self.calls = []
        self.fail = set()  # 실패시킬 action

    def handler(self, request):
        body = json.loads(request.content or b"{}")
        action = body["action"]
        self.calls.append(action)
        assert request.headers.get("authorization") == "Bearer fake-token"
        if action in self.fail:
            return httpx.Response(500, json={"ok": False, "detail": "boom"})
        if action == "stop":
            self.state = "stopping"
        if action == "start":
            self.state = "pending"
        return httpx.Response(200, json={"ok": True, "state": self.state, "instance_id": "i-fake"})

    def count(self, action):
        return self.calls.count(action)


class GpuAutoStopTests(unittest.TestCase):
    # fixture 의 DB·세션 준비만 빌려 쓴다. 상속하면 경기 쓰기 시험 전체가 여기서 또 돈다.
    setUpClass = classmethod(fixture.MatchWriteAccess.setUpClass.__func__)
    tearDown = fixture.MatchWriteAccess.tearDown

    def setUp(self):
        fixture.MatchWriteAccess.setUp(self)
        self.fake = FakeLambda()
        self.fpa = None  # None = FPA 연결 설정 없음
        self.notices = []
        self.settings = gas.Settings(enabled=True, idle_minutes=60, check_seconds=300, stale_hours=12,
                                     observation_gap_minutes=20, slack_webhook_url="")
        patches = [
            patch.object(main, "HIGHLIGHT_WORKER_CONTROL_URL", "https://fake-lambda.test/"),
            patch.object(main, "HIGHLIGHT_WORKER_CONTROL_TOKEN", "fake-token"),
            patch.object(main.httpx, "Client",
                         lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(self.fake.handler), **kw)),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def fpa_queue(self):
        if isinstance(self.fpa, Exception):
            raise self.fpa
        return self.fpa

    def tick(self, minutes):
        # 매번 새 세션: 프로세스 메모리에 기대는 상태가 없음을 함께 확인한다.
        with fixture.SessionLocal() as db:
            return gas.run_tick(db, now=T0 + timedelta(minutes=minutes), settings=self.settings,
                                control=main._highlight_worker_control_request,
                                fpa_queue=self.fpa_queue, notify=self.notices.append)

    def add_job(self, status, mode="ai", updated_minutes=0):
        with fixture.SessionLocal() as db:
            at = T0 + timedelta(minutes=updated_minutes)
            db.add(HighlightJob(id=uuid4().hex, status=status, mode=mode, created_at=at, updated_at=at))
            db.commit()

    def add_overlay(self, status, updated_minutes=0):
        with fixture.SessionLocal() as db:
            at = T0 + timedelta(minutes=updated_minutes)
            db.add(BroadcastOverlayProject(match_id=self.mid, status=status, overlay_items=[], created_at=at, updated_at=at))
            db.commit()

    def audits(self):
        with fixture.SessionLocal() as db:
            return db.query(AuditLog).filter_by(action="HIGHLIGHT_WORKER_EC2_AUTO_STOP").count()

    def run_minutes(self, *minutes):
        return [self.tick(m) for m in minutes]

    def every(self, start, end, step=5):
        # 실제 루프처럼 5분 간격으로 본다(관측 공백 20분 초과는 별도 시험).
        return self.run_minutes(*range(start, end + 1, step))

    def test_idle_59_no_stop_then_60_stops_exactly_once(self):
        results = self.every(0, 55) + self.run_minutes(59)
        self.assertEqual(self.fake.count("stop"), 0)
        self.assertEqual(results[-1].decision, "idle_waiting")
        self.assertTrue(self.tick(60).stopped)
        self.run_minutes(65, 70, 75, 200)  # 이후엔 stopping/stopped 로 보인다
        self.assertEqual(self.fake.count("stop"), 1)
        self.assertEqual(self.audits(), 1)
        self.assertEqual(len(self.notices), 1)
        self.assertIn("자동으로 껐습니다", self.notices[0])

    def test_still_running_after_stop_is_not_resent_immediately(self):
        self.every(0, 60)
        self.fake.state = "running"  # Lambda 가 아직 running 으로 답하는 경우
        self.run_minutes(65, 70)
        self.assertEqual(self.fake.count("stop"), 1)

    def test_queued_or_processing_gpu_work_blocks_stop(self):
        for status in ("queued", "processing"):
            with self.subTest(status=status):
                fixture.Base.metadata.drop_all(fixture.engine)
                fixture.Base.metadata.create_all(fixture.engine)
                self.fake = FakeLambda()
                self.add_job(status, mode="ai", updated_minutes=0)
                results = self.every(0, 300)
                self.assertEqual(self.fake.count("stop"), 0)
                self.assertEqual(results[-1].decision, "busy")

    def test_overlay_render_blocks_stop(self):
        self.add_overlay("rendering", updated_minutes=0)
        self.every(0, 120)
        self.assertEqual(self.fake.count("stop"), 0)

    def test_cpu_only_and_operator_jobs_do_not_block(self):
        # API·앱 서버가 처리하는 일은 GPU 일감이 아니다.
        self.add_job("queued", mode="operator")
        self.add_job("processing", mode="operator")
        self.add_job("render_queued", mode="produce_s3")
        self.add_job("tagging", mode="fineplay")
        self.add_overlay("draft")
        self.every(0, 60)
        self.assertEqual(self.fake.count("stop"), 1)

    def test_stale_processing_row_does_not_block_forever(self):
        self.add_job("processing", mode="ai", updated_minutes=-13 * 60)
        self.add_overlay("rendering", updated_minutes=-13 * 60)
        result = self.every(0, 60)[-1]
        self.assertTrue(result.stopped)
        self.assertEqual(result.work["stale_rows"], 2)

    def test_recently_finished_job_restarts_idle_clock(self):
        self.tick(0)
        self.add_job("done", mode="ai", updated_minutes=50)  # 5분 사이에 끝난 일
        self.every(5, 105)
        self.tick(109)
        self.assertEqual(self.fake.count("stop"), 0)
        self.tick(110)
        self.assertEqual(self.fake.count("stop"), 1)

    def test_fpa_cv_queue_blocks_and_unreachable_holds(self):
        self.fpa = {"activeCount": 1, "queuedCount": 0}
        self.every(0, 120)
        self.assertEqual(self.fake.count("stop"), 0)
        self.fpa = {"activeCount": 0, "queuedCount": 2}
        self.tick(125)
        self.assertEqual(self.fake.count("stop"), 0)
        # 마지막으로 바빴던 건 125분. 그 뒤 FPA 작업자에 닿지 않으면 보류한다.
        self.fpa = httpx.ConnectError("unreachable")
        results = self.every(130, 185) + self.run_minutes(189)
        self.assertEqual({r.decision for r in results}, {"fpa_unknown"})
        self.assertEqual(self.fake.count("stop"), 0)
        # 유휴 기준(60분)만큼 계속 닿지 않으면 그쪽도 일이 없다고 본다.
        self.assertTrue(self.tick(190).stopped)

    def test_skip_today_blocks_until_next_kst_day(self):
        with fixture.SessionLocal() as db:
            gas.set_skip_today(db, T0, True, "admin")
            db.commit()
        results = self.every(0, 14 * 60 - 5)  # 같은 날 23:55 KST 까지
        self.assertEqual(self.fake.count("stop"), 0)
        self.assertEqual(results[-1].decision, "skipped_today")
        self.assertEqual(self.tick(14 * 60).decision, "stopped")  # 다음 날 00:00 KST

    def test_already_stopped_never_calls_stop(self):
        self.fake.state = "stopped"
        results = self.run_minutes(0, 60, 120, 600)
        self.assertEqual(self.fake.count("stop"), 0)
        self.assertEqual(self.fake.count("status"), 4)
        self.assertEqual({r.decision for r in results}, {"not_running"})

    def test_restart_mid_idle_neither_resets_nor_stops_early(self):
        self.every(0, 30)
        # API 재시작: 메모리 없음, 1분 공백 뒤 같은 DB 로 다시 시작.
        self.run_minutes(31)
        self.every(35, 55)
        self.tick(59)
        self.assertEqual(self.fake.count("stop"), 0)
        self.assertTrue(self.tick(60).stopped)

    def test_long_observation_gap_restarts_clock(self):
        # 80분 동안 관측이 끊기면 그 사이 껐다 켰을 수 있으니 지금부터 다시 잰다.
        self.tick(0)
        self.tick(80)
        self.assertEqual(self.fake.count("stop"), 0)
        self.every(85, 135)
        self.assertEqual(self.fake.count("stop"), 0)
        self.assertTrue(self.tick(140).stopped)

    def test_control_failures_are_logged_and_retried(self):
        self.every(0, 55)
        self.fake.fail = {"status"}
        result = self.tick(60)
        self.assertEqual(result.decision, "status_failed")
        self.assertIn("상태 확인 실패", result.error)
        self.fake.fail = {"stop"}
        result = self.tick(65)
        self.assertEqual(result.decision, "stop_failed")
        with fixture.SessionLocal() as db:
            self.assertIn("종료 요청 실패", db.get(gas.GpuAutoStopState, gas.STATE_ID).last_error)
        self.fake.fail = set()
        self.assertTrue(self.tick(70).stopped)
        self.assertEqual(self.audits(), 1)

    def test_slack_failure_does_not_undo_stop(self):
        def broken(_message):
            raise RuntimeError("slack down")
        self.every(0, 55)
        with fixture.SessionLocal() as db:
            result = gas.run_tick(db, now=T0 + timedelta(minutes=60), settings=self.settings,
                                  control=main._highlight_worker_control_request, fpa_queue=self.fpa_queue, notify=broken)
        self.assertTrue(result.stopped)
        self.assertEqual(self.audits(), 1)

    def test_slack_notifier_posts_text(self):
        seen = []
        def handler(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, text="ok")
        with patch.object(gas.httpx, "Client", lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handler), **kw)):
            gas.slack_notifier("https://hooks.slack.test/x")("hello")
        self.assertEqual(seen, [{"text": "hello"}])
        self.assertIsNone(gas.slack_notifier(""))

    def test_manual_start_endpoint_resets_idle_clock(self):
        self.every(0, 45)
        frozen = T0 + timedelta(minutes=50)
        with patch.object(main, "datetime") as fake_dt:
            fake_dt.utcnow.return_value = frozen
            response = self.clients["admin"].post("/api/admin/ec2/highlight-worker-start")
        self.assertEqual(response.status_code, 200, response.text)
        self.fake.state = "running"
        self.every(55, 105)
        self.assertEqual(self.fake.count("stop"), 0)
        self.assertTrue(self.tick(110).stopped)

    def test_skip_today_endpoint_is_admin_only(self):
        self.assertEqual(self.clients["owner"].post("/api/admin/gpu-auto-stop/skip-today", json={"skip": True}).status_code, 403)
        self.assertEqual(self.clients["anonymous"].post("/api/admin/gpu-auto-stop/skip-today", json={"skip": True}).status_code, 401)
        admin = self.clients["admin"]
        self.assertEqual(admin.post("/api/admin/gpu-auto-stop/skip-today", json={"skip": "yes"}).status_code, 400)
        response = admin.post("/api/admin/gpu-auto-stop/skip-today", json={"skip": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["gpu_auto_stop"]["skip_today"])
        self.assertTrue(admin.get("/api/admin/gpu-auto-stop").json()["gpu_auto_stop"]["skip_today"])
        response = admin.post("/api/admin/gpu-auto-stop/skip-today", json={"skip": False})
        self.assertFalse(response.json()["gpu_auto_stop"]["skip_today"])
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(AuditLog).filter_by(action="GPU_AUTO_STOP_SKIP_TODAY").count(), 2)

    def test_worker_loop_survives_tick_exception(self):
        import asyncio
        stop = asyncio.Event()
        calls = []

        def broken(_settings):
            calls.append(1)
            stop.set()  # 한 번 돈 뒤 루프를 끝낸다
            raise RuntimeError("db down")

        with patch.dict("os.environ", {"GPU_AUTO_STOP_ENABLED": "1"}), patch.object(main, "_gpu_auto_stop_tick", broken):
            asyncio.run(main.gpu_auto_stop_worker(stop))
        self.assertEqual(calls, [1])

    def test_settings_default_off(self):
        with patch.dict("os.environ", {}, clear=False) as env:
            env.pop("GPU_AUTO_STOP_ENABLED", None)
            env.pop("GPU_AUTO_STOP_IDLE_MINUTES", None)
            settings = gas.Settings.from_env()
        self.assertFalse(settings.enabled)
        self.assertEqual(settings.idle_minutes, 60)
        self.assertEqual(settings.check_seconds, 300)


if __name__ == "__main__":
    unittest.main()
