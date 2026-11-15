import io,json,tempfile,threading,time,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import pose_variant as variant
from job_store import atomic,digest

class PoseVariantAsyncTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);self.case='case-a';self.event='review-2';self.capture='a'*24
  self.scene={'captureId':self.capture,'state':{'entities':[{'id':'p1','role':'player','x':1,'y':2,'bodyHeading':0}]}}
  self.base={'jobId':'b'*24,'meshSha256':'base-mesh','people':[{'id':'p1'}]}
  self.patcher=patch.dict(variant.case_store.CASES,{self.case:self.root},clear=True);self.patcher.start();self.addCleanup(self.patcher.stop)

 def candidate(self):
  ident='c'*24;assets={'body':{'positions':[1,2,3]}};sha=variant.mesh_digest(assets)
  pose={'variantId':ident,'meshSha256':sha,'people':[{'id':'p1','accepted':True,'meshKey':'body'}],'meshUrl':'/case-pose-variant/case-a/review-2/'+ident+'.json'}
  mesh={'schema':'kbl-mpfb-mesh/v1','geometrySha256':sha,'assets':assets}
  meta={'caseId':self.case,'eventId':self.event,'variantId':ident,'basePoseJobId':self.base['jobId'],'baseMeshSha256':self.base['meshSha256'],
        'sourceCaptureId':self.capture,'stateSignature':variant.state_signature(self.scene['state']),'poseDigest':digest(pose),
        'meshSha256':sha,'selectionVersion':'map-heading-leg-v1','selected':{'p1':{}}}
  p=variant.folder(self.case,self.event,ident);p.mkdir(parents=True)
  for name,value in [('pose.json',pose),('meshes.json',mesh),('meta.json',meta)]:atomic(p/name,value)
  return p,ident

 def test_reuse_requires_exact_scene_and_verified_geometry(self):
  p,ident=self.candidate();result=variant.reusable(self.case,self.event,self.scene,self.base)
  self.assertEqual(result['variantId'],ident);self.assertEqual(result['selectedCount'],1)
  other={**self.scene,'captureId':'f'*24};self.assertIsNone(variant.reusable(self.case,self.event,other,self.base))
  mesh=json.loads((p/'meshes.json').read_text());mesh['assets']['body']['positions'][0]=99;atomic(p/'meshes.json',mesh)
  self.assertIsNone(variant.reusable(self.case,self.event,self.scene,self.base))

 def test_duplicate_submission_reuses_inflight_job_and_completes(self):
  started=threading.Event();release=threading.Event()
  def fake_create(case,event,capture):
   started.set();self.assertTrue(release.wait(5));return {'variantId':'c'*24,'pose':{'meshUrl':'/mesh'},'selectedCount':1,'meshSha256':'hash'}
  with patch('broadcast_reconstruction.current',return_value=self.scene),patch.object(variant,'create',side_effect=fake_create) as create:
   try:
    first=variant.submit(self.case,self.event,self.capture)['job'];self.assertTrue(started.wait(3))
    second=variant.submit(self.case,self.event,self.capture)['job'];self.assertEqual(first['jobId'],second['jobId'])
    self.assertIn(variant.job_status(self.case,self.event,first['jobId'])['state'],('queued','running'))
   finally:release.set()
   for _ in range(100):
    status=variant.job_status(self.case,self.event,first['jobId'])
    if status['state']=='complete':break
    time.sleep(.02)
   self.assertEqual(status['state'],'complete');self.assertEqual(status['result']['variantId'],'c'*24);create.assert_called_once()

 def test_interrupted_job_does_not_claim_completion(self):
  job='d'*24;atomic(variant.job_path(self.case,self.event,job),{'caseId':self.case,'eventId':self.event,'jobId':job,'state':'running'})
  self.assertEqual(variant.job_status(self.case,self.event,job)['state'],'interrupted')
  with self.assertRaises(ValueError):variant.job_status(self.case,'review-3',job)

 def test_stale_capture_never_starts_work(self):
  with patch('broadcast_reconstruction.current',return_value={**self.scene,'captureId':'e'*24}),patch.object(variant,'create') as create:
   with self.assertRaisesRegex(RuntimeError,'변경'):variant.submit(self.case,self.event,self.capture)
   create.assert_not_called()

 def test_submit_endpoint_returns_job_without_waiting_for_fit(self):
  from serve import Handler
  body=json.dumps({'captureId':self.capture}).encode();handler=object.__new__(Handler)
  handler.path='/api/cases/case-a/events/review-2/pose-variant-jobs'
  handler.headers={'Host':'127.0.0.1:4350','Origin':'http://127.0.0.1:4350','Content-Type':'application/json','Content-Length':str(len(body))}
  handler.rfile=io.BytesIO(body);handler.json=Mock()
  with patch('review_flow.require_stage') as stage,patch.object(variant,'submit',return_value={'job':{'jobId':'d'*24}}) as submit:
   handler.post();stage.assert_called_once_with(self.case,'spatial',self.event)
   submit.assert_called_once_with(self.case,self.event,self.capture);handler.json.assert_called_once_with({'job':{'jobId':'d'*24}})

if __name__=='__main__':unittest.main()
