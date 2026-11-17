"""분석관 최종 점수 확정 → FinePlay finalScore (2026-11-11 FinePlay C-21 ②).

확정 전이면 키가 없고, 확정하면 신청 관점(우리 : 상대)으로 싣는다. 사전 작업은 링크 사이드가 '우리',
자체전은 A팀 = 우리. 이미 보낸 결과는 점수를 바꾸면 다시 보내고, 같은 값이면 아무것도 보내지 않는다.
Run: python -m unittest discover -s apps/api/tests -p test_fineplay_final_score.py -v
"""
import ast
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import Body, Depends, FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import BigInteger, create_engine  # noqa: E402
from sqlalchemy.dialects.postgresql import JSONB  # noqa: E402
from sqlalchemy.ext.compiler import compiles  # noqa: E402
from sqlalchemy.orm import Session, sessionmaker  # noqa: E402

from app import fineplay_final_score as fs  # noqa: E402
from app.auth import get_session_user, require_admin  # noqa: E402
from app.db import Base, get_db  # noqa: E402
from app.fineplay_plan import prepare_payload  # noqa: E402
from app.highlight_jobs import update_job  # noqa: E402
from app.models import AuditLog, HighlightJob, User  # noqa: E402


@compiles(JSONB, 'sqlite')
def _sqlite_jsonb(element, compiler, **kw):
    return 'JSON'


@compiles(BigInteger, 'sqlite')
def _sqlite_bigint(element, compiler, **kw):
    return 'INTEGER'


NOW = datetime(2026, 11, 11, 3, 0, tzinfo=timezone.utc)


def _clips(*afters):
    return [{"start": float(i * 10), "end": float(i * 10 + 5), "sourceVideoId": "v1", "scoreAfter": a}
            for i, a in enumerate(afters)]


class ScoreModuleTest(unittest.TestCase):
    def test_normalize_accepts_digits_and_rejects_out_of_range(self):
        self.assertEqual(fs.normalize("2", 3), (2, 3))
        for bad in [(-1, 0), (100, 0), ("a", 1), (None, 1), (True, 1)]:
            with self.assertRaises(ValueError):
                fs.normalize(*bad)

    def test_confirm_keeps_time_and_actor_when_value_is_same(self):
        meta = {}
        value, changed = fs.confirm(meta, 2, 1, actor={"id": "a1"}, now=NOW)
        self.assertTrue(changed)
        self.assertEqual(value["confirmed_at"], "2026-11-11T03:00:00Z")
        meta[fs.FINAL_SCORE_KEY] = value
        again, changed = fs.confirm(meta, "2", "1", actor={"id": "other"}, now=NOW.replace(hour=5))
        self.assertFalse(changed)
        self.assertEqual(again["confirmed_by"], {"id": "a1"})
        edited, changed = fs.confirm(meta, 3, 1, actor={"id": "a2"}, now=NOW.replace(hour=6))
        self.assertTrue(changed)
        self.assertEqual(edited["previous"], {"home": 2, "away": 1, "confirmed_at": "2026-11-11T03:00:00Z"})

    def test_request_view_follows_our_side(self):
        meta = {fs.FINAL_SCORE_KEY: {"home": 3, "away": 1, "confirmed_at": "t"}}
        self.assertEqual(fs.for_request(meta), {"our": 3, "opponent": 1, "confirmedAt": "t"})
        meta["fpa_link"] = {"our_side": "away"}
        self.assertEqual(fs.for_request(meta), {"our": 1, "opponent": 3, "confirmedAt": "t"})
        # 사전 작업 — 링크 사이드가 우리
        self.assertEqual(fs.for_request(meta, "home")["our"], 3)
        self.assertEqual(fs.for_request(meta, "away")["our"], 1)
        self.assertEqual(fs.for_competition(meta), {"home": 3, "away": 1, "confirmedAt": "t"})

    def test_not_confirmed_or_broken_means_no_key(self):
        payload = {"clips": [], "finalScore": {"our": 9, "opponent": 9}}   # 예전 payload 를 다시 보낼 때
        self.assertNotIn("finalScore", fs.attach(payload, {}))
        self.assertIsNone(fs.for_request({fs.FINAL_SCORE_KEY: {"home": "x", "away": 1}}))
        self.assertNotIn("finalScore", fs.attach_competition({"clips": []}, {fs.FINAL_SCORE_KEY: {"home": 1}}))

    def test_suggested_uses_last_clip_in_render_order(self):
        meta = {"manifest": {"videos": [{"videoId": "v1"}, {"videoId": "v2"}]},
                "clips": [{"start": 50, "sourceVideoId": "v1", "scoreAfter": [1, 0]},
                          {"start": 5, "sourceVideoId": "v2", "scoreAfter": [2, 2]},   # 두 번째 영상이 나중
                          {"start": 90, "sourceVideoId": "v1", "scoreAfter": [1, 1]}]}
        self.assertEqual(fs.suggested(meta), (2, 2))
        self.assertIsNone(fs.suggested({"clips": [{"start": 1}]}))

    def test_prepare_payload_attaches_score_even_for_basic_and_still_strips_analysis(self):
        meta = {"plan": {"tier": "basic"}, fs.FINAL_SCORE_KEY: {"home": 2, "away": 0}}
        payload = {"clips": [{"clipKey": "c1", "teamView": {"actions": []}}]}
        out = prepare_payload(payload, meta)
        self.assertEqual(out["finalScore"], {"our": 2, "opponent": 0})
        self.assertNotIn("teamView", out["clips"][0])


def _route_app(client):
    app = FastAPI()
    scope = dict(globals(), app=app, __name__='app._final_score_test', __package__='app',
                 _require_superuser=require_admin, fineplay_final_score=fs,
                 fineplay_default_client=lambda: client, fineplay_prepare_payload=prepare_payload,
                 update_job=update_job, AuditLog=AuditLog, User=User, HighlightJob=HighlightJob,
                 Session=Session, Body=Body, Depends=Depends, HTTPException=HTTPException, get_db=get_db, UUID=UUID)
    names = {'_audit', '_final_score_view', 'get_fineplay_final_score', 'confirm_fineplay_final_score'}
    tree = ast.parse((Path(__file__).parents[1] / 'app/main.py').read_text())
    selected = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    assert len(selected) == len(names)
    exec(compile(ast.Module(body=selected, type_ignores=[]), 'main.py routes', 'exec'), scope)
    return app


class ConfirmEndpointTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.engine = create_engine('sqlite:///' + str(Path(self.temp.name) / 't.db'),
                                    connect_args={'check_same_thread': False})
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine, tables=[m.__table__ for m in (User, HighlightJob, AuditLog)])
        self.Session = sessionmaker(bind=self.engine)
        self.fineplay = SimpleNamespace(configured=True, post_results=Mock(return_value={}))
        app = _route_app(self.fineplay)

        def database():
            with self.Session() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_session_user] = lambda: User(id='analyst-1', name='분석관', role='SUPERADMIN')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def add_job(self, job_id, metadata):
        with self.Session() as db:
            db.add(HighlightJob(id=job_id, mode='fineplay', status='done', original_filename='x.mp4',
                                job_metadata=metadata))
            db.commit()

    def meta(self, job_id):
        with self.Session() as db:
            return dict(db.get(HighlightJob, job_id).job_metadata or {})

    def test_confirm_before_send_only_saves_and_next_send_carries_it(self):
        self.add_job('fp-1', {"analysis_request_id": "1", "clips": _clips([1, 0], [2, 1])})
        view = self.client.get('/api/highlight/fineplay-jobs/fp-1/final-score').json()
        self.assertIsNone(view["home"])
        self.assertEqual(view["suggested"], {"home": 2, "away": 1})
        self.assertEqual(view["ourSide"], "home")

        res = self.client.put('/api/highlight/fineplay-jobs/fp-1/final-score', json={"home": 3, "away": 1})
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertTrue(body["changed"])
        self.assertEqual(body["resent"], {})
        self.fineplay.post_results.assert_not_called()          # 아직 안 보낸 잡은 저장만
        saved = self.meta('fp-1')[fs.FINAL_SCORE_KEY]
        self.assertEqual((saved["home"], saved["away"]), (3, 1))
        self.assertEqual(saved["confirmed_by"]["id"], "analyst-1")
        self.assertTrue(saved["confirmed_at"].endswith("Z"))
        with self.Session() as db:
            log = db.query(AuditLog).filter_by(action="FINEPLAY_FINAL_SCORE_CONFIRMED").one()
            self.assertEqual(log.details["home"], 3)
        self.assertEqual(prepare_payload({"clips": []}, self.meta('fp-1'))["finalScore"]["our"], 3)

    def test_change_after_send_resends_once_and_same_value_sends_nothing(self):
        self.add_job('fp-2', {"analysis_request_id": "2", "callback_status": "sent",
                              "fpa_link": {"match_id": "m", "our_side": "away"},
                              "result_payload": {"analysisRequestId": "2", "clips": [{"clipKey": "c1"}]}})
        self.client.put('/api/highlight/fineplay-jobs/fp-2/final-score', json={"home": 0, "away": 2})
        self.fineplay.post_results.assert_called_once()
        sent = self.fineplay.post_results.call_args.args[0]
        self.assertEqual(sent["finalScore"]["our"], 2)          # 우리 = 원정
        self.assertEqual(sent["finalScore"]["opponent"], 0)
        self.assertEqual(sent["clips"], [{"clipKey": "c1"}])    # 결과는 그대로, 점수만 더해짐
        self.assertEqual(self.meta('fp-2')["result_payload"]["finalScore"]["our"], 2)

        again = self.client.put('/api/highlight/fineplay-jobs/fp-2/final-score', json={"home": "0", "away": "2"}).json()
        self.assertFalse(again["changed"])
        self.fineplay.post_results.assert_called_once()        # 같은 값 — 다시 안 보낸다

    def test_standalone_resends_each_sent_side_from_its_own_view(self):
        self.add_job('pre-1', {"standalone": True, "links": {
            "home": {"analysis_request_id": "10", "callback_status": "sent", "result_payload": {"analysisRequestId": "10", "clips": []}},
            "away": {"analysis_request_id": "11", "callback_status": "skipped: 해당 팀 클립 없음"},
        }})
        body = self.client.put('/api/highlight/fineplay-jobs/pre-1/final-score', json={"home": 4, "away": 2}).json()
        self.assertEqual(body["resent"], {"home": "sent"})
        sent = self.fineplay.post_results.call_args.args[0]
        self.assertEqual(sent["finalScore"], {"our": 4, "opponent": 2, "confirmedAt": sent["finalScore"]["confirmedAt"]})
        self.assertIsNone(body["ourSide"])

    def test_resend_failure_keeps_score_and_marks_callback_failed(self):
        self.fineplay.post_results.side_effect = RuntimeError("HTTP 502")
        self.add_job('fp-3', {"analysis_request_id": "3", "callback_status": "sent",
                              "result_payload": {"analysisRequestId": "3", "clips": []}})
        body = self.client.put('/api/highlight/fineplay-jobs/fp-3/final-score', json={"home": 1, "away": 1}).json()
        self.assertTrue(body["resent"]["request"].startswith("failed"))
        meta = self.meta('fp-3')
        self.assertEqual(meta[fs.FINAL_SCORE_KEY]["home"], 1)
        self.assertTrue(meta["callback_status"].startswith("failed"))

    def test_rejects_bad_input_and_non_fineplay_jobs(self):
        self.add_job('fp-4', {})
        self.assertEqual(self.client.put('/api/highlight/fineplay-jobs/fp-4/final-score', json={"home": 100, "away": 0}).status_code, 400)
        self.assertEqual(self.client.put('/api/highlight/fineplay-jobs/fp-4/final-score', json={"home": 1}).status_code, 400)
        self.assertNotIn(fs.FINAL_SCORE_KEY, self.meta('fp-4'))
        self.assertEqual(self.client.get('/api/highlight/fineplay-jobs/none/final-score').status_code, 404)


if __name__ == '__main__':
    unittest.main()
