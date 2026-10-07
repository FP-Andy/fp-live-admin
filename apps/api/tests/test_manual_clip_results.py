"""Isolated manual → existing clip/dual contract tests. No live service calls.

Main's route functions are loaded from its AST to avoid starting recording,
delivery and GPU workers. Real SQLAlchemy models, auth and FPA helpers are used.
Run: DATABASE_URL=sqlite:////tmp/fpc-unit-import.db python -m unittest discover
     -s apps/api/tests -p test_manual_clip_results.py -v
"""
import ast
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
from typing import Any
import unittest
from unittest.mock import Mock, patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault('DATABASE_URL', 'sqlite:////tmp/fpc-manual-import.db')
from fastapi import BackgroundTasks, Body, Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.testclient import TestClient
from sqlalchemy import BigInteger, create_engine, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, sessionmaker
from app import manual_clip_results as publisher
from app.auth import get_session_user, require_admin, require_session_user
from app.db import Base, get_db
from app import fineplay_fpa as fpa
from app.fineplay_plan import resolve_plan
from app.highlight_storage import S3Storage
from app.models import HighlightClip, HighlightClipAction, HighlightJob, Match, User, FpaSavedLog
from app.highlight_render_queue import HighlightRenderTask
from app.scene_motion import attach_scene_motions, scene_motion_key


@compiles(JSONB, 'sqlite')
def sqlite_jsonb(element, compiler, **kw):
    return 'JSON'


@compiles(BigInteger, 'sqlite')
def sqlite_bigint(element, compiler, **kw):
    return 'INTEGER'


def route_app(storage):
    app = FastAPI()
    scope = dict(globals(), app=app, __name__='app._clip_contract_test', __package__='app',
                 _require_session_user=require_session_user, _require_superuser=require_admin,
                 _is_superuser=lambda user: user.role == 'SUPERADMIN',
                 highlight_default_storage=lambda: storage,
                 highlight_output_prefix=lambda: 'highlights/output/',
                 fineplay_resolve_plan=resolve_plan, FineplayFpaScene=fpa.FpaScene,
                 delete_job_files=Mock())
    for name in ['action_label', 'canonical_action_name', 'base_action_name', 'pick_primary',
                 'annotate_action_codes', 'equal_split_offsets', 'scene_action_rows']:
        scope['fineplay_' + name] = getattr(fpa, name)
    names = {'_require_manual_job', '_fineplay_work_done', 'upload_manual_clip', 'register_manual_clip_results', '_serialize_clip_action',
             '_clip_job_context', '_fineplay_lineup_sides', '_carry_over_offsets',
             'clip_result_matches', 'clip_result_job_clips', 'clip_result_detail',
             'clip_result_put_actions', 'download_clip_scene_motion', 'clip_result_delete_clip',
             'delete_highlight_job'}
    tree = ast.parse((Path(__file__).parents[1] / 'app/main.py').read_text())
    selected = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    assert len(selected) == len(names)
    exec(compile(ast.Module(body=selected, type_ignores=[]), 'main.py routes', 'exec'), scope)
    return app, scope


class ManualClipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.engine = create_engine('sqlite:///' + str(self.root / 'test.db'),
                                    connect_args={'check_same_thread': False})
        event.listen(self.engine, 'connect', lambda conn, _: conn.execute('PRAGMA foreign_keys=ON'))
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine, tables=[m.__table__ for m in
                                 (User, Match, HighlightJob, HighlightClip, HighlightClipAction, HighlightRenderTask)])
        self.Session = sessionmaker(bind=self.engine)
        self.storage = SimpleNamespace(configured=True, upload=Mock(), exists=Mock(return_value=True),
            presigned_get=Mock(side_effect=lambda key, **kw: 'https://fixture.invalid/' + key),
            presigned_download=Mock(side_effect=lambda key, filename, **kw: 'https://fixture.invalid/' + key))
        self.renderer = Mock(side_effect=lambda src, out, start, duration: duration)
        for target, value in [('engine', self.engine), ('SessionLocal', self.Session),
                              ('default_storage', lambda: self.storage), ('render_manual_clip', self.renderer)]:
            p = patch.object(publisher, target, value)
            p.start()
            self.addCleanup(p.stop)
        self.user = User(id='fixture-admin', name='Fixture', role='SUPERADMIN')
        app, self.scope = route_app(self.storage)
        def database():
            with self.Session() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_session_user] = lambda: self.user
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.infos = [dict(name='clip_001.mp4', order=1, requested_start=110.5, requested_end=114.5, kind='home_goal'),
                      dict(name='clip_002.mp4', order=2, requested_start=50, requested_end=55, kind='away_goal')]
        for info in self.infos:
            (self.root / info['name']).write_bytes(b'fixture; media renderer mocked')
        self.add_job('manual-one')

    def test_legacy_cuts_report_zero_partial_full_and_retry_only_failures(self):
        from app import highlight_jobs as jobs
        source=self.root/'source.mp4';source.write_bytes(b'synthetic source')
        for succeeds,expected in [(0,'error'),(1,'clips_partial'),(2,'clips_ready')]:
            jid='operator-'+str(succeeds);folder=self.root/jid
            with self.Session() as db:
                db.add(HighlightJob(id=jid,mode='operator',status='ready',original_filename='source.mp4',upload_path=str(source),job_metadata={}))
                db.commit()
            calls=[]
            def cut(src,out,start,duration):
                calls.append(str(out))
                if len(calls)<=succeeds:out.write_bytes(b'preserve '+str(start).encode());return True
                return False
            with patch.object(jobs,'SessionLocal',self.Session),patch.object(jobs,'clips_dir',return_value=folder),patch.object(jobs,'_ffmpeg_cut',side_effect=cut):
                jobs.cut_clips_for_job(jid,[5,10],2.,2.)
            with self.Session() as db:
                job=db.get(HighlightJob,jid);self.assertEqual(job.status,expected)
                self.assertEqual(len(job.job_metadata['clips']),succeeds)
                self.assertEqual(len(job.job_metadata['clip_failures']),2-succeeds)
                saved={name:(folder/name).read_bytes() for name in job.job_metadata['clips']}
            retry=[]
            def success(src,out,start,duration):retry.append(out);out.write_bytes(b'retried');return True
            with patch.object(jobs,'SessionLocal',self.Session),patch.object(jobs,'clips_dir',return_value=folder),patch.object(jobs,'_ffmpeg_cut',side_effect=success):
                jobs.cut_clips_for_job(jid,[5,10],2.,2.)
            self.assertEqual(len(retry),2-succeeds)
            for name,content in saved.items():self.assertEqual((folder/name).read_bytes(),content)
            with self.Session() as db:self.assertEqual(db.get(HighlightJob,jid).status,'clips_ready')

    def add_job(self, job_id, **metadata):
        with self.Session() as db:
            db.add(HighlightJob(id=job_id, mode='manual', status='done', original_filename='Fixture match.mp4',
                clips_dir=str(self.root), export_path=str(self.root / 'montage.mp4'),
                job_metadata={'sport': 'FOOTBALL', 'clip_info': self.infos,
                    'scoreboard': {'home_name': '홈 테스트', 'away_name': '원정 테스트'}, **metadata}))
            db.commit()

    def state(self):
        with self.Session() as db:
            job = db.get(HighlightJob, 'manual-one')
            return job.status, publisher.registration_state(job)

    def register(self):
        return self.client.post('/api/highlight/manual-jobs/manual-one/clip-results')

    def clip_id(self, index=1):
        return publisher.manual_clip_id('manual-one', f'clip_{index:03}.mp4')

    def detail(self, index=1):
        return self.client.get('/api/highlight/clip-results/clips/' + self.clip_id(index))

    def test_register_individual_clips_existing_list_and_detail(self):
        self.assertEqual(self.register().status_code, 202)
        status, state = self.state()
        self.assertEqual((status, state['status'], state['completed']), ('done', 'ready', 2))
        listing = self.client.get('/api/highlight/clip-results/matches').json()
        self.assertEqual((listing[0]['source_mode'], listing[0]['clip_count']), ('manual', 2))
        self.assertEqual(listing[0]['name'], 'Fixture match.mp4')
        clips = self.client.get('/api/highlight/clip-results/jobs/manual-one/clips').json()['clips']
        self.assertEqual([c['team_side'] for c in clips], ['home', 'away'])
        self.assertEqual([c['duration_seconds'] for c in clips], [4, 5])
        self.assertEqual([c['start_sec'] for c in clips], [110.5, 50])
        detail = self.detail().json()
        self.assertEqual(detail['team_labels'], {'home': '홈 테스트', 'away': '원정 테스트'})
        self.assertIsNone(detail['match_id'])
        self.assertTrue(detail['video_url'].endswith('/manual/manual-one/clip_001.mp4'))
        self.assertEqual(detail['actions'], [])
        with self.Session() as db:
            self.assertEqual(db.query(Match).count(), 0)

    def save_dual(self, x=20):
        state = {'beforeDots': [{'id': 'h7', 'group': 'home', 'jersey': '7', 'x': x, 'y': 20}],
                 'afterDots': [{'id': 'h7', 'group': 'home', 'jersey': '7', 'x': 70, 'y': 30}],
                 'passArrows': [], 'primary': {'group': 'home', 'jersey': '7'}}
        rows = [{'Team': 'home', 'Player': '7', 'Action': 'Shot', 'SceneIndex': 0,
                 'SceneActionIndex': 0, 'SceneState': json.dumps(state)}]
        scenes = {'schema': 'fpa-dual-fixture/v1', 'scenes': [{'beforeDots': state['beforeDots'], 'rows': rows}]}
        response = self.client.put('/api/highlight/clip-results/clips/' + self.clip_id() + '/actions',
                                   json={'rows': rows, 'scenes': scenes})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()['actions']), 1)
        self.assertEqual(self.detail().json()['fpa_scenes'], scenes)
        return self.detail().json()

    def test_partial_failure_retry_preserves_dual_title_and_offsets(self):
        self.storage.upload.side_effect = [None, RuntimeError('synthetic storage outage')]
        with self.assertLogs('app.manual_clip_results', 'ERROR'):
            self.register()
        status, state = self.state()
        self.assertEqual((status, state['status'], state['completed']), ('done', 'error', 1))
        first = self.save_dual()
        actions = first['actions']
        actions[0].update(startOffset=.5, endOffset=3)
        result = self.client.put('/api/highlight/clip-results/clips/' + self.clip_id() + '/actions', json={'actions': actions})
        self.assertEqual(result.status_code, 200, result.text)
        with self.Session() as db:
            db.get(HighlightClip, self.clip_id()).title = '분석 완료 장면'
            db.commit()
        before = self.detail().json()
        self.storage.upload.side_effect = None
        self.register()
        self.register()
        self.assertEqual(self.detail().json(), before)
        self.assertEqual(self.detail(2).json()['actions'], [])
        self.assertEqual(self.renderer.call_count, 3)  # first, failed second, retried second
        self.assertEqual(self.state()[1]['completed'], 2)

    def test_delete_clip_does_not_resurrect_and_delete_job_removes_analysis(self):
        self.register()
        self.save_dual()
        result = self.client.delete('/api/highlight/clip-results/clips/' + self.clip_id())
        self.assertEqual(result.status_code, 200, result.text)
        publisher.publish_manual_clip_results('manual-one')
        self.register()
        self.assertEqual(self.detail().status_code, 404)
        self.assertEqual(self.state()[1]['completed'], 1)
        result = self.client.delete('/api/highlight/jobs/manual-one')
        self.assertEqual(result.status_code, 200, result.text)
        with self.Session() as db:
            self.assertEqual(db.query(HighlightClip).count(), 0)
            self.assertEqual(db.query(HighlightClipAction).count(), 0)
            self.assertIsNone(db.get(HighlightJob, 'manual-one'))

    def test_registration_authorization_sport_completion_and_filename(self):
        self.user = None
        self.assertEqual(self.register().status_code, 401)
        self.user = User(id='operator', name='Fixture', role='OPERATOR')
        self.assertEqual(self.register().status_code, 403)
        self.user = User(id='admin', name='Fixture', role='SUPERADMIN')
        self.add_job('basketball', sport='BASKETBALL')
        self.assertEqual(self.client.post('/api/highlight/manual-jobs/basketball/clip-results').status_code, 409)
        with self.Session() as db:
            db.get(HighlightJob, 'manual-one').status = 'merging'
            db.commit()
        self.assertEqual(self.register().status_code, 409)
        for name in ['../clip_001.mp4', 'intro.mp4', 'clip_001.mp4/extra']:
            with self.assertRaises(ValueError):
                publisher.manual_clip_id('job', name)
        self.renderer.assert_not_called()

    def test_storage_failure_keeps_finished_montage_and_retries_after_restart(self):
        self.storage.configured = False
        with self.assertLogs('app.manual_clip_results', 'ERROR'):
            self.register()
        self.assertEqual(self.state()[0], 'done')
        self.assertEqual(self.state()[1]['status'], 'error')
        self.storage.configured = True
        with self.Session() as db:
            job = db.get(HighlightJob, 'manual-one')
            job.job_metadata = {**job.job_metadata, 'clip_results': {'status': 'running'}}
            db.commit()
        self.register()
        self.assertEqual(self.state()[1]['status'], 'ready')

    def test_analyzed_clip_source_cannot_be_replaced(self):
        self.register()
        self.save_dual()
        before = self.detail().json()
        source = self.root / 'clip_001.mp4'
        original_bytes = source.read_bytes()
        response = self.client.post('/api/highlight/manual-jobs/manual-one/clips',
            files={'clip': ('new.mp4', b'changed source', 'video/mp4')},
            data={'index': 1, 'requested_start': 110.5, 'requested_end': 114.5})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(source.read_bytes(), original_bytes)
        self.assertEqual(self.detail().json(), before)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg/ffprobe required')
    def test_real_merge_auto_registers_only_football_and_keeps_montage_on_failure(self):
        from app import highlight_jobs as jobs
        with patch.object(jobs, 'SessionLocal', self.Session), patch.object(jobs, 'HIGHLIGHT_RUNTIME_DIR', self.root), \
             patch.object(jobs, 'FINAL_PRESET', 'ultrafast'), patch.object(jobs, 'default_client', side_effect=AssertionError('No external callback')):
            for name, sport, configured in [('auto-football', 'FOOTBALL', True),
                                             ('auto-failure', 'FOOTBALL', False),
                                             ('auto-basketball', 'BASKETBALL', True)]:
                self.storage.configured = configured
                directory = jobs.clips_dir(name)
                directory.mkdir(parents=True)
                source = directory / 'clip_001.mp4'
                subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2',
                                '-c:v', 'libx264', '-threads', '1', str(source)], check=True, capture_output=True)
                info = {'name': 'clip_001.mp4', 'order': 1, 'requested_start': 0, 'requested_end': 2, 'kind': 'home'}
                source.with_suffix('.json').write_text(json.dumps(info))
                with self.Session() as db:
                    db.add(HighlightJob(id=name, status='collecting', mode='manual', clips_dir=str(directory), job_metadata={'sport': sport}))
                    db.commit()
                if configured:
                    jobs.merge_manual_clips_for_job(name)
                else:
                    with self.assertLogs('app.manual_clip_results', 'ERROR'):
                        jobs.merge_manual_clips_for_job(name)
                with self.Session() as db:
                    job = db.get(HighlightJob, name)
                    self.assertEqual(job.status, 'done', job.error_message)
                    self.assertTrue(Path(job.export_path).is_file())
                    state = publisher.registration_state(job)
                    if sport == 'BASKETBALL':
                        self.assertEqual(state, {})
                        self.assertEqual(db.query(HighlightClip).filter_by(job_id=name).count(), 0)
                    else:
                        self.assertEqual(state['status'], 'ready' if configured else 'error')

    def test_overlapping_publications_coalesce(self):
        entered, release = threading.Event(), threading.Event()
        def render(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return args[-1]
        self.renderer.side_effect = render
        thread = threading.Thread(target=publisher.publish_manual_clip_results, args=('manual-one',))
        thread.start()
        try:
            self.assertTrue(entered.wait(3))
            publisher.publish_manual_clip_results('manual-one')
            self.assertEqual(self.renderer.call_count, 1)
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.state()[1]['completed'], 2)

    def test_download_uses_current_scene_key_and_auth(self):
        self.register()
        self.save_dual()
        url = '/api/highlight/clip-results/clips/' + self.clip_id() + '/scene-motions/1/download'
        first = self.client.get(url)
        self.assertEqual(first.status_code, 200, first.text)
        first_key = self.storage.presigned_download.call_args.args[0]
        self.assertTrue(first.json()['filename'].endswith('-action-1.mp4'))
        self.save_dual(x=35)
        self.storage.exists.side_effect = lambda key: key == first_key
        self.assertEqual(self.client.get(url).status_code, 409)
        self.storage.exists.side_effect = None
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertNotEqual(self.storage.presigned_download.call_args.args[0], first_key)
        self.assertEqual(self.client.get(url.replace('/1/', '/99/')).status_code, 404)
        self.user = None
        self.assertEqual(self.client.get(url).status_code, 401)

    def test_attachment_signature_headers(self):
        client = Mock()
        store = S3Storage(bucket='isolated-fixture')
        with patch.object(store, '_client', return_value=client):
            store.presigned_download('current-scene.mp4', '장면 1.mp4', expires=600)
        params = client.generate_presigned_url.call_args.kwargs
        self.assertEqual(params['ExpiresIn'], 600)
        self.assertEqual(params['Params']['ResponseContentType'], 'video/mp4')
        self.assertEqual(params['Params']['ResponseContentDisposition'], "attachment; filename*=UTF-8''%EC%9E%A5%EB%A9%B4%201.mp4")


class ManualMediaTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg/ffprobe required')
    def test_trim_nonzero_source_timestamps_with_and_without_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            for audio in (False, True):
                source = Path(directory) / f'source-{audio}.mp4'
                output = Path(directory) / f'output-{audio}.mp4'
                args = ['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=5']
                if audio:
                    args += ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=5']
                args += ['-c:v', 'libx264', '-threads', '1', '-g', '25']
                if audio:
                    args += ['-c:a', 'aac']
                args += ['-output_ts_offset', '100', str(source)]
                subprocess.run(args, check=True, capture_output=True)
                duration = publisher.render_manual_clip(source, output, 101, 2)
                self.assertAlmostEqual(duration, 2, delta=.25)
                result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=start_time',
                                         '-of', 'json', str(output)], check=True, capture_output=True, text=True)
                self.assertAlmostEqual(float(json.loads(result.stdout)['format']['start_time']), 0, delta=.05)


if __name__ == '__main__':
    unittest.main()
