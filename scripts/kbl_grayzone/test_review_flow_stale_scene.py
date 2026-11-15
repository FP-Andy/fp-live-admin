import unittest
from unittest.mock import patch
import review_flow as flow

class StaleSceneFlowTests(unittest.TestCase):
 def test_manual_placements_survive_stale_court_but_scene_is_not_complete(self):
  objects={'frameIndex':11,'datasetId':'data','inputSha256':'sha','objects':[
   {'id':'ref','role':'referee','excluded':False,'hasFloorPosition':False},
   {'id':'player','role':'player','excluded':False,'hasFloorPosition':False}]}
  pose={'job':{'state':'complete','result':{'people':[]}},'jobId':'pose'}
  saved={'courtStale':True,'state':{'entities':[
   {'id':'ref','role':'referee','positionSource':'manual'},
   {'id':'player','role':'player','positionSource':'manual'}]}}
  def current(case,event,strict=False):
   if strict:raise RuntimeError('코트 보정이 변경됐습니다.')
   return saved
  event={'id':'review-3','number':3,'quarter':3,'gameClock':'3:29'}
  with patch.object(flow.broadcast_objects,'view',return_value=objects),patch.object(flow.broadcast_pose,'current',return_value=pose),\
       patch.object(flow.broadcast_reconstruction,'current',side_effect=current):
   result=flow.event_state('case',event,{})
  self.assertEqual(result['unresolvedSpatialIds'],[])
  self.assertFalse(result['stages']['spatial']['ready'])
  self.assertFalse(result['stages']['spatial']['complete'])

 def test_old_placement_does_not_satisfy_changed_role(self):
  objects={'frameIndex':1,'datasetId':'data','inputSha256':'sha','objects':[
   {'id':'person','role':'referee','excluded':False,'hasFloorPosition':False}]}
  saved={'state':{'entities':[{'id':'person','role':'player','positionSource':'manual'}]}}
  event={'id':'review-1','number':1,'quarter':1,'gameClock':'1:00'}
  def current(case,event,strict=False):
   if strict:raise RuntimeError('장면 변경')
   return saved
  with patch.object(flow.broadcast_objects,'view',return_value=objects),patch.object(flow.broadcast_pose,'current',return_value=None),\
       patch.object(flow.broadcast_reconstruction,'current',side_effect=current):
   result=flow.event_state('case',event,{})
  self.assertEqual(result['unresolvedSpatialIds'],['person'])

if __name__=='__main__':unittest.main()
