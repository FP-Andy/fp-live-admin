"""신청 태깅 '클립 추가' 모드(2026-11-24) — 기존 클립·액션·영상은 그대로, 새 클립만 만든다.

#459(사이다) 모양을 그대로 본뜬 픽스처: 영상 2개(전반·후반), 처음 생성 18클립(clipId 없는 옛 생성),
그중 001·008 을 클립 검수에서 지워 16클립·액션 42개가 남은 상태. 여기에 7클립을 더한다
(지운 001·008 구간 + 전반 끝·후반 시작·사이사이 5개).

고정하는 것:
1. 키 — 기존 키는 그대로, 새 키는 019 부터(지운 001·008 번호는 다시 안 씀), S3 에 이미 있는 번호는 건너뜀.
2. 순서 — 두 영상에 걸쳐 (영상 순서, 시작) 으로 전체 order_index 를 다시 매김. 키는 안 바뀜.
3. 추가 생성은 기존 행·액션·S3 객체를 건드리지 않는다(실제 ffmpeg 렌더 + 로컬 저장소).
4. 전송 payload 에서 기존 16클립 항목(teamView·actions·sceneData 포함)이 추가 전과 바이트 단위로 같다.
   새 클립은 액션이 비어 있다. 전송 순서는 시간 순.

운영 저장소(fineplay-files)·운영 API 에는 닿지 않는다 — 저장소는 임시 폴더, 네트워크는 픽스처가 막는다.

Run: PYTHONPATH=apps/api:apps/api/tests python -m unittest test_fineplay_append_clips -v
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_match_write_access as fixture  # noqa: E402
from app import fineplay_append  # noqa: E402
from app import highlight_jobs as jobs  # noqa: E402
from app.fineplay_models import output_key  # noqa: E402
from app.models import HighlightClip, HighlightClipAction, HighlightJob  # noqa: E402

RID = 459
TEAM = "77"
V1, V2 = "vid-1st", "vid-2nd"
LINEUP = [{"playerId": str(100 + n), "name": f"선수{n}", "jerseyNumber": n} for n in range(1, 12)]


def _segments():
    """처음 생성의 18구간(정렬 순서 = 옛 자리 번호 001..018). 001·008 은 나중에 지운다."""
    first = [(3.658, 13.658), (20.0, 30.0), (40.0, 50.0), (60.0, 70.0), (80.0, 90.0),
             (100.0, 110.0), (120.0, 130.0), (149.304, 160.304), (170.0, 180.0)]
    second = [(10.0, 20.0), (30.0, 40.0), (50.0, 60.0), (70.0, 80.0), (90.0, 100.0),
              (110.0, 120.0), (130.0, 140.0), (150.0, 160.0), (165.0, 175.0)]
    return [(V1, s, e) for s, e in first] + [(V2, s, e) for s, e in second]


DELETED = {1, 8}
# 새로 넣을 7클립: 지운 001·008 구간, 전반 마지막 클립 뒤(전반 끝), 후반 첫 클립 앞(후반 시작), 사이 3개.
NEW = [
    (V1, 3.658, 13.658, "home", False),     # 옛 001 구간
    (V1, 149.304, 160.304, "away", True),   # 옛 008 구간 (골)
    (V1, 182.0, 190.0, "home", False),      # 전반 끝
    (V2, 1.0, 8.0, "away", False),          # 후반 시작
    (V1, 52.0, 58.0, "home", False),        # 전반 사이
    (V2, 42.0, 48.0, "home", False),        # 후반 사이
    (V2, 141.0, 148.0, "away", False),      # 후반 사이
]


def _canon(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class LocalStorage:
    """S3 대신 임시 폴더. presigned_get 이 없어 워커는 원본을 '내려받아' 렌더한다."""

    def __init__(self, root: Path):
        self.root = root
        self.uploads: list[str] = []

    configured = True

    def _path(self, key: str) -> Path:
        return self.root / key

    def download(self, key: str, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self._path(key), dest)
        return dest

    def upload(self, path: Path, key: str, content_type: str = "video/mp4") -> str:
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        self.uploads.append(key)
        return key

    def exists(self, key: str) -> bool:
        return self._path(key).exists()


class KeyAssignmentTests(unittest.TestCase):
    def test_next_key_is_above_every_number_ever_used(self):
        # 행 16개(001·008 지움) + clipId 없는 옛 항목 18개 → 018 까지 쓴 것으로 본다.
        db_keys = [f"fpc-{RID}-{n:03d}" for n in range(1, 19) if n not in DELETED]
        meta = {"clips": [{"start": s, "end": e} for _v, s, e in _segments()]}
        used = fineplay_append.used_clip_numbers(RID, meta, db_keys)
        self.assertEqual(fineplay_append.assign_new_keys(RID, 3, used),
                         [f"fpc-{RID}-019", f"fpc-{RID}-020", f"fpc-{RID}-021"])

    def test_deleted_numbers_are_never_reused_even_if_rows_and_meta_forgot_them(self):
        # 018 이 DB·메타에서 모두 사라져도 result_payload·최댓값 기록에 남아 있으면 건너뛴다.
        meta = {"clips": [], "result_payload": {"clips": [{"clipKey": f"fpc-{RID}-018"}]}}
        used = fineplay_append.used_clip_numbers(RID, meta, [f"fpc-{RID}-002"])
        self.assertEqual(fineplay_append.assign_new_keys(RID, 1, used), [f"fpc-{RID}-019"])
        meta = {"clips": [], fineplay_append.KEY_HIGH_WATER_META: 25}
        used = fineplay_append.used_clip_numbers(RID, meta, [f"fpc-{RID}-002"])
        self.assertEqual(fineplay_append.assign_new_keys(RID, 1, used), [f"fpc-{RID}-026"])
        # 다른 신청 키·다른 규칙 키는 세지 않는다.
        used = fineplay_append.used_clip_numbers(RID, {}, ["fpc-4590-099", "manual-1", f"fpc-{RID}-003"])
        self.assertEqual(max(used), 3)

    def test_numbers_already_in_storage_are_skipped(self):
        taken = {f"fpc-{RID}-019", f"fpc-{RID}-021"}
        keys = fineplay_append.assign_new_keys(RID, 2, {18}, exists=lambda k: k in taken)
        self.assertEqual(keys, [f"fpc-{RID}-020", f"fpc-{RID}-022"])

    def test_order_across_two_videos_keeps_keys(self):
        rows = [
            {"key": "a", "source_video_id": V1, "start": 10, "prev_order": 0},
            {"key": "b", "source_video_id": V1, "start": 100, "prev_order": 1},
            {"key": "c", "source_video_id": V2, "start": 5, "prev_order": 2},
            {"key": "n1", "source_video_id": V1, "start": 150, "new": True},   # 전반 끝
            {"key": "n2", "source_video_id": V2, "start": 1, "new": True},     # 후반 시작
            {"key": "n3", "source_video_id": V2, "start": 5, "new": True},     # 같은 시각이면 기존이 먼저
        ]
        self.assertEqual(fineplay_append.order_rows(rows, {V1: 0, V2: 1}),
                         ["a", "b", "n1", "n2", "c", "n3"])


class AppendProduceTests(fixture.MatchWriteAccess):
    def setUp(self):
        super().setUp()
        self.client = self.clients["admin"]
        self.tmp = Path(tempfile.mkdtemp(prefix="fpc-append-"))
        self.storage = LocalStorage(self.tmp / "bucket")
        # 원본 2개 — 실제 ffmpeg 로 만든 작은 영상(전반 195초·후반 180초).
        for vid, dur in ((V1, 195), (V2, 180)):
            dest = self.storage._path(f"originals/{vid}.mp4")
            dest.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size=160x90:rate=5:duration={dur}",
                "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
                "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(dest),
            ], check=True)
        self.job_id = "fpc-job-459"
        self._seed()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        super().tearDown()

    # ── 픽스처 ──────────────────────────────────────────────────────────
    def _seed(self):
        manifest = {
            "analysisRequestId": RID, "team": {"teamId": TEAM, "teamName": "사이다"},
            "opponent": {"name": "상대팀"}, "lineup": LINEUP,
            "videos": [{"videoId": V1, "s3Key": f"originals/{V1}.mp4", "source": "UPLOAD"},
                       {"videoId": V2, "s3Key": f"originals/{V2}.mp4", "source": "UPLOAD"}],
        }
        segs = _segments()
        meta = {
            "analysis_request_id": str(RID), "manifest": manifest, "match_id": str(self.mid),
            "fpa_link": {"our_side": "home"},
            "plan": {"tier": "xfp", "options": ["XFP_SINGLE"], "source": "manifest"},
            # 옛 생성은 clipId 를 적지 않았다 — 18항목 모두 clipId 없음(001·008 지운 뒤에도 남아 있다).
            "clips": [{"start": s, "end": e, "team": "home" if i % 3 else "away", "sourceVideoId": v,
                       "scoreBefore": [0, 0], "scoreAfter": [0, 0], "isGoal": False, "makeVertical": False}
                      for i, (v, s, e) in enumerate(segs)],
            "callback_status": "sent",
        }
        # 액션 42개: 16클립에 3·3·2 … 로 나눠 담는다(장면 좌표 sceneState 포함 → sceneData 가 붙는다).
        per_clip = [3, 3, 2, 3, 3, 2, 3, 3, 2, 3, 3, 2, 3, 3, 2, 2]
        self.assertEqual(sum(per_clip), 42)
        with fixture.SessionLocal() as db:
            db.add(HighlightJob(id=self.job_id, mode="fineplay", status="done", job_metadata=meta))
            db.flush()
            order = 0
            k = 0
            action_id = 0  # SQLite 는 BigInteger PK 를 자동으로 못 채운다(운영 PostgreSQL 은 채움)
            for n, (v, s, e) in enumerate(segs, start=1):
                if n in DELETED:
                    continue
                key = f"fpc-{RID}-{n:03d}"
                db.add(HighlightClip(
                    id=key, job_id=self.job_id, match_id=self.mid, order_index=n - 1,
                    team_side="home" if (n - 1) % 3 else "away", source_video_id=v,
                    start_sec=s, end_sec=e, duration_seconds=e - s, main_action="Pass",
                    is_goal=(n == 5), horizontal_s3_key=output_key(TEAM, RID, key, "horizontal"),
                    thumbnail_s3_key=output_key(TEAM, RID, key, "thumbnail"),
                    title=("직접 붙인 제목" if n == 3 else None),
                    fpa_scenes={"schema": 1, "scenes": [{"clipIndex": order}]},
                ))
                db.flush()
                for seq in range(1, per_clip[k] + 1):
                    jersey = str((n + seq) % 11 + 1)
                    action_id += 1
                    db.add(HighlightClipAction(
                        id=action_id, clip_id=key, seq=seq, action_name=("Shot" if seq == per_clip[k] else "Pass"),
                        team_side="home", jersey=jersey, player_id=str(100 + int(jersey)),
                        user_id=100 + int(jersey), xg=0.1 * seq, reception_xg=0.05 * seq,
                        packing=seq, start_offset=seq - 1.0, end_offset=float(seq),
                        fpa_scene_action_index=seq - 1,
                        extra={"sceneState": {
                            "beforeDots": [{"id": f"h{jersey}", "group": "home", "jersey": jersey,
                                            "x": 10 + n, "y": 20 + seq}],
                            "afterDots": [{"id": f"h{jersey}", "group": "home", "jersey": jersey,
                                           "x": 50 + n, "y": 30 + seq}]},
                            "groupIndex": 0},
                    ))
                k += 1
                order += 1
            db.commit()
        # S3 에 이미 있는 36객체(18클립 × 가로·썸네일 — 지운 001·008 영상도 남아 있다).
        self.existing_objects = {}
        for n in range(1, 19):
            key = f"fpc-{RID}-{n:03d}"
            for kind in ("horizontal", "thumbnail"):
                obj = output_key(TEAM, RID, key, kind)
                path = self.storage._path(obj)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"existing {obj}".encode())
        for path in self.storage.root.joinpath("highlights").rglob("*"):
            if path.is_file():
                st = path.stat()
                self.existing_objects[str(path)] = (st.st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(len(self.existing_objects), 36)

    def _send(self):
        """클립 결과 '전송'(resend) 을 실제 라우트로 — FinePlay 클라이언트만 가짜로 바꿔 payload 를 받는다."""
        sent = []
        client = Mock(configured=True)
        client.post_results.side_effect = lambda payload: sent.append(json.loads(json.dumps(payload)))
        with patch("app.main.fineplay_default_client", return_value=client), \
                patch("app.main.highlight_default_storage", return_value=self.storage):
            r = self.client.post(f"/api/highlight/clip-results/matches/{self.mid}/resend", json={})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(sent), 1)
        return sent[0]

    def _snapshot(self):
        with fixture.SessionLocal() as db:
            clips = {c.id: {col: getattr(c, col) for col in (
                "job_id", "match_id", "team_side", "source_video_id", "start_sec", "end_sec",
                "duration_seconds", "main_action", "is_goal", "title", "horizontal_s3_key",
                "vertical_s3_key", "thumbnail_s3_key", "fpa_scenes", "created_at")}
                for c in db.query(HighlightClip).all()}
            actions = sorted(
                (a.id, a.clip_id, a.seq, a.action_name, a.team_side, a.jersey, a.player_id, a.user_id,
                 a.xg, a.xgot, a.reception_xg, a.packing, a.epv, a.pc, a.start_offset, a.end_offset,
                 a.fpa_scene_action_index, _canon(a.extra))
                for a in db.query(HighlightClipAction).all())
        return clips, actions

    def _append(self, new=NEW):
        body = {"append": True, "clips": [
            {"start": s, "end": e, "team": t, "sourceVideoId": v, "isGoal": g,
             "scoreBefore": [0, 0], "scoreAfter": [0, 0]} for v, s, e, t, g in new],
            # 추가 모드는 FPA 연결·점수판을 바꾸지 않는다 — 실려 와도 무시돼야 한다.
            "fpaMatchId": "", "fpaOurSide": "away"}
        with patch("app.main.highlight_default_storage", return_value=self.storage):
            r = self.client.post(f"/api/highlight/fineplay-jobs/{self.job_id}/produce", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _render(self):
        """렌더 워커가 하는 일 그대로 — 대기열 작업 하나를 집어 run_fineplay_produce 를 돌리고 끝낸다."""
        from app.highlight_render_queue import HighlightRenderTask
        with fixture.SessionLocal() as db:
            task = db.query(HighlightRenderTask).filter_by(job_id=self.job_id, status="queued").one()
            self.assertEqual(task.kind, "fineplay")
            task.status = "running"
            db.commit()
            task_id = task.id
        with patch.object(jobs, "default_storage", return_value=self.storage):
            jobs.run_fineplay_produce(self.job_id)
        with fixture.SessionLocal() as db:
            db.get(HighlightRenderTask, task_id).status = "done"
            db.commit()

    # ── 테스트 ──────────────────────────────────────────────────────────
    def test_existing_clips_endpoint_lists_locked_clips_and_deleted_segments(self):
        r = self.client.get(f"/api/highlight/fineplay-jobs/{self.job_id}/existing-clips")
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        self.assertEqual(len(data["clips"]), 16)
        self.assertEqual(sum(c["actionCount"] for c in data["clips"]), 42)
        self.assertEqual(data["nextKey"], f"fpc-{RID}-019")
        self.assertEqual(
            [(d["formerKey"], d["start"], d["end"]) for d in data["deletedSegments"]],
            [(f"fpc-{RID}-001", 3.658, 13.658), (f"fpc-{RID}-008", 149.304, 160.304)])

    def test_append_renders_only_new_clips_and_keeps_existing_payload_identical(self):
        before_payload = self._send()
        self.assertEqual(len(before_payload["clips"]), 16)
        before_clips, before_actions = self._snapshot()
        before_meta = dict(fixture.SessionLocal().get(HighlightJob, self.job_id).job_metadata)

        queued = self._append()
        expected_new = [f"fpc-{RID}-{n:03d}" for n in range(19, 26)]
        self.assertEqual(queued["clip_keys"], expected_new)
        self._render()

        with fixture.SessionLocal() as db:
            job = db.get(HighlightJob, self.job_id)
            self.assertEqual(job.status, "done", job.error_message)
            meta = job.job_metadata
            rows = db.query(HighlightClip).filter_by(job_id=self.job_id).order_by(HighlightClip.order_index).all()
            order = [(r.id, r.source_video_id, r.start_sec) for r in rows]
            self.assertEqual([r.order_index for r in rows], list(range(23)))
            new_actions = db.query(HighlightClipAction).filter(HighlightClipAction.clip_id.in_(expected_new)).count()
        # 1) 순서 = (영상, 시작) — 두 영상에 걸쳐 시간 순.
        vorder = {V1: 0, V2: 1}
        self.assertEqual(order, sorted(order, key=lambda x: (vorder[x[1]], x[2])))
        self.assertEqual(len(order), 23)
        # 전반 11개(기존 7 + 새 4) — 전반 끝(182초) 은 전반 마지막, 후반 시작(1초) 은 후반 첫째.
        self.assertEqual((order[10][1], order[10][2]), (V1, 182.0))
        self.assertEqual((order[11][1], order[11][2]), (V2, 1.0))
        # 지운 001 구간(3.658초)은 맨 앞에 새 키로 들어간다.
        self.assertEqual(order[0], (f"fpc-{RID}-019", V1, 3.658))
        # 2) 기존 행·액션은 order_index 외에 그대로, 새 클립은 액션 0개.
        after_clips, after_actions = self._snapshot()
        self.assertEqual({k: v for k, v in after_clips.items() if k in before_clips}, before_clips)
        self.assertEqual(after_actions, before_actions)
        self.assertEqual(len(after_actions), 42)
        self.assertEqual(new_actions, 0)
        # 3) S3(로컬) — 새 키 7개 × 가로·썸네일만 올라갔고, 기존 36객체는 시각·내용 그대로.
        self.assertEqual(sorted(self.storage.uploads), sorted(
            output_key(TEAM, RID, k, kind) for k in expected_new for kind in ("horizontal", "thumbnail")))
        for path, (mtime, digest) in self.existing_objects.items():
            p = Path(path)
            self.assertEqual((p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest()), (mtime, digest), path)
        # 4) 메타 — 결과 payload·FPA 연결·점수판은 그대로, 자동 전송 없음.
        self.assertEqual(meta.get("result_payload"), before_meta.get("result_payload"))
        self.assertEqual(meta["fpa_link"], before_meta["fpa_link"])
        self.assertTrue(meta["callback_status"].startswith("held"))
        self.assertEqual(meta[fineplay_append.APPENDED_KEYS_META], expected_new)
        self.assertNotIn("produce_mode", meta)

        # 5) 전송 — 기존 16클립 항목은 바이트 단위로 같고, 전체는 시간 순 23개, 새 클립은 액션 없음.
        after_payload = self._send()
        before_by_key = {c["clipKey"]: _canon(c) for c in before_payload["clips"]}
        after_by_key = {c["clipKey"]: c for c in after_payload["clips"]}
        for key, blob in before_by_key.items():
            self.assertEqual(_canon(after_by_key[key]), blob, key)
            self.assertTrue((after_by_key[key].get("teamView") or {}).get("actions"), key)
        self.assertEqual([c["clipKey"] for c in after_payload["clips"]], [o[0] for o in order])
        for key in expected_new:
            self.assertEqual((after_by_key[key].get("teamView") or {}).get("actions") or [], [], key)
            self.assertNotIn("involvedPlayers", after_by_key[key])
        scene_before = sum(1 for c in before_payload["clips"] for a in (c.get("teamView") or {}).get("actions") or []
                           if a.get("sceneData"))
        scene_after = sum(1 for c in after_payload["clips"] for a in (c.get("teamView") or {}).get("actions") or []
                          if a.get("sceneData"))
        self.assertGreater(scene_before, 0)
        self.assertEqual(scene_after, scene_before)

        # 6) 클립 결과 목록 — 새 클립에 '추가됨' 표시가 실린다.
        r = self.client.get(f"/api/highlight/clip-results/matches/{self.mid}/clips")
        listed = {c["id"]: c for c in r.json()["clips"]}
        self.assertTrue(all(listed[k]["appended"] and listed[k]["action_count"] == 0 for k in expected_new))
        self.assertFalse(any(listed[k]["appended"] for k in before_by_key))

        # 7) 한 번 더 추가해도 번호는 이어진다(026), 기존 23개는 그대로.
        second = self._append([(V2, 176.0, 179.0, "home", False)])
        self.assertEqual(second["clip_keys"], [f"fpc-{RID}-026"])

    def test_append_rejects_existing_span_and_job_without_clips(self):
        with patch("app.main.highlight_default_storage", return_value=self.storage):
            r = self.client.post(f"/api/highlight/fineplay-jobs/{self.job_id}/produce", json={
                "append": True, "clips": [{"start": 20.0, "end": 30.0, "sourceVideoId": V1, "team": "home"}]})
        self.assertEqual(r.status_code, 409, r.text)
        with fixture.SessionLocal() as db:
            db.add(HighlightJob(id="empty-job", mode="fineplay", status="tagging",
                                job_metadata={"manifest": {"analysisRequestId": 1, "videos": []}}))
            db.commit()
        r = self.client.post("/api/highlight/fineplay-jobs/empty-job/produce",
                             json={"append": True, "clips": [{"start": 1, "end": 2}]})
        self.assertEqual(r.status_code, 409, r.text)

    def test_storage_collision_skips_number_without_overwrite(self):
        # 019 영상이 (어떤 이유로) 이미 S3 에 있으면 019 를 건너뛰고 020 부터 — 019 객체는 그대로.
        path = self.storage._path(output_key(TEAM, RID, f"fpc-{RID}-019", "horizontal"))
        path.write_bytes(b"stray")
        queued = self._append(NEW[:2])
        self.assertEqual(queued["clip_keys"], [f"fpc-{RID}-020", f"fpc-{RID}-021"])
        self._render()
        self.assertEqual(path.read_bytes(), b"stray")


def load_tests(loader, tests, pattern):
    """픽스처(MatchWriteAccess)에서 물려받은 테스트는 그 파일에서 돈다 — 여기 것만 모은다."""
    suite = unittest.TestSuite()
    for case in (KeyAssignmentTests, AppendProduceTests):
        names = [n for n in loader.getTestCaseNames(case) if n in case.__dict__]
        suite.addTests(case(n) for n in names)
    return suite


if __name__ == "__main__":
    unittest.main()
