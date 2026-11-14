import hashlib,json,os,tempfile,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.auth import require_session_user
from app.db import get_db
from app import courtside_bridge as bridge

class BridgeTests(unittest.TestCase):
 def test_external_store_allows_only_configured_directory(self):
  with tempfile.TemporaryDirectory() as temp:
   ext=Path(temp);mount=ext/'volume';mount.mkdir();backing=ext/'backing';backing.mkdir();token='a'*32
   (mount/'.fpc-kbl-work-storage').write_text(token);base=mount/'kbl-work/kbl-cases';base.mkdir(parents=True)
   (base/'game1').mkdir();(base/'game1/case.json').write_text('{"id":"game1"}')
   runtime=self.root/'runtime';runtime.mkdir();(runtime/'kbl-storage.json').write_text(json.dumps({'schema':'fpc-kbl-storage/v1','mount':str(mount),'backing':str(backing),'token':token}))
   existing=self.root/'outputs/kbl-cases';existing.rename(existing.with_name('old-cases'));existing.symlink_to(base)
   with patch.object(bridge.os.path,'ismount',return_value=True):
    self.assertEqual(bridge.safe_read(self.root,'outputs/kbl-cases/game1/case.json')['id'],'game1')
    (base/'escape').symlink_to(ext)
    with self.assertRaises(bridge.HTTPException):bridge.safe_read(self.root,'outputs/kbl-cases/escape/secret.json')
    (mount/'.fpc-kbl-work-storage').unlink()
    with self.assertRaises(bridge.HTTPException):bridge.safe_read(self.root,'outputs/kbl-cases/game1/case.json')
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.mid=uuid.uuid4();self.case='game999-synthetic';self.intake='a'*24;self.lib='match-123';self.requests=[]
  def write(rel,data):
   path=self.root/rel;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(data))
  write('outputs/kbl-library/matches.json',{'matches':[{'id':self.lib,'caseId':self.case,'fpcMatchId':str(self.mid),'home':'A','away':'B','date':'2026-01-01'}]})
  write(f'outputs/kbl-cases/{self.case}/case.json',{'id':self.case,'fpcMatchId':str(self.mid),'intakeId':self.intake})
  write(f'outputs/kbl-intake/{self.intake}/intake.json',{'id':self.intake,'linkedCaseId':self.case,'libraryMatchId':self.lib})
  write('outputs/kbl-report-jobs/'+'b'*24+'/status.json',{'caseId':self.case})
  write('outputs/kbl-pose-frames/'+'c'*24+'/status.json',{'clipId':self.case+'-review-1-broadcast'})
  self.env=patch.dict(os.environ,{'COURTSIDE_DATA_ROOT':str(self.root),'COURTSIDE_WORKBENCH_URL':'http://127.0.0.1:4350'});self.env.start()
  self.match=SimpleNamespace(sport='BASKETBALL',archived=False,operator_id='owner',name='Home vs Away',metadata_json={'home_team':'Home','away_team':'Away'});db=SimpleNamespace(get=lambda cls,key:self.match if key==self.mid else None)
  self.app=FastAPI();self.app.include_router(bridge.router);self.app.dependency_overrides[get_db]=lambda:db
  self.client=TestClient(self.app);self.base=f'/api/courtside/matches/{self.mid}/cases/{self.case}/bridge/'
  class MediaStream(httpx.AsyncByteStream):
   async def __aiter__(self):yield b'1234'
  async def upstream(request):
   self.requests.append((request.method,str(request.url),dict(request.headers),await request.aread()))
   if request.url.path=='/api/internal/store-identity':
    st=self.root.stat();return httpx.Response(200,json={'storeIdentity':hashlib.sha256(f'{st.st_dev}:{st.st_ino}'.encode()).hexdigest()})
   if request.url.path=='/api/internal/fpc-intakes':return httpx.Response(200,json={'id':self.intake})
   if request.url.path.endswith('.mjs'):return httpx.Response(200,text="fetch('/api/cases/game999-synthetic');",headers={'content-type':'text/javascript'})
   if request.url.path.endswith('.mp4'):return httpx.Response(206,stream=MediaStream(),headers={'content-type':'video/mp4','content-range':'bytes 0-3/100','accept-ranges':'bytes','content-length':'4'})
   return httpx.Response(200,json={'url':'/pose-assets/'+'c'*24+'/frame.jpg','note':'/api/cases/is a user comment'})
  self.transport=httpx.MockTransport(upstream);self.real_client=httpx.AsyncClient
  self.mock=patch.object(bridge.httpx,'AsyncClient',side_effect=lambda **kw:self.real_client(transport=self.transport,**kw));self.mock.start()
 def tearDown(self):self.mock.stop();self.env.stop();self.tmp.cleanup()
 def user(self,id='owner',role='OPERATOR'):self.app.dependency_overrides[require_session_user]=lambda:SimpleNamespace(id=id,role=role)
 def test_no_session_and_wrong_match_are_denied(self):
  self.assertEqual(self.client.get(self.base+'workflow.html').status_code,401);self.user()
  self.assertEqual(self.client.get(self.base.replace(self.case,'other')+'workflow.html').status_code,404)
 def test_bridge_is_unavailable_without_explicit_worker_configuration(self):
  self.user()
  with patch.dict(os.environ,{'COURTSIDE_DATA_ROOT':'','COURTSIDE_WORKBENCH_URL':''}):
   self.assertEqual(self.client.get(f'/api/courtside/matches/{self.mid}/cases').status_code,503)
 def test_case_list_and_matching_data_paths(self):
  self.user();r=self.client.get(f'/api/courtside/matches/{self.mid}/cases');self.assertEqual(r.status_code,200);self.assertEqual(r.json()['cases'][0]['id'],self.case)
  r=self.client.get(self.base+'api/cases/'+self.case);self.assertEqual(r.status_code,200);self.assertTrue(r.json()['url'].startswith(self.base));self.assertEqual(r.json()['note'],'/api/cases/is a user comment')
  self.assertEqual(self.client.get(self.base+'api/cases/other').status_code,404)
  self.assertEqual(self.client.get(self.base+'api/report-jobs/'+'b'*24).status_code,200)
  self.assertEqual(self.client.get(self.base+'pose-assets/'+'c'*24+'/frame.jpg').status_code,200)
  self.assertEqual(self.client.get(self.base+'pose-assets/'+'d'*24+'/frame.jpg').status_code,404)
  self.assertEqual(self.client.get(self.base+'case-report/'+self.case+'.pdf').status_code,200)
  self.assertEqual(self.client.get(self.base+'case-report/other.pdf').status_code,404)
  video='case-review-video/'+self.case+'/review-1/'+'a'*24+'.mp4'
  result=self.client.get(self.base+video,headers={'Range':'bytes=0-3'})
  self.assertEqual(result.status_code,206);self.assertEqual(result.content,b'1234')
  self.assertEqual(result.headers['cache-control'],'private, no-store')
  self.assertEqual(self.client.get(self.base+video.replace(self.case,'other')).status_code,404)
 def test_operator_permissions_origin_and_global_gpu_are_enforced(self):
  self.user('other');self.assertEqual(self.client.post(self.base+'api/cases/'+self.case,headers={'origin':'http://testserver'},json={}).status_code,403)
  self.user('owner');self.assertEqual(self.client.post(self.base+'api/cases/'+self.case,headers={'origin':'http://evil.test'},json={}).status_code,403)
  self.assertEqual(self.client.post(self.base+'api/gpu/start',headers={'origin':'http://testserver'},json={'action':'start'}).status_code,404)
  self.assertEqual(self.client.post(self.base+'api/cases/'+self.case,headers={'origin':'http://testserver'},json={'ok':True}).status_code,200)
  self.assertEqual(self.requests[-1][2]['origin'],'http://127.0.0.1:4350');self.assertNotIn('cookie',self.requests[-1][2])
 def test_range_and_static_url_rewrite(self):
  self.user();r=self.client.get(self.base+'case-assets/'+self.case+'/broadcast/a.mp4',headers={'range':'bytes=0-3'});self.assertEqual((r.status_code,r.content),(206,b'1234'));self.assertEqual(r.headers['content-range'],'bytes 0-3/100');self.assertEqual(self.requests[-1][2]['range'],'bytes=0-3')
  r=self.client.get(self.base+'workflow.mjs');self.assertIn(self.base+'api/cases/',r.text)
  self.assertIn(self.base+'case-review-video/',bridge.rewrite_text('a.href=`/case-review-video/${caseId}`',self.base.rstrip('/')))
 def test_corrected_pose_mesh_is_rewritten_and_bound_to_case(self):
  self.user();asset=f'case-pose-variant/{self.case}/review-1/'+('d'*24)+'.json'
  self.assertEqual(bridge.rewrite_json({'meshUrl':'/'+asset},self.base.rstrip('/'))['meshUrl'],self.base+asset)
  self.assertEqual(self.client.get(self.base+asset).status_code,200)
  self.assertEqual(self.client.get(self.base+asset.replace(self.case,'other')).status_code,404)
  self.assertEqual(self.client.post(self.base+asset,headers={'origin':'http://testserver'}).status_code,404)
 def test_link_mismatch_and_non_loopback_are_denied(self):
  self.user();p=self.root/f'outputs/kbl-intake/{self.intake}/intake.json';d=json.loads(p.read_text());d['linkedCaseId']='other';p.write_text(json.dumps(d));self.assertEqual(self.client.get(self.base+'workflow.html').status_code,404)
  with patch.dict(os.environ,{'COURTSIDE_WORKBENCH_URL':'http://example.com'}):self.assertEqual(self.client.get(f'/api/courtside/matches/{self.mid}/cases').status_code,503)
 def test_different_store_blocks_before_any_case_request(self):
  self.user()
  async def wrong(request):
   self.assertEqual(request.url.path,'/api/internal/store-identity');return httpx.Response(200,json={'storeIdentity':'different'})
  with patch.object(bridge.httpx,'AsyncClient',side_effect=lambda **kw:self.real_client(transport=httpx.MockTransport(wrong),**kw)):
   self.assertEqual(self.client.get(self.base+'api/cases/'+self.case).status_code,503)
 def test_gpu_handoff_is_disabled_until_explicitly_enabled(self):
  self.user();path=self.base+'api/intake/'+self.intake+'/handoff'
  with patch.dict(os.environ,{'COURTSIDE_ALLOW_GPU_ACTIONS':'0'}):
   self.assertEqual(self.client.post(path,headers={'origin':'http://testserver'},json={}).status_code,503)
  with patch.dict(os.environ,{'COURTSIDE_ALLOW_GPU_ACTIONS':'1'}):
   self.assertEqual(self.client.post(path,headers={'origin':'http://testserver'},json={}).status_code,200)
 def test_invalid_store_identity_fails_closed(self):
  self.user()
  async def wrong(request):return httpx.Response(200,json=[])
  with patch.object(bridge.httpx,'AsyncClient',side_effect=lambda **kw:self.real_client(transport=httpx.MockTransport(wrong),**kw)):
   self.assertEqual(self.client.get(self.base+'api/cases/'+self.case).status_code,503)
 def test_library_case_history_preserves_old_case_access(self):
  self.user();p=self.root/'outputs/kbl-library/matches.json';d=json.loads(p.read_text());d['matches'][0]['caseIds']=[self.case,'new-case'];d['matches'][0]['caseId']='new-case';p.write_text(json.dumps(d))
  r=self.client.get(f'/api/courtside/matches/{self.mid}/cases');self.assertEqual(r.status_code,200);self.assertEqual([x['id'] for x in r.json()['cases']],[self.case])
  self.assertEqual(self.client.get(self.base+'api/cases/'+self.case).status_code,200)
 def test_intake_is_match_scoped_and_resume_is_authorized(self):
  self.user();base=f'/api/courtside/matches/{self.mid}/intakes'
  self.assertEqual(self.client.post(base,json={'csvText':'x','media':[]}).status_code,403)
  self.assertEqual(self.client.post(base,headers={'origin':'http://testserver'},json={'csvText':'x','media':[],'fpcMatchId':'other'}).status_code,400)
  self.assertEqual(self.client.post(base,headers={'origin':'http://testserver'},json={'csvText':'x','media':[]}).status_code,409)
  r=self.client.post(base,headers={'origin':'http://testserver'},json={'csvText':'x','media':[],'confirmUnverifiedDate':True});self.assertEqual(r.status_code,200);self.assertEqual(r.json()['id'],self.intake)
  sent=json.loads(self.requests[-1][3]);self.assertEqual(sent['fpcMatchId'],str(self.mid));self.assertEqual((sent['home'],sent['away']),('Home','Away'))
  self.assertEqual(self.client.get(base).json()['intakes'][0]['id'],self.intake)
  draft=base+'/'+self.intake+'/bridge/'
  self.assertEqual(self.client.get(draft+'api/intake/'+self.intake).status_code,200)
  self.assertEqual(self.client.get(draft+'api/intake/'+'b'*24).status_code,404)
  self.assertEqual(self.client.get(draft+'api/cases/other').status_code,404)
  self.user('other');self.assertEqual(self.client.post(base,headers={'origin':'http://testserver'},json={'csvText':'x','media':[]}).status_code,403)

 def test_selected_recording_copy_is_opt_in_and_match_scoped(self):
  sid=uuid.uuid4();name='take-00001-part-000001.mp4'
  path=f'/api/courtside/matches/{self.mid}/intakes/{self.intake}/recording-sessions/{sid}/parts/{name}/prepare'
  self.user('other')
  with patch.dict(os.environ,{'COURTSIDE_ALLOW_RECORDING_RELAY':'1','HIGHLIGHT_S3_BUCKET':'test'}):
   self.assertEqual(self.client.post(path,headers={'origin':'http://testserver'}).status_code,403)
  self.user('owner')
  with patch.dict(os.environ,{'COURTSIDE_ALLOW_RECORDING_RELAY':'0'}):
   self.assertEqual(self.client.post(path,headers={'origin':'http://testserver'}).status_code,503)
  result={'sessionId':str(sid),'partName':name,'bytes':4,'sha256':'a'*64}
  with patch.dict(os.environ,{'COURTSIDE_ALLOW_RECORDING_RELAY':'1','HIGHLIGHT_S3_BUCKET':'test'}),\
       patch.object(bridge,'_recording_relay_guard',side_effect=lambda root:os.open(root,os.O_RDONLY)),\
       patch.object(bridge,'_recording_s3_client',return_value='mock-client'),\
       patch('app.courtside_recording_source.copy_part_to_shared_store',return_value=result) as copy:
   self.assertEqual(self.client.post(path,headers={'origin':'http://evil.test'}).status_code,403)
   response=self.client.post(path,headers={'origin':'http://testserver'})
   self.assertEqual(response.status_code,200);self.assertEqual(response.json()['status'],'stored-unpaired')
   copy.assert_called_once();self.assertEqual(copy.call_args.args,('mock-client','test',self.root.resolve(),self.mid,self.intake,sid,name))
   self.assertTrue(callable(copy.call_args.kwargs['on_space_pressure']))

 def test_explicit_public_origin_supports_proxy_without_trusting_forwarded_host(self):
  self.user();path=self.base+'api/intake/'+self.intake+'/handoff'
  with patch.dict(os.environ,{'COURTSIDE_ALLOW_GPU_ACTIONS':'1','COURTSIDE_PUBLIC_ORIGIN':'https://console.example.test'}):
   self.assertEqual(self.client.post(path,headers={'origin':'https://console.example.test','x-forwarded-host':'attacker.test'},json={}).status_code,200)
   self.assertEqual(self.client.post(path,headers={'origin':'https://attacker.test','x-forwarded-host':'console.example.test'},json={}).status_code,403)
  with patch.dict(os.environ,{'COURTSIDE_ALLOW_GPU_ACTIONS':'1','COURTSIDE_PUBLIC_ORIGIN':'https://example.test/other'}):
   self.assertEqual(self.client.post(path,headers={'origin':'https://example.test'},json={}).status_code,503)

if __name__=='__main__':unittest.main()
