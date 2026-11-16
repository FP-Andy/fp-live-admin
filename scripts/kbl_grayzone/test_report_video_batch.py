import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import report_video_batch as batch


class VideoBatchContinuityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        batch.ACTIVE.clear();self.addCleanup(batch.ACTIVE.clear)
        self.scenes={'review-1':'scene-1','review-2':'scene-2'}
        self.report_fingerprint='report-before'
        delivery={'state':'ready-for-download'}
        self.report_result={'reportId':'a'*24,'pdf':'/report.pdf','delivery':delivery}
        self.video_result={'delivery':delivery}
        self.current={'revision':1,'events':[{'id':'review-1'},{'id':'review-2'}]}
        self.patches=[patch.object(batch,'ROOT',Path(self.temp.name)),patch.object(batch.POOL,'submit'),
          patch.object(batch.review_flow,'require_report',return_value=self.current),
          patch.object(batch,'readiness',return_value={'events':[{'eventId':'review-1','ready':True},{'eventId':'review-2','ready':True}]}),
          patch.object(batch.report_jobs,'stamp',side_effect=lambda case:self.report_fingerprint),
          patch.object(batch,'video_stamp',side_effect=lambda case,event:self.scenes[event]),
          patch.object(batch.report_jobs,'submit',return_value={'job':{'jobId':'b'*24}}),
          patch.object(batch.report_jobs,'status',return_value={'state':'complete','result':self.report_result}),
          patch.object(batch.video_jobs,'submit',side_effect=lambda case,event:{'job':{'jobId':event,'state':'complete','result':self.video_result}})]
        for p in self.patches:p.start();self.addCleanup(p.stop)
        self.payload={'revision':1,'events':['review-1','review-2']}

    def submit(self):return batch.submit('game-test',self.payload)['job']

    def test_comment_change_keeps_both_videos_running_and_marks_old_pdf(self):
        job=self.submit();self.report_fingerprint='report-after-comment-edit';batch.run(job['jobId']);result=batch.status(job['jobId'])
        self.assertEqual([r['state'] for r in result['videos']],['complete','complete'])
        self.assertTrue(result['reportNeedsRefresh']);self.assertEqual(result['state'],'partial')
        self.assertEqual(batch.video_jobs.submit.call_count,2)

    def test_changed_scene_isolated_to_that_scene_and_later_video_continues(self):
        job=self.submit();self.scenes['review-1']='new-scene';batch.run(job['jobId']);result=batch.status(job['jobId'])
        self.assertEqual([r['state'] for r in result['videos']],['failed','complete'])
        self.assertEqual(batch.video_jobs.submit.call_count,1)

    def test_scene_changed_after_render_is_marked_stale(self):
        job=self.submit()
        def render(case,event):
            if event=='review-2':self.scenes['review-1']='new-scene'
            return {'job':{'jobId':event,'state':'complete','result':self.video_result}}
        batch.video_jobs.submit.side_effect=render;batch.run(job['jobId']);result=batch.status(job['jobId'])
        self.assertEqual([r['state'] for r in result['videos']],['stale','complete'])

    def test_pdf_failure_does_not_cancel_videos(self):
        job=self.submit();batch.report_jobs.status.return_value={'state':'failed','error':'코멘트 변경'};batch.run(job['jobId']);result=batch.status(job['jobId'])
        self.assertEqual([r['state'] for r in result['videos']],['complete','complete'])
        self.assertTrue(result['reportNeedsRefresh']);self.assertEqual(result['reportIssue'],'코멘트 변경')

    def test_repeated_submit_returns_existing_running_batch_after_comment_change(self):
        job=self.submit();self.report_fingerprint='changed'
        self.assertEqual(self.submit()['jobId'],job['jobId'])
        batch.POOL.submit.assert_called_once()

    def test_automatic_scene_save_is_blocked_during_active_batch(self):
        self.submit()
        with patch.object(batch.broadcast_reconstruction,'save') as save,patch.object(batch.review_flow,'require_stage'):
            with self.assertRaisesRegex(RuntimeError,'영상 제작이 진행 중'):batch.save_automatic_scene('game-test','review-1',{},'a'*24)
            save.assert_not_called()

    def test_automatic_scene_save_works_when_no_batch_is_active(self):
        with patch.object(batch.broadcast_reconstruction,'current',return_value={'captureId':'a'*24}),patch.object(batch.broadcast_reconstruction,'save',return_value={'ok':True}) as save,patch.object(batch.review_flow,'require_stage'):
            self.assertEqual(batch.save_automatic_scene('game-test','review-1',{},'a'*24),{'ok':True})
            save.assert_called_once_with('game-test','review-1',{})

    def test_outdated_automatic_preparation_cannot_overwrite_a_new_scene(self):
        with patch.object(batch.broadcast_reconstruction,'current',return_value={'captureId':'b'*24}),patch.object(batch.broadcast_reconstruction,'save') as save:
            with self.assertRaisesRegex(RuntimeError,'장면이 변경'):batch.save_automatic_scene('game-test','review-1',{},'a'*24)
            save.assert_not_called()

    def test_automatic_preparation_lock_is_per_match(self):
        self.assertIs(batch.case_lock('game-a'),batch.case_lock('game-a'))
        self.assertIsNot(batch.case_lock('game-a'),batch.case_lock('game-b'))

    def test_batch_rechecks_scene_after_concurrent_automatic_save(self):
        import threading
        saving=threading.Event();release=threading.Event();finished=threading.Event();errors=[]
        def slow_save(*args):saving.set();release.wait(2);return {'ok':True}
        def submit():
            try:self.submit()
            except Exception as e:errors.append(str(e))
            finally:finished.set()
        batch.review_flow.require_report.side_effect=[self.current,RuntimeError('scene changed')]
        with patch.object(batch.review_flow,'require_stage'),patch.object(batch.broadcast_reconstruction,'current',return_value={'captureId':'a'*24}),patch.object(batch.broadcast_reconstruction,'save',side_effect=slow_save):
            worker=threading.Thread(target=batch.save_automatic_scene,args=('game-test','review-1',{},'a'*24));worker.start();self.assertTrue(saving.wait(1))
            creator=threading.Thread(target=submit);creator.start();self.assertFalse(finished.wait(.1));release.set();worker.join(2);creator.join(2)
        self.assertEqual(errors,['scene changed']);batch.report_jobs.submit.assert_not_called()


class VideoStampTests(unittest.TestCase):
    def test_stamp_tracks_only_video_inputs_and_referee_matching(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);scene_path=root/'reconstructions'/'review-1'/'current.json';scene_path.parent.mkdir(parents=True);scene_path.write_text('{"state":"a"}')
            case={'events':[{'id':'review-1','selectedBroadcastFrame':7,'broadcast':{'sha256':'source'}}]}
            scene={'captureId':'capture','crewAnalysis':{'rows':[]}};labels={'r1':{'number':8,'name':'심판'}}
            with patch.dict(batch.case_store.CASES,{'game-test':root}),patch.object(batch.case_store,'load_case',return_value=case),patch.object(batch.broadcast_reconstruction,'current',return_value=scene),patch.object(batch.video_jobs,'referee_labels',side_effect=lambda *args:labels):
                baseline=batch.video_stamp('game-test','review-1')
                # No report prose appears in the identity.
                case['comment']='a changed report sentence'
                self.assertEqual(batch.video_stamp('game-test','review-1'),baseline)
                labels['r1']['number']=13;self.assertNotEqual(batch.video_stamp('game-test','review-1'),baseline)
                labels['r1']['number']=8;scene_path.write_text('{"state":"b"}')
                self.assertNotEqual(batch.video_stamp('game-test','review-1'),baseline)

    def test_automatic_http_save_uses_guard_and_manual_save_is_unchanged(self):
        import io,json
        from unittest.mock import Mock
        from serve import Handler
        def call(query):
            payload=json.dumps({'state':{}}).encode();h=object.__new__(Handler)
            h.path='/api/cases/game-test/events/review-1/reconstruction'+query
            h.headers={'Host':'127.0.0.1:4350','Content-Length':str(len(payload))}
            h.rfile=io.BytesIO(payload);h.json=Mock();h.post();return h
        with patch.object(batch,'save_automatic_scene',return_value={'saved':True}) as automatic,patch.object(batch.review_flow,'require_stage'),patch.object(batch.broadcast_reconstruction,'save',return_value={'saved':True}) as manual:
            call('?automatic=1&expectedCapture='+('a'*24));automatic.assert_called_once_with('game-test','review-1',{'state':{}},'a'*24);manual.assert_not_called()
            call('');manual.assert_called_once_with('game-test','review-1',{'state':{}})


if __name__=='__main__':unittest.main()
