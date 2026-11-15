import copy,json,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import auto_pose_review as auto
from job_store import atomic

class AutoPoseContinuityTests(unittest.TestCase):
 def setUp(self):
  self.item={'review':{'takeaway':'손목 접촉을 구분하고 가림이 적은 각도를 함께 확인해야 한다.',
   'viewComment':'재구성에서는 R1이 열려 있고 R2는 일부 가린다. 돌아서는 순간의 손과 손목을 교차 확인해야 한다.',
   'assessment':'수원 파울이 유지됐다. 심판은 손목을 쳤다고 발표했다. 선택 화면의 재구성에서는 R1이 열리고 다른 방향은 가리므로, 손의 움직임은 다른 시점에서 함께 살피는 것이 중요하다.'}}
  self.fake=types.SimpleNamespace(scene_commentary=lambda *args:{'viewComment':'재구성에서는 R1이 잘 드러납니다. R2 방향은 P5에 가려집니다.'})
 def test_safe_update_keeps_result_and_independent_observation(self):
  with patch.dict(sys.modules,{'report_editorial':self.fake}):self.assertTrue(auto.refresh_view_text({}, {}, {}, self.item))
  review=self.item['review']
  self.assertIn('수원 파울이 유지됐다.',review['assessment'])
  self.assertIn('손의 움직임은 다른 시점에서 함께 살피는 것이 중요하다.',review['assessment'])
  self.assertIn('돌아서는 순간의 손과 손목을 교차 확인해야 한다.',review['viewComment'])
  self.assertIn('R2 방향은 P5에 가려집니다.',review['viewComment'])
  self.assertIn('가림이 적은 각도',review['takeaway'])
 def test_specific_visibility_in_other_fields_requires_report_review(self):
  item=copy.deepcopy(self.item);item['review']['takeaway']='R2는 가림이 적은 각도를 확보했다.'
  with patch.dict(sys.modules,{'report_editorial':self.fake}):self.assertFalse(auto.refresh_view_text({}, {}, {}, item))
  self.assertEqual(item['review']['viewComment'],self.item['review']['viewComment'])
 def test_saved_referee_assignments_are_included_in_updated_view(self):
  item=copy.deepcopy(self.item);item['review']['refereeAssignments']={'r1':10,'r2':30}
  case={'referees':[{'number':10,'name':'이승환'},{'number':30,'name':'김수연'}]}
  scene={'crewAnalysis':{'rows':[{'id':'r1','label':'R1'},{'id':'r2','label':'R2'}]}}
  with patch.dict(sys.modules,{'report_editorial':self.fake}):self.assertTrue(auto.refresh_view_text(case,{},scene,item))
  self.assertIn('이승환 심판(R1)',item['review']['viewComment'])
  self.assertIn('김수연 심판(R2)',item['review']['viewComment'])
 def test_other_blocked_referee_is_preserved(self):
  item=copy.deepcopy(self.item);item['review']['refereeAssignments']={'r3':37}
  case={'referees':[{'number':37,'name':'한정원'}]}
  scene={'crewAnalysis':{'rows':[{'id':'r3','label':'R3','counts':{'blocked':9},'blockers':['p10']}]}}
  fake=types.SimpleNamespace(scene_commentary=lambda *args:{'viewComment':'재구성에서는 R1이 잘 드러납니다. R2 방향은 P5에 가려집니다.','labels':{'p10':'P10'}})
  with patch.dict(sys.modules,{'report_editorial':fake}):self.assertTrue(auto.refresh_view_text(case,{},scene,item))
  self.assertIn('한정원 심판(R3) 방향도 P10에',item['review']['viewComment'])
 def test_cannot_safely_change_comment_still_completes_spatial_only(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);case='case-a';event='review-3';old='a'*24;newid='b'*24;variant='c'*24
   base={'caseId':case,'eventId':event,'frameIndex':1,'datasetId':'data','inputSha256':'sha','selectionVersion':'v',
         'sceneEvidenceSha256':'ev','poseJobId':'pose','uniformRevision':1,'state':{'entities':[]},
         'crewAnalysis':{'rows':[],'leaders':[],'missingReferees':0,'crewComplete':True}}
   before={**base,'captureId':old};after={**base,'captureId':newid,'poseVariantId':variant}
   atomic(root/'reconstructions'/event/old/'scene.json',before)
   meta=root/'reconstructions'/event/'pose-variants'/variant;atomic(meta/'meta.json',{'sourceCaptureId':old})
   token='new-spatial';objects='objects-token';step={'available':True,'ready':True,'token':token}
   status={'events':[{'id':event,'stages':{'objects':{'token':objects},'spatial':step}}]}
   stored={'events':{event:{'spatial':{'token':auto.review_flow.digest([objects,'pose',old])}}}}
   data={'events':{event:{'scene':{'captureId':old},'review':{'takeaway':'R2가 보았다.'}}}}
   case_data={'events':[{'id':event}]}
   with patch.dict(auto.case_store.CASES,{case:root},clear=True),patch.object(auto.report_inputs,'version',return_value='rev'),\
        patch.object(auto.broadcast_reconstruction,'current',return_value=after),patch.object(auto.review_flow,'status',return_value=status),\
        patch.object(auto.review_flow,'stored',return_value=stored),patch.object(auto.review_flow,'complete') as complete,\
        patch.object(auto.report_inputs,'read',return_value=data),patch.object(auto.case_store,'load_case',return_value=case_data),\
        patch.object(auto,'visibility_signature',side_effect=lambda scene:scene['captureId']),patch.object(auto,'refresh_view_text',return_value=False),\
        patch.object(auto,'atomic') as write:
    result=auto.finalize(case,event,{'previousCaptureId':old,'captureId':newid,'version':'rev'})
   self.assertFalse(result['carried']);self.assertIn('리포트',result['reason']);write.assert_not_called()
   complete.assert_called_once_with(case,event,{'stage':'spatial','token':token},source='automatic-pose-report-review-required')

if __name__=='__main__':unittest.main()
