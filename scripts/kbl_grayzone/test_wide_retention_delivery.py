import json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import case_store,match_library,report_versions,wide_cache_retention as retention

class WideRetentionDeliveryTests(unittest.TestCase):
 def test_only_confirmed_valid_pdf_qualifies(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'case.json').write_text('{}');(root/'review-flow.json').write_text(json.dumps({'events':{'review-1':{'spatial':{'token':'saved'}}}}));pdf=root/'report.pdf';pdf.write_bytes(b'pdf')
   case={'date':'2020-01-01','events':[{'id':'review-1'}]};match={'matches':[{'fpcMatchId':'m1','caseId':'game-test'}]};index={'versions':[{'id':'a'*24}],'publishedVersion':None}
   with patch.dict(case_store.CASES,{'game-test':root}),patch.object(case_store,'load_case',return_value=case),patch.object(match_library,'read',return_value=match),patch.object(report_versions,'index',side_effect=lambda _:index),patch.object(report_versions,'file',return_value=pdf) as get:
    self.assertEqual(retention.completed_cases('m1',time.time()),[]);get.assert_not_called()
    index['publishedVersion']='a'*24;self.assertEqual(retention.completed_cases('m1',time.time()),['game-test']);get.assert_called_once_with('game-test','a'*24)
    get.side_effect=RuntimeError('hash mismatch');self.assertEqual(retention.completed_cases('m1',time.time()),[])
 def test_latest_and_two_previous_stay_protected(self):
  rows=[{'fpcMatchId':f'm{i}','date':'2026-11-18','gameNumber':str(i)} for i in range(1,7)]
  self.assertEqual(retention.retained_matches('m6',rows),{'m4','m5','m6'})
  self.assertTrue({'m1','m2','m3','m4','m5','m6'}<=retention.retained_matches('m3',rows))

if __name__=='__main__':unittest.main()
