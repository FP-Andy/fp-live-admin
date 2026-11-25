"""FinePlay 골라 가져오기 · 매니페스트 비교 · FHL job.json 자동 클립(2026-11-25, T4).

고정하는 것:
1. 미리보기는 claim 하지 않는다. 20건씩 cursor 로 끝까지 읽는다.
2. 고른 것만 claim 한다. 이미 가져온 건·다른 워커가 잡았던 건은 골라도 건너뛴다. [모두 가져오기]는 '새' 건 전부.
3. 매니페스트 다시 받기 미리보기는 아무것도 안 바꾸고 라인업 전·후를 보여 준다. 적용 때 FPC 에서 직접 넣은 선수는 남긴다.
4. FHL 기록: 종류↔팀 매핑(FHL 홈이 상대팀이면 뒤집기), 전환 구간 깎기, 가져오자마자 생성 대기열(점수판·워터마크 끔).
   실제 ffmpeg 로 합본을 자르면 클립 길이가 깎은 구간과 같다.

운영 API·저장소에는 닿지 않는다 — FinePlay 클라이언트는 가짜, 저장소는 임시 폴더, 네트워크는 픽스처가 막는다.

Run: PYTHONPATH=apps/api:apps/api/tests python -m unittest test_fineplay_import_select -v
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_match_write_access as fixture  # noqa: E402
from app import fineplay_import  # noqa: E402
from app import highlight_jobs as jobs  # noqa: E402
from app.fineplay_client import ClaimResult  # noqa: E402
from app.models import AuditLog, HighlightClip, HighlightJob  # noqa: E402
from test_fineplay_append_clips import LocalStorage  # noqa: E402

WORKER = "fpc-worker-1"
LINEUP = [{"playerId": str(100 + n), "name": f"선수{n}", "jerseyNumber": n, "positionSlot": "SUB" if n > 11 else f"p{n}",
           "isSubstitute": n > 11} for n in range(1, 14)]

# FHL 0.19.1 순서표 모드: 인트로 카드 1.8s → 클립1(홈 골) → 클립2(원정 장면, 0.2s 겹침) → 섹션 카드 → 클립3(원정 골) → 끝
FHL_JOB = {
    "schema": "fhl-job/v2", "exportDuration": 30.0, "ourSide": "home",
    "sources": [{"name": "전반.mp4", "duration": 2700}, {"name": "후반.mp4", "duration": 2700}],
    "clips": [
        {"order": 1, "kind": "home_goal", "sourceIndex": 0, "sourceStart": 600, "sourceEnd": 608,
         "exportStart": 1.4, "exportEnd": 9.4, "tagExport": 6.4, "scoreBefore": [0, 0], "scoreAfter": [1, 0]},
        {"order": 2, "kind": "away", "sourceIndex": 0, "sourceStart": 1200, "sourceEnd": 1206,
         "exportStart": 9.2, "exportEnd": 15.2, "tagExport": 12.0, "scoreBefore": [1, 0], "scoreAfter": [1, 0]},
        {"order": 3, "kind": "away_goal", "sourceIndex": 1, "sourceStart": 300, "sourceEnd": 309,
         "exportStart": 17.0, "exportEnd": 26.0, "tagExport": 22.0, "scoreBefore": [1, 0], "scoreAfter": [1, 1]},
    ],
}


def manifest(rid, *, claimed_by=None, fhl=None, lineup=LINEUP, opponent="상대FC"):
    video = {"videoId": f"ops-{rid}", "source": "UPLOAD", "s3Key": f"analysis-requests/7/{rid}.mp4",
             "durationSeconds": 3000, "resolution": "1920x1080"}
    if fhl:
        video["fhlJob"] = fhl
    m = {
        "analysisRequestId": rid, "submittedAt": "2026-11-23T10:00:00",
        "team": {"teamId": 7, "teamName": f"팀{rid}", "jerseyColorArgb": 4294901760},
        "opponent": {"name": opponent, "isInternal": False},
        "match": {"matchDate": "2026-11-22T14:00:00", "placeName": "춘천", "ourScore": 2, "opponentScore": 1},
        "formation": "4-3-3", "lineup": lineup, "videos": [video],
        "options": [{"optionType": "BASIC_HIGHLIGHT", "selected": True}],
        "competition": {"competitionId": "c1", "matchId": "m9", "name": "UCCC 2026", "side": "HOME"},
    }
    if claimed_by:
        m["claim"] = {"claimedBy": claimed_by, "leaseExpiresAt": "2026-11-24T10:00:00"}
    return m


class FakeFinePlay:
    """GET /jobs(claim 없음)·POST claim 을 흉내 낸다. 신청 번호 오름차순, cursor = 마지막 번호."""

    configured = True
    worker_id = WORKER

    def __init__(self, queue):
        self.queue = list(queue)
        self.claims: list = []
        self.polls: list = []
        self.claim_status = {}

    def poll_jobs(self, limit=None, cursor=None):
        self.polls.append((limit, cursor))
        rows = [m for m in self.queue if cursor is None or m["analysisRequestId"] > int(cursor)]
        return rows[: (limit or 20)]

    def claim(self, rid, pipeline_version=None, lease_seconds=86400):
        self.claims.append(int(rid))
        code = self.claim_status.get(int(rid), 200)
        m = next((x for x in self.queue if x["analysisRequestId"] == int(rid)), None)
        return ClaimResult(status_code=code, manifest=json.loads(json.dumps(m)) if code == 200 else None)


class FhlClipTests(unittest.TestCase):
    def test_kinds_map_to_sides_and_seams_are_trimmed(self):
        out = fineplay_import.fhl_clip_entries(manifest(1, fhl=FHL_JOB), "home")
        c1, c2, c3 = out["clips"]
        # 클립1: 앞은 인트로 카드(틈) → 0.4 깎음, 뒤는 클립2와 0.2 겹침 → 0.2 깎음
        self.assertEqual((c1["start"], c1["end"]), (1.8, 9.2))
        # 클립2: 앞 0.2 겹침, 뒤는 섹션 카드(틈) → 0.4
        self.assertEqual((c2["start"], c2["end"]), (9.4, 14.8))
        # 클립3: 앞 카드 0.4, 뒤는 합본 끝까지 4초 남음(아웃트로) → 0.4
        self.assertEqual((c3["start"], c3["end"]), (17.4, 25.6))
        self.assertEqual([c["team"] for c in out["clips"]], ["home", "away", "away"])
        self.assertEqual([c["isGoal"] for c in out["clips"]], [True, False, True])
        self.assertEqual(c1["goalAt"], 4.6)            # 6.4 - 1.8
        self.assertEqual(c3["scoreAfter"], [1, 1])
        self.assertEqual(out["trimmed"], 3)
        self.assertTrue(all(c["sourceVideoId"] == "ops-1" for c in out["clips"]))

    def test_fhl_home_is_opponent_flips_team_and_score(self):
        job = {**FHL_JOB, "ourSide": "away"}
        out = fineplay_import.fhl_clip_entries(manifest(1, fhl=job), "home")
        self.assertEqual([c["team"] for c in out["clips"]], ["away", "home", "home"])
        self.assertEqual(out["clips"][0]["scoreAfter"], [0, 1])   # FHL [1,0] = 상대 1점
        self.assertEqual(out["clips"][2]["scoreAfter"], [1, 1])

    def test_card_only_kinds_are_skipped_and_short_clips_are_not_trimmed(self):
        job = {**FHL_JOB, "exportDuration": 5.0, "clips": [
            {"order": 1, "kind": "section", "exportStart": 0, "exportEnd": 1.5},
            {"order": 2, "kind": "home_goal_only", "exportStart": 1.5, "exportEnd": 1.6},
            {"order": 3, "kind": "home", "exportStart": 2.0, "exportEnd": 3.0},
        ]}
        out = fineplay_import.fhl_clip_entries(manifest(1, fhl=job), "home")
        self.assertEqual(out["skipped"], {"section": 1, "home_goal_only": 1})
        self.assertEqual([(c["start"], c["end"]) for c in out["clips"]], [(2.0, 3.0)])   # 깎으면 0.2초 → 원래대로

    def test_no_fhl_job(self):
        self.assertEqual(fineplay_import.fhl_clip_entries(manifest(1), "home")["clips"], [])


class QueueAndDiffTests(unittest.TestCase):
    def test_walk_queue_reads_to_the_end_with_cursor(self):
        fake = FakeFinePlay([manifest(i) for i in range(1, 46)])
        rows, truncated = fineplay_import.walk_queue(fake.poll_jobs, limit=20)
        self.assertEqual(len(rows), 45)
        self.assertFalse(truncated)
        self.assertEqual(fake.polls, [(20, None), (20, 20), (20, 40), (20, 45)])

    def test_lineup_diff_and_keep_manual(self):
        old = LINEUP[:11] + [{"jerseyNumber": 77, "name": "직접넣음", "isSubstitute": True, "manualAdded": True}]
        new = [dict(p) for p in LINEUP[:10]] + [{"jerseyNumber": 99, "name": "새선수", "positionSlot": "p11"}]
        new[0]["name"] = "이름바뀜"
        d = fineplay_import.lineup_diff(old, new)
        self.assertEqual([p["jerseyNumber"] for p in d["added"]], [99])
        self.assertEqual(sorted(p["jerseyNumber"] for p in d["removed"]), [11, 77])
        self.assertTrue(next(p for p in d["removed"] if p["jerseyNumber"] == 77)["manualAdded"])
        self.assertEqual(d["changed"][0]["fields"]["name"], ["선수1", "이름바뀜"])
        merged, kept = fineplay_import.keep_manual_players(old, new)
        self.assertEqual([p["jerseyNumber"] for p in kept], [77])
        self.assertEqual(len(merged), 12)


class ImportRouteTests(fixture.MatchWriteAccess):
    def setUp(self):
        super().setUp()
        self.client = self.clients["admin"]
        self.fake = FakeFinePlay([
            manifest(101), manifest(102), manifest(103, claimed_by="fpc-worker-old"),
            manifest(104, fhl=FHL_JOB), manifest(105),
        ])
        with fixture.SessionLocal() as db:   # 105 는 이미 가져온 작업
            db.add(HighlightJob(id="fp-105", mode="fineplay", status="tagging",
                                job_metadata={"analysis_request_id": 105, "manifest": manifest(105)}))
            db.commit()
        self.p = patch("app.main.fineplay_default_client", return_value=self.fake)
        self.p.start()

    def tearDown(self):
        self.p.stop()
        super().tearDown()

    def test_preview_never_claims_and_marks_states(self):
        r = self.client.get("/api/highlight/fineplay-jobs/queue-preview")
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        self.assertEqual(self.fake.claims, [])
        states = {row["analysisRequestId"]: row["state"] for row in data["items"]}
        self.assertEqual(states, {101: "new", 102: "new", 103: "taken", 104: "new", 105: "imported"})
        self.assertEqual(data["selectable"], 3)
        row = next(x for x in data["items"] if x["analysisRequestId"] == 104)
        self.assertEqual(row["videos"], {"count": 1, "totalSeconds": 3000, "sources": ["UPLOAD"]})
        self.assertEqual(row["fhl"]["clips"], 3)
        self.assertEqual(row["competition"]["name"], "UCCC 2026")
        self.assertEqual(row["tier"], "basic")
        self.assertEqual(len(row["lineup"]), 13)
        self.assertNotIn("s3Key", json.dumps(row))

    def test_import_selected_only_and_skip_imported_or_taken(self):
        r = self.client.post("/api/highlight/fineplay-jobs/import", json={"ids": [102, 103, 105, 999]})
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        self.assertEqual(data["claimed"], ["fp-102"])
        self.assertEqual(self.fake.claims, [102])
        reasons = {str(s["analysisRequestId"]): s["reason"] for s in data["skipped"]}
        self.assertIn("다른 워커", reasons["103"])
        self.assertIn("이미 가져온", reasons["105"])
        self.assertIn("대기열에 없음", reasons["999"])
        with fixture.SessionLocal() as db:
            self.assertIsNone(db.get(HighlightJob, "fp-101"))
            self.assertEqual(db.get(HighlightJob, "fp-102").status, "tagging")
            self.assertEqual(db.query(AuditLog).filter_by(action="FINEPLAY_IMPORT_SELECTED").count(), 1)

    def test_import_all_takes_new_ones_and_queues_fhl_produce(self):
        from app.highlight_render_queue import HighlightRenderTask
        r = self.client.post("/api/highlight/fineplay-jobs/import", json={"all": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(r.json()["claimed"]), ["fp-101", "fp-102", "fp-104"])
        self.assertEqual(r.json()["fhl_queued"], ["fp-104"])
        with fixture.SessionLocal() as db:
            md = db.get(HighlightJob, "fp-104").job_metadata
            self.assertEqual(len(md["clips"]), 3)
            self.assertEqual(md["fhl_import"]["status"], "queued")
            self.assertFalse(md["send_on_produce"])
            self.assertNotIn("scoreboard", md)
            self.assertNotIn("fhl_auto_pending", md)
            self.assertEqual(db.query(HighlightRenderTask).filter_by(job_id="fp-104").count(), 1)
            self.assertEqual(db.query(HighlightRenderTask).filter_by(job_id="fp-101").count(), 0)

    def test_import_requires_selection(self):
        self.assertEqual(self.client.post("/api/highlight/fineplay-jobs/import", json={}).status_code, 400)

    def test_refresh_preview_changes_nothing_and_apply_keeps_manual_player(self):
        with fixture.SessionLocal() as db:
            job = db.get(HighlightJob, "fp-105")
            md = dict(job.job_metadata)
            mf = dict(md["manifest"])
            mf["lineup"] = LINEUP + [{"jerseyNumber": 77, "name": "직접넣음", "isSubstitute": True, "manualAdded": True}]
            md["manifest"] = mf
            job.job_metadata = md
            db.commit()
        # FinePlay 쪽 라인업: 13번 빠지고 상대 이름 바뀜
        self.fake.queue[-1] = manifest(105, lineup=LINEUP[:12], opponent="상대FC(수정)")
        r = self.client.get("/api/highlight/fineplay-jobs/fp-105/refresh-manifest/preview")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual(sorted(p["jerseyNumber"] for p in d["lineup"]["removed"]), [13, 77])
        self.assertEqual([p["jerseyNumber"] for p in d["keepManual"]], [77])
        self.assertEqual(d["fields"][0]["label"], "상대")
        with fixture.SessionLocal() as db:
            self.assertEqual(len(db.get(HighlightJob, "fp-105").job_metadata["manifest"]["lineup"]), 14)

        r = self.client.post("/api/highlight/fineplay-jobs/fp-105/refresh-manifest")
        self.assertEqual(r.status_code, 200, r.text)
        with fixture.SessionLocal() as db:
            lineup = db.get(HighlightJob, "fp-105").job_metadata["manifest"]["lineup"]
        self.assertEqual(sorted(p["jerseyNumber"] for p in lineup), list(range(1, 13)) + [77])

        r = self.client.post("/api/highlight/fineplay-jobs/fp-105/refresh-manifest?keep_manual=false")
        self.assertEqual(r.status_code, 200, r.text)
        with fixture.SessionLocal() as db:
            self.assertEqual(len(db.get(HighlightJob, "fp-105").job_metadata["manifest"]["lineup"]), 12)


class FhlRenderTests(fixture.MatchWriteAccess):
    """가져오기 → 대기열 → 실제 렌더(ffmpeg)까지. 합본 30초를 만들어 FHL 구간대로 자른다."""

    def setUp(self):
        super().setUp()
        self.client = self.clients["admin"]
        self.tmp = Path(tempfile.mkdtemp(prefix="fpc-fhl-"))
        self.storage = LocalStorage(self.tmp / "bucket")
        dest = self.storage._path("analysis-requests/7/104.mp4")
        dest.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=30",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(dest),
        ], check=True)
        self.fake = FakeFinePlay([manifest(104, fhl=FHL_JOB)])

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        super().tearDown()

    def test_imported_fhl_job_renders_trimmed_clips_without_sending(self):
        from app.highlight_render_queue import HighlightRenderTask
        with patch("app.main.fineplay_default_client", return_value=self.fake):
            r = self.client.post("/api/highlight/fineplay-jobs/import", json={"ids": [104]})
        self.assertEqual(r.json()["fhl_queued"], ["fp-104"], r.text)
        with fixture.SessionLocal() as db:
            task = db.query(HighlightRenderTask).filter_by(job_id="fp-104", status="queued").one()
            task.status = "running"
            db.commit()
        with patch.object(jobs, "default_storage", return_value=self.storage), \
                patch.object(jobs, "default_client", return_value=self.fake, create=True):
            jobs.run_fineplay_produce("fp-104")
        with fixture.SessionLocal() as db:
            job = db.get(HighlightJob, "fp-104")
            self.assertNotEqual(job.status, "error", job.error_message)
            rows = db.query(HighlightClip).filter_by(job_id="fp-104").order_by(HighlightClip.order_index).all()
            self.assertEqual([(r.start_sec, r.end_sec) for r in rows], [(1.8, 9.2), (9.4, 14.8), (17.4, 25.6)])
            self.assertEqual([r.team_side for r in rows], ["home", "away", "away"])
            self.assertEqual([r.is_goal for r in rows], [True, False, True])
            self.assertNotEqual(job.job_metadata.get("callback_status"), "sent")
        self.assertFalse(hasattr(self.fake, "posted"))
        # 실제 클립 영상 길이 = 깎은 구간 길이(±0.2초, 프레임·키프레임 차)
        clip_files = sorted(p for p in self.storage.root.joinpath("highlights").rglob("*.mp4"))
        self.assertGreaterEqual(len(clip_files), 3)
        lengths = []
        for p in clip_files[:3]:
            out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                                 capture_output=True, text=True, check=True).stdout.strip()
            lengths.append(float(out))
        for got, want in zip(sorted(lengths), sorted([7.4, 5.4, 8.2])):
            self.assertAlmostEqual(got, want, delta=0.25)


if __name__ == "__main__":
    unittest.main()
