"""Build a versioned synthetic 10-scene PDF for isolated bridge QA."""
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from PIL import Image


@unittest.skipUnless(os.environ.get('COURTSIDE_ISOLATED_QA')=='1','isolated worker not configured')
class PrivatePdfSmoke(unittest.TestCase):
 def test_build_versioned_eleven_page_report(self):
  root=Path(__file__).resolve().parents[2];token=os.environ.get('COURTSIDE_QA_TOKEN','')
  self.assertGreaterEqual(len(token),16);self.assertEqual((root/'.isolated-courtside-test').read_text(),token)
  self.assertEqual(os.environ.get('KBL_GPU_DISABLED'),'1');self.assertEqual(os.environ.get('KBL_DELIVERY_MODE'),'web')
  mid='a0000000-0000-4000-8000-000000000099';case_id='game999-synthetic';intake='a'*24;library='match-synthetic'
  case_root=root/'outputs/kbl-cases'/case_id;case_root.mkdir(parents=True)
  event_base={'recordedDecision':'유지','recordedReason':'일반 파울 유지','requestingTeam':'테스트 한국가스공사 페가수스','reviewDurationSeconds':71}
  events=[{**event_base,'id':f'review-{n}','number':n,'quarter':2,'gameClock':'1:28',
           'selectedBroadcastFrame':169,'broadcast':{'sha256':'a'*64}} for n in range(1,11)]
  case={'id':case_id,'intakeId':intake,'fpcMatchId':mid,'csvSha256':'synthetic-csv','referees':[{'number':14,'name':'테스트 심판'}],
        'home':'테스트 홈','away':'테스트 원정','events':events,'title':'테스트 홈 vs 테스트 원정','date':'2026-11-13','gameNumber':'999'}
  (case_root/'case.json').write_text(json.dumps(case,ensure_ascii=False))
  intake_path=root/'outputs/kbl-intake'/intake;intake_path.mkdir(parents=True)
  (intake_path/'intake.json').write_text(json.dumps({'id':intake,'linkedCaseId':case_id,'libraryMatchId':library}))
  lib=root/'outputs/kbl-library';lib.mkdir(parents=True)
  (lib/'matches.json').write_text(json.dumps({'matches':[{'id':library,'fpcMatchId':mid,'caseIds':[case_id]}]}))
  refs=[{'id':f'r{i}','label':f'R{i}','counts':{'visible':9,'blocked':0},'distance':8.,'headingSource':'target-assumption'} for i in range(1,4)]
  snapshots={};rows=[];inputs=case_root/'selected-frames';inputs.mkdir()
  image=inputs/'synthetic.jpg';Image.new('RGB',(1280,720),'white').save(image)
  image_sha=hashlib.sha256(image.read_bytes()).hexdigest()
  for event in events:
   eid=event['id'];snapshots[eid]={'captureId':'test','frameIndex':169,'state':{'entities':[],'targetId':'p','targetHeight':1.1,'hfov':100},
    'crewAnalysis':{'rows':refs,'leaders':['r1'],'crewComplete':True,'sceneComplete':True}}
   folder=case_root/'reconstructions'/eid/'test';folder.mkdir(parents=True)
   Image.new('RGB',(1280,800),'white').save(folder/'crewMap.jpg')
   for name in ('eye1','eye2','eye3'):Image.new('RGB',(64,40),'white').save(folder/(name+'.jpg'))
   rows.append({'eventId':eid,'clipId':eid,'frameIndex':169,'inputSha256':'a'*64,'datasetId':'synthetic-tracks',
                'image':'synthetic.jpg','imageSha256':image_sha,'runtime':{'totalSeconds':1}})
  (inputs/'inputs.json').write_text(json.dumps(rows))
  editorial={'csvSha256':'synthetic-csv','events':{e['id']:{'scene':{'captureId':'test'},
    'review':{'initialCall':'원심 보류 후 영상 판독으로 일반 파울을 인정했습니다.'}} for e in events}}
  editorial['events']['review-10']['review']['assessment']=(
   '선수의 접촉 위치와 동작 순서를 검토하고 심판 시점에서 가려진 장면을 함께 비교했습니다. '*12)[:500]
  (case_root/'report-editorial.json').write_text(json.dumps(editorial,ensure_ascii=False))
  import broadcast_reconstruction,case_report,case_report_layout,case_store,report_delivery,report_versions
  image_stub=Image.new('RGB',(64,40),'white');pdf=root/'synthetic-packet.pdf'
  with patch.object(case_report,'load_case',return_value=case),patch.object(broadcast_reconstruction,'current',side_effect=lambda _case,eid,strict: snapshots[eid]),\
       patch.object(case_store,'broadcast_packet',return_value={'datasetId':'synthetic-tracks'}),\
       patch.object(case_report_layout,'scene_images',return_value=(image_stub,None,{'broadcast':{'poseCount':0}})):
   metadata=case_report.create(case_id,inputs,pdf)
  self.assertEqual(metadata['pageCount'],11)
  stored=report_versions.store(case_id,pdf,metadata);self.assertEqual(stored['pageCount'],11)
  self.assertEqual(report_delivery.deliver(case_id,stored['reportId'])['state'],'ready-for-download')
  listing=report_versions.listing(case_id);self.assertEqual(listing['versions'][0]['id'],stored['reportId'])
  (root/'synthetic-pdf-fixture.json').write_text(json.dumps({'matchId':mid,'caseId':case_id,'intakeId':intake,
   'version':stored['reportId'],'sha256':metadata['pdfSha256'],'pages':11}))

if __name__=='__main__':unittest.main()
