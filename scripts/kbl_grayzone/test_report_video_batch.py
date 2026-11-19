import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import report_video_batch as batch

class NeutralApprovalReadinessTests(unittest.TestCase):
    def test_only_explicitly_approved_unresolved_player_is_ready(self):
        import pose_variant
        from job_store import atomic
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);case='game-test';event='review-5';capture='a'*24;variant='b'*24
            scene={'captureId':capture,'poseVariantId':variant,'state':{'entities':[{'id':'player-1','role':'player'}]}}
            player={'id':'player-1','spatialEligible':False,'keypoints':[0]*17,'scores':[0]*17,'depth':[0]*17}
            case_data={'events':[{'id':event,'number':5}]}
            with patch.dict(batch.case_store.CASES,{case:root}),patch.object(batch.case_store,'load_case',return_value=case_data),\
                 patch.object(batch.broadcast_reconstruction,'current',return_value=scene),patch.object(batch.video_jobs,'enabled',return_value=True),\
                 patch.object(batch.video_jobs,'executable'),patch.object(batch.video_jobs,'inputs',return_value={'pose':{'people':[player]}}),\
                 patch.object(pose_variant,'placed_people_camera'):
                self.assertTrue(batch.readiness(case)['events'][0]['autoPrepare'])
                approval={'schema':'courtside-neutral-pose-approval/v1','caseId':case,'eventId':event,'captureId':capture,'poseVariantId':variant,'personIds':['player-1']}
                atomic(root/'reconstructions'/event/'neutral-pose-approvals'/(capture+'.json'),approval)
                row=batch.readiness(case)['events'][0];self.assertTrue(row['ready']);self.assertFalse(row['autoPrepare']);self.assertEqual(row['neutralFallback'],['player-1'])
                scene['captureId']='c'*24;self.assertTrue(batch.readiness(case)['events'][0]['autoPrepare'])


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
        self.patches=[patch.dict(batch.case_store.CASES,{'game-test':Path(self.temp.name)}),patch.object(batch,'ROOT',Path(self.temp.name)),patch.object(batch.POOL,'submit'),
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
        job=self.submit()
        def finish_pdf(_):
            self.report_fingerprint='report-after-comment-edit'
            return {'state':'complete','result':self.report_result}
        batch.report_jobs.status.side_effect=finish_pdf;batch.run(job['jobId']);result=batch.status(job['jobId'])
        self.assertEqual([r['state'] for r in result['videos']],['complete','complete'])
        self.assertTrue(result['reportNeedsRefresh']);self.assertEqual(result['state'],'partial')
        self.assertEqual(batch.video_jobs.submit.call_count,2)

    def test_changed_scene_isolated_to_that_scene_and_later_video_continues(self):
        job=self.submit()
        def finish_pdf(_):
            self.scenes['review-1']='new-scene'
            return {'state':'complete','result':self.report_result}
        batch.report_jobs.status.side_effect=finish_pdf;batch.run(job['jobId']);result=batch.status(job['jobId'])
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
        def run(job):
            try:batch.run(job)
            except Exception as e:errors.append(str(e))
            finally:finished.set()
        batch.review_flow.require_report.side_effect=RuntimeError('scene changed')
        with patch.object(batch.review_flow,'require_stage'),patch.object(batch.broadcast_reconstruction,'current',return_value={'captureId':'a'*24}),patch.object(batch.broadcast_reconstruction,'save',side_effect=slow_save):
            worker=threading.Thread(target=batch.save_automatic_scene,args=('game-test','review-1',{},'a'*24));worker.start();self.assertTrue(saving.wait(1))
            job=self.submit();creator=threading.Thread(target=run,args=(job['jobId'],));creator.start();self.assertFalse(finished.wait(.1));release.set();worker.join(2);creator.join(2)
        self.assertFalse(errors);self.assertEqual(batch.status(job['jobId'])['error'],'scene changed');batch.report_jobs.submit.assert_not_called()

    def test_request_returns_before_expensive_validation_and_pdf_work(self):
        job=self.submit()
        self.assertEqual(job['state'],'queued')
        batch.review_flow.require_report.assert_not_called()
        batch.readiness.assert_not_called()
        batch.report_jobs.submit.assert_not_called()

    def test_invalid_worker_preflight_is_reported_without_starting_pdf(self):
        job=self.submit();batch.review_flow.require_report.side_effect=RuntimeError('scene changed')
        batch.run(job['jobId']);result=batch.status(job['jobId'])
        self.assertEqual(result['state'],'failed');self.assertEqual(result['error'],'scene changed')
        batch.report_jobs.submit.assert_not_called()


    def test_server_prepares_pose_then_creates_pdf_and_videos(self):
        import report_inputs,server_auto_pose,auto_pose_review
        job=self.submit();old='a'*24;new='b'*24
        pending={'events':[{'eventId':'review-1','number':1,'ready':True,'autoPrepare':True},
                           {'eventId':'review-2','number':2,'ready':True,'autoPrepare':False}]}
        prepared={'events':[{'eventId':'review-1','number':1,'ready':True,'autoPrepare':False},
                            {'eventId':'review-2','number':2,'ready':True,'autoPrepare':False}]}
        batch.readiness.side_effect=[pending,prepared]
        def render(case,event,key):
            self.assertTrue(server_auto_pose.permitted(case,event,job['jobId'],key))
            self.assertFalse(server_auto_pose.permitted(case,event,job['jobId'],'invalid'))
            return {'previousCaptureId':old,'captureId':new}
        with patch.object(batch.broadcast_reconstruction,'current',return_value={'captureId':old}),\
             patch.object(server_auto_pose,'render',side_effect=render),patch.object(report_inputs,'version',return_value='version'),\
             patch.object(auto_pose_review,'finalize',return_value={'carried':True}) as finalize:
            batch.run(job['jobId'])
        self.assertEqual(batch.status(job['jobId'])['state'],'complete')
        finalize.assert_called_once_with('game-test','review-1',{'previousCaptureId':old,'captureId':new,'version':'version'})
        batch.report_jobs.submit.assert_called_once();self.assertEqual(batch.video_jobs.submit.call_count,2)

    def test_only_authorized_batch_can_save_automatic_scene(self):
        import server_auto_pose
        job=self.submit()
        with server_auto_pose.authorize('game-test','review-1',job['jobId']) as key,\
             patch.object(batch.broadcast_reconstruction,'current',return_value={'captureId':'a'*24}),\
             patch.object(batch.broadcast_reconstruction,'save',return_value={'ok':True}) as save,patch.object(batch.review_flow,'require_stage'):
            with self.assertRaisesRegex(RuntimeError,'제작이 진행 중'):
                batch.save_automatic_scene('game-test','review-1',{},'a'*24,internal_key='wrong')
            self.assertEqual(batch.save_automatic_scene('game-test','review-1',{},'a'*24,internal_key=key),{'ok':True})
            save.assert_called_once()

    def test_auto_preparation_failure_never_starts_partial_report(self):
        import server_auto_pose,report_inputs
        job=self.submit();batch.readiness.return_value={'events':[{'eventId':'review-1','number':1,'ready':True,'autoPrepare':True}]}
        with patch.object(batch.broadcast_reconstruction,'current',return_value={'captureId':'a'*24}),\
             patch.object(report_inputs,'version',return_value='version'),\
             patch.object(server_auto_pose,'render',side_effect=RuntimeError('자동 보정 실패')):
            batch.run(job['jobId'])
        self.assertEqual(batch.status(job['jobId'])['state'],'failed');batch.report_jobs.submit.assert_not_called();batch.video_jobs.submit.assert_not_called()

    def test_lost_browser_response_reconciles_only_verified_saved_pose(self):
        import server_auto_pose,report_inputs,auto_pose_review
        job=self.submit();old='a'*24;new='b'*24
        batch.readiness.side_effect=[{'events':[{'eventId':'review-1','number':1,'ready':True,'autoPrepare':True}]},
                                     {'events':[{'eventId':'review-1','number':1,'ready':True,'autoPrepare':False}]}]
        with patch.object(batch.broadcast_reconstruction,'current',side_effect=[{'captureId':old},{'captureId':new,'poseVariantId':'c'*24}]),\
             patch.object(report_inputs,'version',return_value='version'),\
             patch.object(server_auto_pose,'render',side_effect=RuntimeError('응답 끊김')),\
             patch.object(auto_pose_review,'finalize',return_value={'carried':True}) as finalize:
            batch.run(job['jobId'])
        self.assertEqual(batch.status(job['jobId'])['state'],'complete')
        finalize.assert_called_once_with('game-test','review-1',{'previousCaptureId':old,'captureId':new,'version':'version'})


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
            payload=json.dumps({'state':{},'expectedCaptureId':None}).encode();h=object.__new__(Handler)
            h.path='/api/cases/game-test/events/review-1/reconstruction'+query
            h.headers={'Host':'127.0.0.1:4350','Content-Length':str(len(payload))}
            h.rfile=io.BytesIO(payload);h.json=Mock();h.post();return h
        with patch.object(batch,'save_automatic_scene',return_value={'saved':True}) as automatic,patch.object(batch.review_flow,'require_stage'),patch.object(batch.broadcast_reconstruction,'save',return_value={'saved':True}) as manual:
            call('?automatic=1&expectedCapture='+('a'*24));automatic.assert_called_once_with('game-test','review-1',{'state':{},'expectedCaptureId':None},'a'*24);manual.assert_not_called()
            call('');manual.assert_called_once_with('game-test','review-1',{'state':{},'expectedCaptureId':None})


if __name__=='__main__':unittest.main()
