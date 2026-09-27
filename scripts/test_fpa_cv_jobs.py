"""Queue safety, persistence and HTTP contract checks without model inference."""
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import subprocess
import sys
import time
import unittest
from unittest.mock import patch, Mock
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

from fpa_cv_jobs import JobError, TrackingJobs, options_for
from fpa_cv_serve import handler_for


class JobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = TrackingJobs(self.temp.name, probe=False, start_worker=False)
        self.manager.capability.update(checking=False, ready=True, gpu='mps', gpuLabel='Apple GPU · MPS')

    def tearDown(self):
        self.manager.close()
        self.temp.cleanup()

    def upload(self):
        return self.manager.receive_upload(BytesIO(b'video-content'), 13, '../../경기.mp4')

    def settings(self,upload_id,**overrides):
        from fpa_cv_initial import SLOTS
        job=self.manager.create_preparation(upload_id,{'time':5,'device':'cpu'})
        folder=self.manager.root/'jobs'/job['id']/'output';folder.mkdir()
        boxes=[{'id':i+1,'box':[.03+i*.07,.3,.06+i*.07,.4],'confidence':.8} for i in range(13)]
        snapshot={'time':5,'frameIndex':150,'fps':30,'duration':20,'width':1920,'height':1080,'boxes':boxes}
        (folder/'detections.json').write_text(json.dumps(snapshot))
        (folder/'frame.png').write_bytes(b'png')
        self.manager.jobs[job['id']]['status']='completed';self.manager._save(self.manager.jobs[job['id']])
        people=[{'id':pid,'group':group,'jersey':'REF' if group=='referee' else str(i+1),'detectionId':i+1} for i,(pid,group) in enumerate(SLOTS.items())]
        seed={'preparationId':job['id'],'roster':people,'uniforms':{g:[[100+i*20,150,170]] for i,g in enumerate(('home_gk','home','referee','away','away_gk'))}}
        return {'roi':[[0,0],[1,0],[1,1],[0,1]],'setup':seed,**overrides}

    def wait_for(self, predicate):
        deadline=time.monotonic()+5
        while not predicate() and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue(predicate())

    def start_lanes(self):
        self.manager.worker=threading.Thread(target=self.manager._work,daemon=True)
        self.manager.preparation_worker=threading.Thread(target=self.manager._work,args=('preparation',),daemon=True)
        self.manager.worker.start();self.manager.preparation_worker.start()

    def test_preparation_completes_during_tracking_without_deleting_shared_cache(self):
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        info,source=self.manager._upload(uploaded['id'])
        info['storage']='s3';(source.parent/'upload.json').write_text(json.dumps(info))
        first=self.manager.create(uploaded['id'],settings)
        second=self.manager.create(uploaded['id'],settings)
        prepared=self.manager.create_preparation(uploaded['id'],{'time':6})
        next_prepared=self.manager.create_preparation(uploaded['id'],{'time':7})
        release_tracking=threading.Event();release_preparation=threading.Event()
        started=[]
        def execute(job):
            with self.manager.lock:started.append(job['id'])
            if job['id']==first['id']:release_tracking.wait(5)
            if job['id']==prepared['id']:release_preparation.wait(5)
            with self.manager.lock:
                job['status']='completed';self.manager._save(job)
        with patch.object(self.manager,'_execute',side_effect=execute):
            try:
                self.start_lanes()
                self.wait_for(lambda: first['id'] in started and prepared['id'] in started)
                self.assertNotIn(second['id'],started)
                self.assertNotIn(next_prepared['id'],started)
                release_preparation.set()
                self.wait_for(lambda: next_prepared['id'] in started and not any(j in self.manager.active_ids for j in (prepared['id'],next_prepared['id'])))
                self.assertTrue(source.exists())
                self.assertIn(first['id'],self.manager.active_ids)
                self.assertNotIn(second['id'],started)
                release_tracking.set()
                self.wait_for(lambda: self.manager.get(second['id'])['status']=='completed' and not self.manager.active_ids)
                self.assertFalse(source.exists())
            finally:
                release_preparation.set();release_tracking.set();self.manager.close()

    def test_each_lane_cancels_only_its_own_process_and_close_stops_both(self):
        launch=subprocess.Popen
        def fake_tracker(*args,**kwargs):
            return launch([sys.executable,'-u','-c','import time; print(\'FPA_PROGRESS {"progress":10}\',flush=True); time.sleep(30)'],**kwargs)
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        with patch('fpa_cv_jobs.subprocess.Popen',side_effect=fake_tracker):
            self.start_lanes()
            tracking=self.manager.create(uploaded['id'],settings)
            prepared=self.manager.create_preparation(uploaded['id'],{'time':6})
            for job in (tracking,prepared):self.wait_for(lambda: self.manager.get(job['id'])['status']=='running')
            tracking_process=self.manager.processes[tracking['id']]
            preparation_process=self.manager.processes[prepared['id']]
            self.manager.cancel(prepared['id'])
            self.wait_for(lambda: self.manager.get(prepared['id'])['status']=='cancelled')
            self.assertIsNotNone(preparation_process.poll());self.assertIsNone(tracking_process.poll())
            other=self.manager.create_preparation(uploaded['id'],{'time':7})
            self.wait_for(lambda: self.manager.get(other['id'])['status']=='running')
            other_process=self.manager.processes[other['id']]
            self.manager.cancel(tracking['id'])
            self.wait_for(lambda: self.manager.get(tracking['id'])['status']=='cancelled')
            self.assertIsNone(other_process.poll())
            another=self.manager.create(uploaded['id'],settings)
            self.wait_for(lambda: self.manager.get(another['id'])['status']=='running')
            another_process=self.manager.processes[another['id']]
            self.manager.close()
            self.assertIsNotNone(other_process.poll());self.assertIsNotNone(another_process.poll())
            self.assertEqual(self.manager.get(other['id'])['status'],'interrupted')
            self.assertEqual(self.manager.get(another['id'])['status'],'interrupted')

    def test_preparation_failure_leaves_tracking_running(self):
        launch=subprocess.Popen
        def fake_tracker(command,**kwargs):
            code='raise RuntimeError("bad frame")' if any(arg.endswith('fpa_cv_prepare.py') for arg in command) else 'import time; print(\'FPA_PROGRESS {"progress":10}\',flush=True); time.sleep(30)'
            return launch([sys.executable,'-u','-c',code],**kwargs)
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        with patch('fpa_cv_jobs.subprocess.Popen',side_effect=fake_tracker):
            self.start_lanes()
            tracking=self.manager.create(uploaded['id'],settings)
            self.wait_for(lambda: self.manager.get(tracking['id'])['status']=='running')
            prepared=self.manager.create_preparation(uploaded['id'],{'time':6})
            self.wait_for(lambda: self.manager.get(prepared['id'])['status']=='failed')
            self.assertIsNone(self.manager.processes[tracking['id']].poll())
            self.assertEqual(self.manager.get(tracking['id'])['status'],'running')
            self.manager.close()

    def test_restart_restores_both_queues_and_interrupts_both_active_lanes(self):
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        tracking=self.manager.create(uploaded['id'],settings)
        prepared=self.manager.create_preparation(uploaded['id'],{'time':6})
        active_tracking=self.manager.create(uploaded['id'],settings)
        active_preparation=self.manager.create_preparation(uploaded['id'],{'time':7})
        for job in (active_tracking,active_preparation):
            stored=self.manager.jobs[job['id']];stored['status']='running';self.manager._save(stored)
        restarted=TrackingJobs(self.temp.name,probe=False,start_worker=False)
        try:
            self.assertEqual(list(restarted.queue),[tracking['id']])
            self.assertEqual(list(restarted.preparation_queue),[prepared['id']])
            for job in (active_tracking,active_preparation):self.assertEqual(restarted.get(job['id'])['status'],'interrupted')
            self.assertTrue(restarted.capabilities()['concurrentPreparation'])
        finally:restarted.close()

    def test_ready_jobs_wait_for_batch_start_and_survive_restart(self):
        upload=self.upload();settings=self.settings(upload['id'])
        job=self.manager.create(upload['id'],{**settings,'defer':True})
        self.assertEqual(job['status'],'ready');self.assertNotIn(job['id'],self.manager.queue)
        restarted=TrackingJobs(self.temp.name,probe=False,start_worker=False)
        try:self.assertEqual(restarted.get(job['id'])['status'],'ready')
        finally:restarted.close()
        with self.assertRaises(JobError):self.manager.start_batch([job['id'],'f'*32])
        self.assertEqual(self.manager.get(job['id'])['status'],'ready')
        result=self.manager.start_batch([job['id']])
        self.assertEqual(result['jobs'][0]['status'],'queued')
        self.manager.start_batch([job['id']])
        self.assertEqual(list(self.manager.queue).count(job['id']),1)

    def test_s3_archive_preserves_local_files_on_failure_and_persists_cleanup_keys(self):
        upload=self.upload();job=self.manager.create(upload['id'],self.settings(upload['id'],defer=True))
        job=self.manager.jobs[job['id']];output=self.manager.root/'jobs'/job['id']/'output';output.mkdir()
        for name in ('tracks.json','preview.mp4','initial-review.json'):(output/name).write_bytes(b'data')
        self.manager.storage=Mock();self.manager.storage.upload.side_effect=[None,RuntimeError('S3 failed')]
        with self.assertRaises(RuntimeError):self.manager._archive(job,{'storage':'s3'},output,['tracks.json','preview.mp4','initial-review.json'])
        self.assertTrue((output/'tracks.json').exists());self.assertTrue((output/'preview.mp4').exists())
        persisted=json.loads((output.parent/'job.json').read_text())
        self.assertEqual(len(persisted['s3Assets']),3)
        self.manager.storage.upload.side_effect=None
        self.manager._archive(job,{'storage':'s3'},output,['tracks.json','preview.mp4','initial-review.json'])
        self.assertFalse((output/'tracks.json').exists());self.assertFalse((output/'preview.mp4').exists())
        self.assertTrue((output/'initial-review.json').exists())

    def test_s3_registration_accepts_remote_source_without_local_copy(self):
        uid='c'*32;self.manager.storage=Mock();self.manager.storage.head.return_value={'ContentLength':13}
        info={'id':uid,'name':'game.mp4','file':'source.mp4','size':13,'key':f'fpa-cv/uploads/{uid}/source.mp4','storage':'s3'}
        self.manager.register_upload(info)
        _,path=self.manager._upload(uid);self.assertFalse(path.exists())
        with self.assertRaises(JobError):self.manager.register_upload({**info,'key':'fpa-cv/uploads/'+'d'*32+'/source.mp4'})
        self.manager.remove_upload(uid)
        with self.assertRaises(JobError):self.manager._upload(uid)

    def test_s3_preparation_skips_full_source_download(self):
        uid='d'*32;self.manager.storage=Mock();self.manager.storage.head.return_value={'ContentLength':13}
        key=f'fpa-cv/uploads/{uid}/source.mp4'
        self.manager.register_upload({'id':uid,'name':'game.mp4','file':'source.mp4','size':13,'key':key,'storage':'s3'})
        prepared=self.manager.create_preparation(uid,{'time':5,'device':'cpu'})
        from io import StringIO
        process=Mock();process.stdout=StringIO('intentional test stop\n');process.wait.return_value=1
        with patch('fpa_cv_jobs.subprocess.Popen',return_value=process) as popen:
            self.manager._execute(self.manager.jobs[prepared['id']])
            command=popen.call_args.args[0]
            self.assertEqual(command[command.index('--s3-key')+1],key)
        self.manager.storage.download.assert_not_called()

    def test_upload_is_local_and_truncated_upload_is_discarded(self):
        uploaded = self.upload()
        self.assertEqual(uploaded['name'], '경기.mp4')
        info, path = self.manager._upload(uploaded['id'])
        self.assertEqual(path.read_bytes(), b'video-content')
        self.assertEqual(path.parent.parent, Path(self.temp.name).resolve()/'uploads')
        with self.assertRaises(JobError):
            self.manager.receive_upload(BytesIO(b'cut'), 10, 'cut.mp4')
        self.assertEqual(len(list((Path(self.temp.name).resolve()/'uploads').iterdir())), 1)
        with self.assertRaises(JobError):
            self.manager.receive_upload(BytesIO(b'x'), 1, 'script.py')
        with self.assertRaises(JobError):
            self.manager._upload('../elsewhere')

    def test_settings_reject_invalid_ranges_and_crossed_court(self):
        roi = [[.1,.1],[.9,.1],[.9,.9],[.1,.9]]
        self.assertEqual(options_for({'roi':roi})['roi'], roi)
        for value in [{'start':-1}, {'duration':float('nan')}, {'start':True}, {'device':'auto'}, {'roi':[[0,0],[1,1],[0,1],[1,0]]}, {'roi':[[0,0],[0,0],[1,1],[0,1]]}]:
            with self.subTest(value=value), self.assertRaises(JobError):
                options_for(value)

    def test_gpu_does_not_silently_fall_back(self):
        uploaded = self.upload()
        settings=self.settings(uploaded['id'])
        self.manager.capability.update(gpu=None, gpuLabel=None)
        with self.assertRaises(JobError) as failure:
            self.manager.create(uploaded['id'], settings)
        self.assertEqual(failure.exception.status, 409)
        job = self.manager.create(uploaded['id'], {**settings,'device':'cpu'})
        self.assertEqual(job['device'], 'cpu')
        self.assertNotIn('result', job)
        with self.assertRaises(JobError):
            self.manager.asset(job['id'], 'preview.mp4')

    def test_cancel_retry_and_restart_keep_distinct_results(self):
        uploaded=self.upload()
        original = self.manager.create(uploaded['id'], self.settings(uploaded['id'],start=5,duration=10))
        with self.assertRaises(JobError):
            self.manager.retry(original['id'])
        self.assertEqual(self.manager.cancel(original['id'])['status'], 'cancelled')
        retried = self.manager.retry(original['id'])
        self.assertNotEqual(original['id'], retried['id'])
        self.assertEqual(original['uploadId'], retried['uploadId'])
        self.assertEqual(retried['options']['start'], 5)
        restarted = TrackingJobs(self.temp.name, probe=False, start_worker=False)
        try:
            self.assertEqual(restarted.get(original['id'])['status'], 'cancelled')
            self.assertEqual(restarted.get(retried['id'])['status'], 'queued')
            self.assertIn(retried['id'],restarted.queue)
        finally:
            restarted.close()

    def test_delete_restore_preserves_shared_upload_results_and_restart_state(self):
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        first=self.manager.create(uploaded['id'],settings)
        second=self.manager.create(uploaded['id'],settings)
        output=self.manager.root/'jobs'/first['id']/'output';output.mkdir()
        (output/'preview.mp4').write_bytes(b'keep-preview')
        (output/'initial-review.json').write_text('{"saved":true}')
        self.manager.jobs[first['id']]['status']='completed'
        deleted=self.manager.delete(first['id'])
        self.assertEqual(self.manager.delete(first['id'])['deletedAt'],deleted['deletedAt'])
        self.assertEqual([j['id'] for j in self.manager.listing()],[second['id']])
        self.assertEqual([j['id'] for j in self.manager.listing(deleted=True)],[first['id']])
        self.assertEqual(self.manager.asset(first['id'],'preview.mp4')[0].read_bytes(),b'keep-preview')
        self.assertTrue(self.manager._upload(uploaded['id'])[1].is_file())
        restarted=TrackingJobs(self.temp.name,probe=False,start_worker=False)
        try:
            self.assertEqual(restarted.listing(deleted=True)[0]['id'],first['id'])
            restored=restarted.restore(first['id'])
            self.assertNotIn('deletedAt',restored)
            self.assertEqual(restored['status'],'completed')
            self.assertEqual(restarted.listing(deleted=True),[])
            self.assertEqual((output/'initial-review.json').read_text(),'{"saved":true}')
        finally:restarted.close()

    def test_queued_delete_cancels_and_restore_does_not_restart_automatically(self):
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        job=self.manager.create(uploaded['id'],settings)
        self.assertEqual(self.manager.delete(job['id'])['status'],'cancelled')
        with self.assertRaises(JobError):self.manager.retry(job['id'])
        with self.assertRaises(JobError):self.manager.delete(settings['setup']['preparationId'])
        self.assertEqual(self.manager.restore(job['id'])['status'],'cancelled')
        self.assertEqual(self.manager.processes,{})
        self.assertNotEqual(self.manager.retry(job['id'])['id'],job['id'])

    def test_purge_requires_trash_and_keeps_shared_source_until_last_run(self):
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        first=self.manager.create(uploaded['id'],settings)
        second=self.manager.create(uploaded['id'],settings)
        with self.assertRaises(JobError):self.manager.purge(first['id'])
        self.manager.delete(first['id'])
        result=self.manager.purge(first['id'])
        self.assertNotIn(first['id'],self.manager.queue)
        self.assertFalse(result['sourceDeleted'])
        self.assertTrue(self.manager._upload(uploaded['id'])[1].exists())
        with self.assertRaises(JobError):self.manager.get(first['id'])
        self.manager.delete(second['id'])
        self.assertTrue(self.manager.purge(second['id'])['sourceDeleted'])
        self.assertFalse((self.manager.root/'uploads'/uploaded['id']).exists())
        self.assertFalse((self.manager.root/'jobs'/settings['setup']['preparationId']).exists())
        restarted=TrackingJobs(self.temp.name,probe=False,start_worker=False)
        try:self.assertEqual(restarted.listing(deleted=True),[])
        finally:restarted.close()

    def test_purge_refuses_a_worker_that_has_not_exited(self):
        uploaded=self.upload();job=self.manager.create(uploaded['id'],self.settings(uploaded['id']))
        self.manager.delete(job['id']);self.manager.active_ids.add(job['id'])
        with self.assertRaises(JobError):self.manager.purge(job['id'])
        self.assertTrue((self.manager.root/'jobs'/job['id']).is_dir())

    def test_existing_result_list_deletion_is_persistent_and_dataset_scoped(self):
        legacy={'id':'existing','datasetId':'legacy-one','status':'completed'}
        self.manager.legacy_state(legacy,True)
        self.assertNotIn('deletedAt',self.manager.legacy_state({**legacy,'datasetId':'legacy-two'}))
        restarted=TrackingJobs(self.temp.name,probe=False,start_worker=False)
        try:
            self.assertIn('deletedAt',restarted.legacy_state(legacy))
            self.assertNotIn('deletedAt',restarted.legacy_state(legacy,False))
        finally:restarted.close()

    def test_running_delete_stops_process_and_keeps_item_in_trash(self):
        launch=subprocess.Popen
        def fake_tracker(*args,**kwargs):
            return launch([sys.executable,'-u','-c','import time; print(\'FPA_PROGRESS {"progress":10}\',flush=True); time.sleep(30)'],**kwargs)
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        with patch('fpa_cv_jobs.subprocess.Popen',side_effect=fake_tracker):
            self.manager.worker=threading.Thread(target=self.manager._work,daemon=True);self.manager.worker.start()
            job=self.manager.create(uploaded['id'],settings)
            deadline=time.monotonic()+5
            while self.manager.get(job['id'])['status']!='running' and time.monotonic()<deadline:time.sleep(.01)
            self.assertEqual(self.manager.get(job['id'])['status'],'running')
            process=self.manager.processes[job['id']]
            self.assertEqual(self.manager.delete(job['id'])['status'],'cancelling')
            while self.manager.get(job['id'])['status']=='cancelling' and time.monotonic()<deadline:time.sleep(.01)
            self.assertEqual(self.manager.get(job['id'])['status'],'cancelled')
            self.assertIsNotNone(process.poll())
            self.assertEqual(self.manager.listing(),[])
            self.assertEqual(self.manager.listing(deleted=True)[0]['id'],job['id'])

    def test_running_cancel_terminates_worker_without_publishing_output(self):
        launch = subprocess.Popen
        def fake_tracker(*args, **kwargs):
            return launch([sys.executable, '-u', '-c', 'import time; print(\'FPA_PROGRESS {"stage":"test","progress":10}\',flush=True); time.sleep(30)'], **kwargs)
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        with patch('fpa_cv_jobs.subprocess.Popen', side_effect=fake_tracker):
            self.manager.worker = threading.Thread(target=self.manager._work, daemon=True)
            self.manager.worker.start()
            job = self.manager.create(uploaded['id'], settings)
            deadline = time.monotonic()+5
            while self.manager.get(job['id'])['status'] != 'running' and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertEqual(self.manager.get(job['id'])['status'], 'running')
            process = self.manager.processes[job['id']]
            self.manager.cancel(job['id'])
            while self.manager.get(job['id'])['status'] == 'cancelling' and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertEqual(self.manager.get(job['id'])['status'], 'cancelled')
            self.assertIsNotNone(process.poll())
            with self.assertRaises(JobError):
                self.manager.asset(job['id'], 'tracks.json')

    def test_frame_progress_survives_queue_and_clears_eta_when_saving(self):
        from fpa_cv_track import frame_progress
        launch=subprocess.Popen
        gate=self.manager.root/'save-now'
        tracing={'stage':'선수 추적 중','progress':20,**frame_progress(150,900,20)}
        saving={'stage':'결과 저장 중','progress':98,**frame_progress(900,900,120),'eta':None}
        code=(f'import time\nfrom pathlib import Path\nprint({("FPA_PROGRESS "+json.dumps(tracing))!r},flush=True)\n'
              f'while not Path({str(gate)!r}).exists(): time.sleep(.01)\n'
              f'print({("FPA_PROGRESS "+json.dumps(saving))!r},flush=True)\ntime.sleep(30)')
        def fake_tracker(*args,**kwargs):return launch([sys.executable,'-u','-c',code],**kwargs)
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        with patch('fpa_cv_jobs.subprocess.Popen',side_effect=fake_tracker):
            self.manager.worker=threading.Thread(target=self.manager._work,daemon=True);self.manager.worker.start()
            job=self.manager.create(uploaded['id'],settings)
            for expected in (tracing,saving):
                deadline=time.monotonic()+5
                while self.manager.get(job['id'])['stage']!=expected['stage'] and time.monotonic()<deadline:time.sleep(.01)
                current=self.manager.get(job['id'])
                persisted=json.loads((self.manager.root/'jobs'/job['id']/'job.json').read_text())
                for key,value in expected.items():
                    self.assertEqual(current[key],value)
                    self.assertEqual(persisted[key],value)
                gate.touch()
            self.manager.cancel(job['id'])

    def test_setup_is_required_and_must_belong_to_same_video(self):
        uploaded=self.upload();other=self.upload()
        with self.assertRaises(JobError):self.manager.create(uploaded['id'],{})
        settings=self.settings(uploaded['id'])
        with self.assertRaises(JobError):self.manager.create(other['id'],settings)
        with self.assertRaises(JobError):self.manager.create(uploaded['id'],{**settings,'start':6})
        settings['setup']['roster'][1]['detectionId']=1
        with self.assertRaises(JobError):self.manager.create(uploaded['id'],settings)

    def test_analysis_starts_at_initial_frame_and_preserves_requested_end(self):
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        # An older client may request the entire source from zero.
        full=self.manager.create(uploaded['id'],settings)
        self.assertEqual(full['options']['start'],5)
        self.assertEqual(full['options']['duration'],0)
        partial=self.manager.create(uploaded['id'],{**settings,'start':2,'duration':10})
        self.assertEqual(partial['options']['start'],5)
        self.assertEqual(partial['options']['duration'],7)
        with self.assertRaises(JobError):
            self.manager.create(uploaded['id'],{**settings,'start':0,'duration':5})

    def test_fractional_initial_frame_is_not_rounded_to_display_milliseconds(self):
        uploaded=self.upload();settings=self.settings(uploaded['id'])
        path=self.manager.root/'jobs'/settings['setup']['preparationId']/'output/detections.json'
        snapshot=json.loads(path.read_text())
        snapshot.update(time=258/(30000/1001),frameIndex=258,fps=30000/1001)
        path.write_text(json.dumps(snapshot))
        job=self.manager.create(uploaded['id'],{**settings,'duration':12})
        self.assertEqual(job['options']['start'],snapshot['time'])
        self.assertEqual(job['options']['start']+job['options']['duration'],12)

    def test_http_upload_job_and_completed_video_ranges(self):
        legacy=self.manager.root/'legacy';legacy.mkdir()
        (legacy/'tracks.json').write_text(json.dumps({'datasetId':'legacy','video':{'name':'legacy.mp4'},'tracks':[],'frames':[]}))
        server = ThreadingHTTPServer(('127.0.0.1',0), handler_for(legacy,self.manager))
        server_thread = threading.Thread(target=server.serve_forever,daemon=True)
        server_thread.start()
        conn = HTTPConnection(*server.server_address,timeout=3)
        def request(method,path,body=None,headers=None):
            conn.request(method,path,body=body,headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        try:
            status,_,body = request('POST','/api/tracking/uploads?name=clip.mp4',b'video-content',{'Origin':'https://unrelated.example'})
            self.assertEqual(status,403)
            status,_,body = request('POST','/api/tracking/uploads?name=clip.mp4',b'video-content')
            self.assertEqual(status,201)
            upload = json.loads(body)
            status,_,body = request('POST','/api/tracking/jobs',json.dumps({'uploadId':upload['id'],'device':'gpu',**self.settings(upload['id'])}))
            self.assertEqual(status,202)
            job = json.loads(body)
            self.assertEqual(request('GET',f"/api/tracking/jobs/{job['id']}/preview.mp4")[0],409)
            self.assertEqual(request('POST','/api/tracking/jobs','[]')[0],400)
            output = self.manager.root/'jobs'/job['id']/'output'
            output.mkdir()
            (output/'preview.mp4').write_bytes(b'0123456789')
            with self.manager.lock:
                self.manager.jobs[job['id']]['status'] = 'completed'
            status,headers,body = request('GET',f"/api/tracking/jobs/{job['id']}/preview.mp4",headers={'Range':'bytes=2-5'})
            self.assertEqual((status,headers['Content-Range'],body),(206,'bytes 2-5/10',b'2345'))
            status,_,body = request('GET','/api/tracking/jobs')
            self.assertIn('result',json.loads(body)['jobs'][0])
            for jid in (job['id'],'existing'):
                self.assertEqual(request('POST',f'/api/tracking/jobs/{jid}/delete',headers={'Origin':'https://unrelated.example'})[0],403)
                self.assertEqual(request('POST',f'/api/tracking/jobs/{jid}/delete')[0],200)
                listing=json.loads(request('GET','/api/tracking/jobs')[2])
                self.assertNotIn(jid,[j['id'] for j in listing['jobs']])
                self.assertIn(jid,[j['id'] for j in listing['deleted']])
                self.assertEqual(request('GET',f'/api/tracking/jobs/{jid}')[0],200)
                self.assertEqual(request('POST',f'/api/tracking/jobs/{jid}/restore')[0],200)
                self.assertIn(jid,[j['id'] for j in json.loads(request('GET','/api/tracking/jobs')[2])['jobs']])
        finally:
            conn.close()
            server.shutdown()
            server.server_close()
            server_thread.join(3)


if __name__ == '__main__':
    unittest.main()
