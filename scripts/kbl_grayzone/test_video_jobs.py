import io,json,tempfile,unittest
import numpy as np
from pathlib import Path
from unittest.mock import patch
import video_jobs as jobs
from job_store import lease
from serve import Handler

class VideoJobTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.job='a'*24
  self.patches=[patch.object(jobs,'ROOT',self.root)]
  for p in self.patches:p.start();self.addCleanup(p.stop)
 def test_bad_id_is_rejected(self):
  for value in ('../other','a'*23,'z'*24):
   with self.assertRaises(ValueError):jobs.folder(value)
 def test_queued_interrupted_when_runner_gone(self):
  p=jobs.folder(self.job);p.mkdir();(p/'status.json').write_text(json.dumps({'jobId':self.job,'state':'queued','_createdEpoch':0}))
  self.assertEqual(jobs.status(self.job)['state'],'interrupted')
 def test_runner_interrupted_after_publish_recovers_verified_video(self):
  p=jobs.folder(self.job);p.mkdir();(p/'status.json').write_text(json.dumps({'jobId':self.job,'caseId':'case-a','eventId':'review-1','state':'running','_createdEpoch':0}))
  with patch.object(jobs.review_videos,'inspect',return_value=({},p/'video.mp4')):self.assertEqual(jobs.status(self.job)['state'],'complete')
 def test_other_running_worker_fails_without_publishing(self):
  p=jobs.folder(self.job);p.mkdir();(p/'status.json').write_text(json.dumps({'jobId':self.job,'state':'queued','caseId':'case-a','eventId':'review-1'}));(p/'inputs.json').write_text('{}')
  with lease(self.root/'worker.lock') as held:
   self.assertTrue(held);jobs.run(self.job)
  data=jobs.status(self.job);self.assertEqual(data['state'],'failed');self.assertIn('다른 영상',data['error']);self.assertFalse((p/'result.json').exists())
 def test_disabled_blocks_before_any_input(self):
  with patch.dict(jobs.os.environ,{'KBL_VIDEO_RENDER_ENABLED':'0'}),patch.object(jobs,'inputs') as inputs:
   with self.assertRaises(RuntimeError):jobs.submit('case-a','review-1')
   inputs.assert_not_called()
 def test_camera_path_preserves_both_valid_saved_handednesses(self):
  from video_cpu_worker import camera_plan
  entities=[{'id':'p','role':'player','x':14.,'y':7.5},
            {'id':'r1','role':'referee','x':2.,'y':2.,'viewHeading':0.5},
            {'id':'r2','role':'referee','x':24.,'y':2.,'viewHeading':2.5},
            {'id':'r3','role':'referee','x':14.,'y':14.,'viewHeading':-1.5}]
  scene={'state':{'entities':entities,'reviewPoint':{'x':14.,'y':7.5},'hfov':100,'vfov':70},
         'crewAnalysis':{'rows':[{'id':e['id']} for e in entities[1:]]}}
  proper=np.array([[1.,0.,0.],[0.,0.,-1.],[0.,1.,0.]])
  for expected in (proper,np.diag([1.,-1.,1.])@proper):
   with self.subTest(determinant=np.linalg.det(expected)):
    centre=np.array([14.,-10.,12.]);pose={'camera':{'K':[[1500,0,960],[0,1500,540],[0,0,1]],
         'worldToCamera':expected.tolist(),'translation':(-expected@centre).tolist()}}
    frames,_,initial,_=camera_plan(scene,pose)
    self.assertTrue(np.allclose(initial,expected));self.assertTrue(np.allclose(frames[0][0],expected))
    self.assertTrue(np.allclose(frames[-1][0],expected))
    self.assertTrue(all(np.linalg.det(item[0])*np.linalg.det(expected)>.999 for item in frames))
 def test_image_only_camera_uses_reviewed_court_without_mutating_pose(self):
  pose={'poseSource':'image-only-inferred','camera':None,'people':[{'id':'p','accepted':False}]}
  frame={'courtRevision':'reviewed','court':{'visuallyReviewed':True}}
  camera={'anchorRMSEPixels':4.2,'K':[[1,0,0],[0,1,0],[0,0,1]]}
  with patch.object(jobs.reconstruction,'context',return_value=(None,None,None,frame)),patch.object(jobs.broadcast_pose,'camera_inputs',return_value=([],camera)):
   out=jobs.video_pose_with_camera('case','review-1',pose)
  self.assertIsNone(pose['camera']);self.assertEqual(out['camera'],camera);self.assertEqual(out['videoCameraProvenance']['courtRevision'],'reviewed')
  self.assertFalse(out['people'][0]['accepted'])
 def test_unreviewed_court_cannot_supply_image_only_camera(self):
  pose={'poseSource':'image-only-inferred','camera':None,'people':[{'accepted':False}]}
  with patch.object(jobs.reconstruction,'context',return_value=(None,None,None,{'court':{}})):
   with self.assertRaisesRegex(ValueError,'검토된 코트'):jobs.video_pose_with_camera('case','review-1',pose)
 def test_unstable_camera_uses_saved_map_without_changing_pose(self):
  pose={'poseSource':'image-only-inferred','camera':None,'people':[{'accepted':False}]}
  frame={'courtRevision':'rev','court':{'visuallyReviewed':True}};scene={'state':{'entities':[]}}
  camera={'K':[[1,0,0],[0,1,0],[0,0,1]]};provenance={'method':'saved-map-and-image-footpoints','provisional':True}
  with patch.object(jobs.reconstruction,'context',return_value=(None,None,{},frame)),patch.object(jobs.reconstruction,'current',return_value=scene),patch.object(jobs.broadcast_pose,'camera_inputs',side_effect=ValueError('중계 코트 카메라 추정이 불안정합니다. 코트 보정을 확인하세요.')),patch('video_map_camera.estimate',return_value=(camera,provenance)):
   out=jobs.video_pose_with_camera('case','review-1',pose)
  self.assertIsNone(pose['camera']);self.assertEqual(out['camera'],camera);self.assertEqual(out['videoCameraProvenance'],provenance)
 def test_other_camera_errors_are_not_bypassed(self):
  pose={'poseSource':'image-only-inferred','camera':None,'people':[{'accepted':False}]}
  frame={'courtRevision':'rev','court':{'visuallyReviewed':True}}
  with patch.object(jobs.reconstruction,'context',return_value=(None,None,{},frame)),patch.object(jobs.broadcast_pose,'camera_inputs',side_effect=ValueError('코트 보정점이 부족합니다.')),patch('video_map_camera.estimate') as estimate:
   with self.assertRaisesRegex(ValueError,'보정점이 부족'):jobs.video_pose_with_camera('case','review-1',pose)
   estimate.assert_not_called()
 def test_rejects_saved_referee_pose_with_neutral_video(self):
  scene={'state':{'entities':[{'id':'r','role':'referee','x':1,'y':2}]}}
  pose={'people':[{'id':'r','role':'referee','x':1,'y':2,'accepted':True}]}
  with self.assertRaisesRegex(ValueError,'인체 형상이 다릅니다'):jobs.validate_shared_geometry(scene,pose)
  scene['poseVariantId']='variant';jobs.validate_shared_geometry(scene,pose)
 def test_rejects_player_pose_when_stored_position_does_not_match(self):
  scene={'state':{'entities':[{'id':'p','role':'player','x':1,'y':2}]}}
  pose={'people':[{'id':'p','role':'player','x':3,'y':2,'accepted':True}]}
  with self.assertRaisesRegex(ValueError,'인체 형상이 다릅니다'):jobs.validate_shared_geometry(scene,pose)
 def test_video_http_selects_pose_mode_and_rejects_unknown_mode(self):
  from unittest.mock import Mock
  def call(payload):
   body=json.dumps(payload).encode();h=object.__new__(Handler);h.path='/api/cases/case-a/events/review-1/video-jobs';h.headers={'Host':'127.0.0.1:4350','Origin':'http://127.0.0.1:4350','Content-Type':'application/json','Content-Length':str(len(body))};h.rfile=io.BytesIO(body);h.json=Mock();h.post();return h
  with patch.object(jobs,'submit',return_value={'job':{}}) as submit:
   call({'action':'create','playerOrientation':'source'});submit.assert_called_once_with('case-a','review-1','source')
   submit.reset_mock();call({'action':'create','playerOrientation':'refit'});submit.assert_called_once_with('case-a','review-1','refit')
   submit.reset_mock();call({'action':'create','playerOrientation':'unknown'});submit.assert_not_called()

if __name__=='__main__':unittest.main()
