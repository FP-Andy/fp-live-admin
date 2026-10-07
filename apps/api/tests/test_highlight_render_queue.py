"""FIFO, duplicate requests, recovery and real API log contracts; isolated DB."""
import json
import asyncio
import os
import shutil
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_match_write_access as fixture
from app import highlight_jobs as jobs
from app.highlight_render_queue import HighlightRenderTask, enqueue, exclusive_worker
from app.highlight_render_worker import HighlightRenderWorker, RenderInterrupted
from app.models import HighlightJob
from app.highlight_process import ffmpeg_args


class RenderQueueTests(fixture.MatchWriteAccess):
    # Keep fixture setup/auth without inheriting the unrelated match test suite.
    def setUp(self):
        super().setUp()
        self.mutex = threading.Lock()
        self.client = self.clients['admin']

    @contextmanager
    def local_lock(self):
        got = self.mutex.acquire(blocking=False)
        try:
            yield object() if got else None
        finally:
            if got:
                self.mutex.release()

    def new_job(self, name=None):
        response = self.client.post('/api/highlight/manual-jobs', json={'source_filename': name or 'fixture.mp4', 'sport':'FOOTBALL'})
        self.assertEqual(response.status_code, 200, response.text)
        job_id = response.json()['job_id']
        response = self.client.post(f'/api/highlight/manual-jobs/{job_id}/clips',
            files={'clip': ('clip.mp4', b'synthetic clip; renderer mocked', 'video/mp4')},
            data={'index':'1', 'requested_start':'1', 'requested_end':'3', 'kind':'substitution'})
        self.assertEqual(response.status_code, 200, response.text)
        return job_id

    def submit(self, job_id, body=None):
        response = self.client.post(f'/api/highlight/manual-jobs/{job_id}/merge', json=body or {})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def finish(self, queue_id, connection):
        with fixture.SessionLocal() as db:
            job = db.get(HighlightJob, db.get(HighlightRenderTask, queue_id).job_id)
            job.status = 'done'
            db.commit()

    def worker(self, render=None, lock=None):
        return HighlightRenderWorker(fixture.SessionLocal, fixture.engine,
            lock=lock or self.local_lock, render=render or self.finish)

    def test_manual_fifo_duplicate_options_and_asset_freeze(self):
        a,b,c = [self.new_job() for _ in range(3)]
        for i, jid in enumerate([a,b,c]):
            self.assertEqual(self.submit(jid, {'clip_xfade_sec':.2})['render_queue']['position'], i+1)
        repeat = self.submit(a, {'clip_xfade_sec':1.5})
        self.assertEqual(repeat['render_queue']['position'],1)
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(HighlightRenderTask).count(),3)
            self.assertEqual(db.get(HighlightJob,a).job_metadata['clip_xfade_sec'],.2)
        self.assertEqual(self.client.delete(f'/api/highlight/jobs/{a}').status_code,409)
        self.assertEqual(self.client.post(f'/api/highlight/manual-jobs/{a}/clips',
            files={'clip':('clip.mp4',b'changed','video/mp4')},
            data={'index':'1','requested_start':'1','requested_end':'3'}).status_code,409)
        calls=[]
        def render(qid, conn):
            with fixture.SessionLocal() as db: calls.append(db.get(HighlightRenderTask,qid).job_id)
            self.finish(qid,conn)
        worker=self.worker(render)
        while worker.run_one(): pass
        self.assertEqual(calls,[a,b,c])

    def test_busy_worker_only_claims_one(self):
        a,b=self.new_job(),self.new_job();self.submit(a);self.submit(b)
        started,release=threading.Event(),threading.Event()
        def slow(qid,conn): started.set();release.wait(5);self.finish(qid,conn)
        thread=threading.Thread(target=self.worker(slow).run_one);thread.start()
        try:
            self.assertTrue(started.wait(3))
            self.assertFalse(self.worker().run_one())
            self.assertEqual(self.submit(a)['render_queue']['status'],'running')
        finally: release.set();thread.join(5)
        self.assertTrue(self.worker().run_one())

    def test_manual_fineplay_and_source_produce_share_one_fifo(self):
        manual=self.new_job();self.submit(manual)
        with fixture.SessionLocal() as db:
            db.add(HighlightJob(id='fixture-fineplay',mode='fineplay',status='tagging',job_metadata={}))
            db.add(HighlightJob(id='fixture-operator',mode='operator',status='clips_ready',job_metadata={'clips':['clip.mp4']}))
            db.commit()
        fine=self.client.post('/api/highlight/fineplay-jobs/fixture-fineplay/produce',json={'clips':[{'start':1,'end':2}]})
        self.assertEqual(fine.status_code,200,fine.text)
        self.assertEqual(fine.json()['render_queue']['position'],2)
        duplicate=self.client.post('/api/highlight/fineplay-jobs/fixture-fineplay/produce',json={'clips':[{'start':10,'end':20}]})
        self.assertEqual(duplicate.json()['render_queue']['queue_id'],fine.json()['render_queue']['queue_id'])
        source=self.client.post('/api/highlight/produce-jobs',json={'source_key':'fixture/source.mp4','segments':[{'start':1,'end':2}]})
        self.assertEqual(source.status_code,200,source.text)
        self.assertEqual(source.json()['render_queue']['position'],3)
        operator=self.client.post('/api/highlight/operator-jobs/fixture-operator/merge')
        self.assertEqual(operator.status_code,200,operator.text)
        self.assertEqual(operator.json()['render_queue']['position'],4)
        with fixture.SessionLocal() as db:
            self.assertEqual(db.get(HighlightJob,'fixture-fineplay').job_metadata['clips'][0]['start'],1)
            self.assertEqual([r.kind for r in db.query(HighlightRenderTask).order_by(HighlightRenderTask.id)],['manual','fineplay','produce_s3','operator'])

    def test_failed_render_does_not_block_and_can_be_requeued(self):
        a,b=self.new_job(),self.new_job();self.submit(a);self.submit(b)
        def fail(*args): raise RuntimeError('synthetic render failure')
        with self.assertLogs('app.highlight_render_worker',level='ERROR'): self.worker(fail).run_one()
        self.assertTrue(self.worker().run_one())
        with fixture.SessionLocal() as db:
            self.assertEqual(db.get(HighlightJob,a).status,'error')
            self.assertEqual(db.get(HighlightJob,b).status,'done')
        self.submit(a);self.worker().run_one()
        with fixture.SessionLocal() as db: self.assertEqual(db.get(HighlightJob,a).status,'done')

    def test_selected_clip_export_also_queues_and_freezes_sources(self):
        a=self.new_job()
        with fixture.SessionLocal() as db:
            job=db.get(HighlightJob,a);job.status='done';db.commit()
        route=f'/api/highlight/jobs/{a}/export'
        body={'selected':['clip_001.mp4'],'order':['clip_001.mp4']}
        first=self.client.post(route,json=body)
        self.assertEqual(first.status_code,200,first.text)
        self.assertFalse(first.json()['export_ready'])
        self.assertEqual(self.client.post(route,json=body).json()['render_queue']['queue_id'],first.json()['render_queue']['queue_id'])
        self.assertEqual(self.client.delete(f'/api/highlight/jobs/{a}/clips/clip_001.mp4').status_code,409)
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(HighlightRenderTask).one().kind,'export')
            self.assertEqual(db.get(HighlightJob,a).job_metadata['export_selection'],['clip_001.mp4'])

    def test_interrupted_render_recovers_once_before_waiting(self):
        a,b=self.new_job(),self.new_job();self.submit(a);self.submit(b)
        def interrupt(*args): raise RenderInterrupted()
        self.assertFalse(self.worker(interrupt).run_one())
        with fixture.SessionLocal() as db:
            self.assertEqual(db.query(HighlightRenderTask).order_by(HighlightRenderTask.id).first().status,'running')
        self.worker().run_one()
        with fixture.SessionLocal() as db:
            self.assertEqual(db.get(HighlightJob,a).status,'done')
            self.assertEqual(db.get(HighlightJob,b).status,'render_queued')

    def test_shutdown_and_completed_claim_do_not_rerender(self):
        a=self.new_job();self.submit(a)
        worker=self.worker();worker.stop.set();self.assertFalse(worker.run_one())
        with fixture.SessionLocal() as db:
            db.query(HighlightRenderTask).one().status='running'
            db.get(HighlightJob,a).status='done';db.commit()
        self.worker(lambda *_: self.fail('completed work rendered again')).run_one()

    def test_log_available_before_merge_and_survives_failure(self):
        a=self.new_job()
        payload={'format':'fpc-highlight-log','version':1,'sport':'FOOTBALL',
            'sources':[{'name':'fixture.mp4','size':100,'duration':10,'fingerprint':'fixture'}],
            'work':{'tags':[{'id':'sub','t':2,'kind':'substitution'}],'padBefore':1,'padAfter':1},'attachments':{}}
        url=f'/api/highlight/manual-jobs/{a}/log'
        response=self.client.put(url,files={'file':('log.json',json.dumps(payload),'application/json')})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.client.get(url).json(),payload)
        self.assertEqual(self.clients['anonymous'].get(url).status_code,401)
        self.assertEqual(self.clients['owner'].get(url).status_code,403)
        self.assertEqual(jobs.list_manual_clip_info(a)[0]['kind'],'substitution')
        bad={**payload,'work':{**payload['work'],'tags':[{'id':'bad','t':99}]}}
        self.assertEqual(self.client.put(url,files={'file':('bad.json',json.dumps(bad),'application/json')}).status_code,400)
        self.assertEqual(self.client.get(url).json(),payload)
        self.submit(a)
        self.assertEqual(self.client.put(url,files={'file':('log.json',json.dumps(payload),'application/json')}).status_code,409)
        def fail(*args): raise RuntimeError('synthetic')
        with self.assertLogs('app.highlight_render_worker',level='ERROR'): self.worker(fail).run_one()
        self.assertEqual(self.client.get(url).json(),payload)

    def test_codec_limits_keep_filter_and_quality(self):
        args=['ffmpeg','-y','-i','a.mp4','-i','board.png','-filter_complex','overlay=10:20',
              '-c:v','libx264','-crf','20','-preset','medium','out.mp4']
        bounded=ffmpeg_args(args)
        self.assertEqual(bounded.count('-threads'),2)
        self.assertEqual(bounded[bounded.index('-crf')+1],'20')
        self.assertEqual(bounded[bounded.index('-filter_complex')+1],'overlay=10:20')
        self.assertEqual(bounded[-3:],['-threads:v','2','out.mp4'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'requires media tools')
    def test_real_worker_subprocess_creates_valid_video(self):
        a=self.new_job()
        with fixture.SessionLocal() as db:
            job=db.get(HighlightJob,a)
            # Futsal has no external clip publication; all media stays in the fixture.
            job.job_metadata={**job.job_metadata,'sport':'FUTSAL','cards':{'enabled':False}}
            db.commit()
        source=jobs.clips_dir(a)/'clip_001.mp4'
        subprocess.run(['ffmpeg','-y','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=25:d=4',
                        '-c:v','libx264','-threads','1','-pix_fmt','yuv420p',str(source)],check=True)
        self.submit(a)
        @contextmanager
        def lock():
            with fixture.engine.connect() as conn:
                yield conn
        with patch.dict(os.environ,{'PYTHONPATH':str(Path(__file__).resolve().parents[1])+os.pathsep+os.environ.get('PYTHONPATH','')}):
            worker=HighlightRenderWorker(fixture.SessionLocal,fixture.engine,lock=lock)
            self.assertTrue(worker.run_one())
        with fixture.SessionLocal() as db:
            job=db.get(HighlightJob,a)
            self.assertEqual(job.status,'done',job.error_message)
            self.assertEqual(db.query(HighlightRenderTask).one().status,'completed')
            output=job.export_path
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',output]))
        self.assertAlmostEqual(float(probe['format']['duration']),2,delta=.12)
        self.assertEqual(probe['streams'][0]['codec_name'],'h264')
        self.assertEqual(probe['streams'][0]['pix_fmt'],'yuv420p')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'requires media tools')
    def test_native_merge_preserves_timing_with_stills_scoreboard_audio_and_fades(self):
        from PIL import Image
        from types import SimpleNamespace
        a = self.new_job()
        response = self.client.post(f'/api/highlight/manual-jobs/{a}/clips',
            files={'clip':('clip.mp4',b'synthetic','video/mp4')},
            data={'index':'2','requested_start':'1','requested_end':'3','kind':'home_goal'})
        self.assertEqual(response.status_code,200,response.text)
        folder = jobs.clips_dir(a)
        for index, color in [(1,'red'),(2,'blue')]:
            args = ['ffmpeg','-y','-v','error','-f','lavfi','-i',f'color={color}:s=512x288:r=25:d=4']
            if index == 2: args += ['-f','lavfi','-i','sine=frequency=440:duration=4']
            subprocess.run([*args,'-c:v','libx264','-threads','1','-pix_fmt','yuv420p',
                str(folder/f'clip_{index:03d}.mp4')],check=True)
        Image.new('RGB',(512,288),'green').save(folder/'intro.png')
        template = SimpleNamespace(fields=lambda _:[], has_board=False, first_half_video='',
            first_half_image='',second_half_video='',second_half_image='',outro_video='outro.mp4')
        with fixture.SessionLocal() as db:
            job = db.get(HighlightJob,a)
            job.job_metadata = {**job.job_metadata,'sport':'FUTSAL','intro_image':'intro.png','intro_duration':1.8,
                'clip_xfade_sec':.2,'scoreboard':{'enabled':True,'home_name':'HOME','away_name':'AWAY'},
                'cards':{'enabled':True,'outro':{'enabled':True}}}
            db.commit()
        with patch.object(jobs.card_store,'resolve',return_value=template), \
             patch.object(jobs,'template_asset',return_value=folder/'clip_001.mp4'):
            jobs.merge_manual_clips_for_job(a)
        with fixture.SessionLocal() as db:
            job = db.get(HighlightJob,a)
            self.assertEqual(job.status,'done',job.error_message)
            output = job.export_path
        probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',output]))
        # Intro (1.8), two clips (2+2), outro (4); overlap at three boundaries.
        expected = 9.8 - 2*min(jobs.CARD_FADE_SEC,.6) - .2
        self.assertAlmostEqual(float(probe['format']['duration']),expected,delta=.25)
        video = next(s for s in probe['streams'] if s['codec_type']=='video')
        audio = next(s for s in probe['streams'] if s['codec_type']=='audio')
        self.assertEqual((video['width'],video['height'],video['pix_fmt']),(512,288,'yuv420p'))
        self.assertEqual(audio['codec_name'],'aac')
        self.assertAlmostEqual(float(audio['duration']),float(video['duration']),delta=.15)

    @unittest.skipUnless(fixture.QA_DATABASE,'requires isolated PostgreSQL')
    def test_actual_postgres_simultaneous_submit_and_worker_locks(self):
        from concurrent.futures import ThreadPoolExecutor
        a=self.new_job()
        def submit(_):
            with fixture.SessionLocal() as db: return enqueue(db,a,'manual')['queue_id']
        with ThreadPoolExecutor(max_workers=6) as pool: ids=list(pool.map(submit,range(12)))
        self.assertEqual(len(set(ids)),1)
        with exclusive_worker(fixture.engine) as first:
            self.assertIsNotNone(first)
            with exclusive_worker(fixture.engine) as second: self.assertIsNone(second)
        self.assertTrue(self.worker(lock=lambda:exclusive_worker(fixture.engine)).run_one())

    @unittest.skipUnless(fixture.QA_DATABASE, 'requires isolated PostgreSQL row locks')
    def test_concurrent_asset_uploads_do_not_block_api_event_loop(self):
        """One event loop, real row contention and slow I/O: the production deadlock.

        A DB timeout bounds the old bug even when asyncio's own timers cannot run.
        Separate TestClients would hide it by giving requests separate event loops.
        """
        import httpx
        from sqlalchemy import text
        from app import highlight_render_queue as queue
        real_copy, real_lock = shutil.copyfileobj, queue.lock_job
        for kind in ('clips', 'intro', 'music', 'log'):
            with self.subTest(kind=kind):
                job_id = self.new_job()
                entered, release = threading.Event(), threading.Event()
                def slow_copy(source, target, *args):
                    entered.set()
                    if not release.wait(5):
                        raise RuntimeError('test file copy timed out')
                    return real_copy(source, target, *args)
                def bounded_lock(db, jid):
                    db.execute(text("SET LOCAL lock_timeout = '1800ms'"))
                    return real_lock(db, jid)
                payload = {'format':'fpc-highlight-log','version':1,'sport':'FOOTBALL',
                    'sources':[{'name':'fixture.mp4','size':100,'duration':10,'fingerprint':'fixture'}],
                    'work':{'tags':[{'id':'tag','t':2,'kind':'substitution'}],'padBefore':1,'padAfter':1},'attachments':{}}
                clip_args = {'files':{'clip':('clip.mp4',b'synthetic','video/mp4')},
                             'data':{'index':'2','requested_start':'1','requested_end':'3'}}
                other_args = {
                    'clips': {**clip_args, 'data':{**clip_args['data'],'index':'3'}},
                    'intro': {'files':{'image':('intro.png',b'synthetic','image/png')}},
                    'music': {'files':{'audio':('music.mp3',b'synthetic','audio/mpeg')}},
                    'log': {'files':{'file':('log.json',json.dumps(payload),'application/json')}},
                }[kind]
                async def run_requests():
                    transport = httpx.ASGITransport(app=fixture.main.app, raise_app_exceptions=False)
                    async with httpx.AsyncClient(transport=transport,base_url='http://testserver',
                                                cookies=self.client.cookies) as client:
                        first = asyncio.create_task(client.post(f'/api/highlight/manual-jobs/{job_id}/clips',**clip_args))
                        for _ in range(100):
                            if entered.is_set(): break
                            await asyncio.sleep(.01)
                        self.assertTrue(entered.is_set())
                        timer = threading.Timer(.6, release.set)
                        timer.start()
                        try:
                            start = time.monotonic()
                            second = asyncio.create_task(client.request('PUT' if kind=='log' else 'POST',
                                f'/api/highlight/manual-jobs/{job_id}/{kind}',**other_args))
                            await asyncio.sleep(.05)
                            health = await client.get('/health')
                            latency = time.monotonic()-start
                            responses = await asyncio.gather(first,second)
                            self.assertEqual(health.status_code,200)
                            self.assertLess(latency,.5, f'API blocked for {latency:.3f}s')
                            for response in responses:
                                self.assertEqual(response.status_code,200,response.text)
                        finally:
                            release.set()
                            timer.join()
                with patch.object(shutil,'copyfileobj',slow_copy), patch.object(queue,'lock_job',bounded_lock):
                    asyncio.run(run_requests())


if __name__=='__main__':
    # The fixture supplies setup/auth only, not its inherited tests.
    names=[name for name in RenderQueueTests.__dict__ if name.startswith('test_')]
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(RenderQueueTests(name) for name in names))
    sys.exit(not result.wasSuccessful())
