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
 def test_current_view_update_keeps_independent_omitted_object_caution(self):
  item=copy.deepcopy(self.item);item['review']['assessment']='판독 결과 공격권이 유지됐습니다. 재구성에서는 R1 방향이 열려 있으며, 배치에서 빠진 객체도 함께 고려해야 합니다.'
  with patch.dict(sys.modules,{'report_editorial':self.fake}):self.assertTrue(auto.refresh_view_text({}, {}, {}, item))
  self.assertIn('배치에서 빠진 객체도 함께 고려해야 합니다.',item['review']['assessment'])
  self.assertIn('판독 결과 공격권이 유지됐습니다.',item['review']['assessment'])
 def test_unambiguous_nonvisual_occlusion_and_generic_guidance_do_not_block(self):
  item=copy.deepcopy(self.item)
  item['review']['difficultyFactors']='선수들이 겹쳐 접촉 부위가 가려집니다.'
  item['review']['takeaway']='각 심판의 시야를 교차 확인해야 합니다.'
  with patch.dict(sys.modules,{'report_editorial':self.fake}):self.assertTrue(auto.refresh_view_text({}, {}, {}, item))
  self.assertEqual(item['review']['difficultyFactors'],'선수들이 겹쳐 접촉 부위가 가려집니다.')
  self.assertEqual(item['review']['takeaway'],'각 심판의 시야를 교차 확인해야 합니다.')

 def test_fallback_preserves_mixed_facts_and_marks_previous_visibility(self):
  item=copy.deepcopy(self.item);item['review']['takeaway']='R2는 가림이 적은 각도를 확보했다.'
  item['review']['assessment']='판독 결과 파울이 유지됐고 R2의 시야가 열려 있었다.'
  item['review']['callerNumber']=37;item['review']['callerBasis']='중계 화면의 심판 신호입니다.'
  with patch.dict(sys.modules,{'report_editorial':self.fake}):info=auto.fallback_view_text({}, {}, {}, item)
  review=item['review'];self.assertIn('R2는 가림이 적은 각도를 확보했다.',review['takeaway'])
  self.assertTrue(review['takeaway'].startswith('보정 전 시야 기준: '))
  self.assertIn('판독 결과 파울이 유지됐고 R2의 시야가 열려 있었다.',review['assessment'])
  self.assertIn('보정 전 시야',review['assessment']);self.assertIn('R1이 잘 드러납니다',review['viewComment'])
  self.assertEqual(review['callerNumber'],37);self.assertEqual(review['callerBasis'],'중계 화면의 심판 신호입니다.')
  self.assertTrue(info['previousViewNotice'])

 def test_fallback_keeps_long_original_assessment_and_shows_context_note(self):
  item=copy.deepcopy(self.item);old='판독 결과 파울 유지. R2 시야가 잘 보였습니다. '+('가'*480);item['review']['assessment']=old
  with patch.dict(sys.modules,{'report_editorial':self.fake}):info=auto.fallback_view_text({}, {}, {}, item)
  self.assertEqual(item['review']['assessment'],old)
  self.assertIn('보정 전 기준',item['review']['viewComment']);self.assertTrue(info['previousViewNotice'])
  self.assertLessEqual(len(item['review']['viewComment']),auto.report_inputs.LIMITS['viewComment'])

 def test_authored_commentary_is_preserved_when_visibility_changes(self):
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
   data={'events':{event:{'scene':{'captureId':old},'review':{'takeaway':'R2가 보았다.','viewComment':'R1은 열려 있고 R2는 가립니다.','assessment':'파울이 유지됐습니다. R2의 시야를 확인합니다.'}}}}
   case_data={'events':[{'id':event}]}
   def partial_refresh(case_data,event_data,scene,candidate):
    candidate['review']['takeaway']='부분 수정된 임시 문장'
    return False
   with patch.dict(auto.case_store.CASES,{case:root},clear=True),patch.object(auto.report_inputs,'version',return_value='rev'),\
        patch.object(auto.broadcast_reconstruction,'current',return_value=after),patch.object(auto.review_flow,'status',return_value=status),\
        patch.object(auto.review_flow,'stored',return_value=stored),patch.object(auto.review_flow,'complete') as complete,\
        patch.object(auto.report_inputs,'read',return_value=data),patch.object(auto.case_store,'load_case',return_value=case_data),\
        patch.object(auto,'visibility_signature',side_effect=lambda scene:scene['captureId']),patch.object(auto,'refresh_view_text',side_effect=partial_refresh),\
        patch.object(auto,'fallback_view_text',return_value={'mode':'automatic-preserving-authored-context','previousViewNotice':True}) as fallback,patch.object(auto,'atomic') as write:
    result=auto.finalize(case,event,{'previousCaptureId':old,'captureId':newid,'version':'rev'})
   self.assertTrue(result['carried']);self.assertFalse(result['viewUpdated']);self.assertTrue(result['visibilityChanged']);fallback.assert_not_called()
   self.assertEqual(write.call_count,2)
   saved=write.call_args_list[-1].args[1]['events'][event]['scene'];self.assertEqual(saved['captureId'],newid)
   self.assertTrue(saved['autoPoseVisibilityChanged']);self.assertFalse(saved['autoPoseViewUpdated'])
   self.assertEqual(write.call_args_list[-1].args[1]['events'][event]['review'],data['events'][event]['review'])
   complete.assert_called_once_with(case,event,{'stage':'spatial','token':token},source='automatic-pose-recalculated')

 def test_concurrent_editorial_change_is_not_silently_overwritten(self):
  with patch.object(auto.report_inputs,'version',return_value='new-version'),patch.object(auto,'atomic') as write:
   with self.assertRaisesRegex(RuntimeError,'코멘트가 변경'):
    auto.finalize('case-a','review-1',{'previousCaptureId':'a'*24,'captureId':'b'*24,'version':'old-version'})
   write.assert_not_called()

if __name__=='__main__':unittest.main()
