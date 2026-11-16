import unittest
from unittest.mock import patch

import broadcast_pose
import broadcast_reconstruction
import pose_variant
import video_map_camera
import video_pose_refit
import fit_pose


class PlacedPoseCameraTests(unittest.TestCase):
 def setUp(self):
  self.scene={'state':{'entities':[{'id':'p1','role':'player','x':2,'y':3}]}}
  self.person={'id':'p1','role':'player','spatialEligible':False,'keypoints':[[1,2] for _ in range(17)],'scores':[.9]*17,'depth':[0]*17,'manualJoints':{'8':[1,2]}}
  self.pose={'people':[self.person],'anchors':[]}
  self.frame={'courtRevision':'reviewed'};self.packet={'width':1920,'height':1080}
  self.camera={'source':'saved-map-and-image-footpoints','K':[[1,0,0],[0,1,0],[0,0,1]]}
  self.provenance={'method':'saved-map-and-image-footpoints','courtRevision':'reviewed'}
  self.context=patch.object(broadcast_reconstruction,'context',return_value=(None,None,self.packet,self.frame));self.context.start();self.addCleanup(self.context.stop)

 def test_unstable_court_uses_reviewed_map_camera(self):
  with patch.object(broadcast_pose,'camera_inputs',side_effect=ValueError('중계 코트 카메라 추정이 불안정합니다. 코트 보정을 확인하세요.')),patch.object(video_map_camera,'estimate',return_value=(self.camera,self.provenance)) as estimate:
   anchors,camera,provenance=pose_variant.placed_people_camera('case','review-2',self.scene,self.pose)
  self.assertEqual(anchors,[]);self.assertEqual(camera,self.camera);self.assertEqual(provenance,self.provenance)
  estimate.assert_called_once_with(self.frame,self.packet,self.scene)

 def test_missing_landmarks_do_not_bypass_calibration(self):
  with patch.object(broadcast_pose,'camera_inputs',side_effect=ValueError('코트 보정점이 부족합니다.')),patch.object(video_map_camera,'estimate') as estimate:
   with self.assertRaisesRegex(ValueError,'보정점이 부족'):pose_variant.placed_people_camera('case','review-2',self.scene,self.pose)
   estimate.assert_not_called()

 def test_unsafe_map_estimate_still_blocks(self):
  with patch.object(broadcast_pose,'camera_inputs',side_effect=ValueError('중계 코트 카메라 추정이 불안정합니다. 코트 보정을 확인하세요.')),patch.object(video_map_camera,'estimate',side_effect=ValueError('2D 위치와 중계 화면의 차이가 큽니다.')):
   with self.assertRaisesRegex(ValueError,'차이가 큽니다'):pose_variant.placed_people_camera('case','review-2',self.scene,self.pose)

 def test_existing_validated_pose_camera_is_preserved(self):
  self.pose['camera']={'source':'existing'}
  with patch.object(broadcast_pose,'camera_inputs',side_effect=ValueError('중계 코트 카메라 추정이 불안정합니다. 코트 보정을 확인하세요.')),patch.object(video_map_camera,'estimate') as estimate:
   _,camera,_=pose_variant.placed_people_camera('case','review-2',self.scene,self.pose)
   self.assertEqual(camera,{'source':'existing'});estimate.assert_not_called()

 def test_lift_uses_same_validated_camera_and_keeps_manual_joints(self):
  def fit(frame):
   self.assertEqual(frame['cameraOverride'],self.camera)
   self.assertEqual(frame['people'][0]['manualJoints'],{'8':[1,2]})
   return frame
  built={**self.person,'accepted':True,'spatialEligible':True,'meshKey':'mesh1'}
  with patch.object(pose_variant,'placed_people_camera',return_value=([],self.camera,self.provenance)),patch.object(fit_pose,'fit',side_effect=fit),patch.object(video_pose_refit,'prepare',side_effect=lambda scene,fitted:fitted),patch.object(video_pose_refit,'build',return_value=({'people':[built]},{'assets':{'mesh1':{'geometry':'test'}}})):
   pose,mesh,audit=pose_variant.lift_placed_people('case','review-2',self.scene,self.pose,{'assets':{}},'/tmp/test-only')
  self.assertEqual(pose['camera'],self.camera);self.assertEqual(pose['videoCameraProvenance'],self.provenance)
  self.assertEqual(pose['people'][0]['manualJoints'],{'8':[1,2]});self.assertIn('mesh1',mesh['assets'])
  self.assertEqual(audit['p1']['cameraSource'],'saved-map-and-image-footpoints')


if __name__=='__main__':unittest.main()
