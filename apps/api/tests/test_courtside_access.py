import time,unittest,uuid
from types import SimpleNamespace
from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import Mock
from app.auth import require_session_user
from app.db import get_db
from app.courtside_access import router,editors_version,record_presence

class CourtsideAccessTests(unittest.TestCase):
 def setUp(self):
  self.id=uuid.uuid4();self.match=SimpleNamespace(id=self.id,sport='BASKETBALL',archived=False,operator_id='owner')
  self.db=SimpleNamespace(get=lambda cls,key:self.match if key==self.id else None)
  self.app=FastAPI();self.app.include_router(router);self.app.dependency_overrides[get_db]=lambda:self.db
  self.client=TestClient(self.app);self.url=f'/api/courtside/matches/{self.id}/access'
 def user(self,id,role):self.app.dependency_overrides[require_session_user]=lambda:SimpleNamespace(id=id,role=role)
 def test_missing_session_rejected(self):self.assertEqual(self.client.get(self.url).status_code,401)
 def test_operator_scope_for_active_and_archived_matches(self):
  self.match.archived=True
  self.user('other','OPERATOR');r=self.client.get(self.url);self.assertEqual(r.status_code,200);self.assertTrue(r.json()['canRead']);self.assertFalse(r.json()['canEdit']);self.assertEqual(r.headers['cache-control'],'private, no-store');self.assertFalse(r.json()['workbenchReady'])
  self.user('owner','OPERATOR');self.assertTrue(self.client.get(self.url).json()['canEdit'])
  self.match.operator_id=None;self.user('other','OPERATOR');self.assertTrue(self.client.get(self.url).json()['canEdit'])
 def test_admin_archived_and_wrong_sport(self):
  self.user('admin','SUPERADMIN');self.assertTrue(self.client.get(self.url).json()['canEdit'])
  self.match.archived=True;self.assertTrue(self.client.get(self.url).json()['canEdit'])
  self.match.sport='FOOTBALL';self.assertEqual(self.client.get(self.url).status_code,404)
  self.assertEqual(self.client.get(f'/api/courtside/matches/{uuid.uuid4()}/access').status_code,404)
 def test_additional_editor_is_match_scoped(self):
  self.db.get=lambda cls,key:self.match if key==self.id else object() if key==(self.id,'teammate') else None
  self.user('teammate','OPERATOR');self.assertTrue(self.client.get(self.url).json()['canEdit'])
  self.user('other','OPERATOR');self.assertFalse(self.client.get(self.url).json()['canEdit'])
  self.assertFalse(self.client.get(self.url).json()['canManageEditors'])
 def test_editor_update_requires_owner_origin_and_current_version(self):
  self.match.metadata_json={'home_team':'A'};self.db.scalar=Mock(return_value=self.match);self.db.scalars=Mock(side_effect=[SimpleNamespace(all=lambda v=v:v) for v in ([],[],['teammate'],['teammate'])]);self.db.commit=Mock();self.db.execute=Mock();self.db.add_all=Mock()
  url=f'/api/courtside/matches/{self.id}/editors';version=editors_version(self.match,[]);payload={'version':version,'editorIds':['teammate']}
  self.user('other','OPERATOR');self.assertEqual(self.client.post(url,json=payload,headers={'origin':'http://testserver'}).status_code,403)
  self.user('owner','OPERATOR');self.assertEqual(self.client.post(url,json=payload,headers={'origin':'http://evil.test'}).status_code,403)
  self.assertEqual(self.client.post(url,json={**payload,'version':'stale'},headers={'origin':'http://testserver'}).status_code,409)
  self.assertEqual(self.client.post(url,json=payload,headers={'origin':'http://testserver'}).status_code,200)
  self.assertEqual(self.match.metadata_json,{'home_team':'A'});self.assertEqual(self.db.add_all.call_args.args[0][0].user_id,'teammate');self.db.commit.assert_called_once()
  self.assertEqual(self.client.post(url,json=payload,headers={'origin':'http://testserver'}).status_code,409)
 def test_recent_presence_uses_session_identity_and_excludes_stale_and_hidden(self):
  db=SimpleNamespace(merge=Mock(),execute=Mock(),commit=Mock());user=SimpleNamespace(id='authenticated-user')
  row={'stage':'spatial','eventId':'review-2','attention':'active','endedAtMs':time.time()*1000}
  record_presence(db,self.id,user,{'userId':'forged','records':[row]})
  saved=db.merge.call_args.args[0];self.assertEqual(saved.user_id,'authenticated-user');self.assertEqual(saved.stage,'spatial');self.assertEqual(saved.event_id,'review-2')
  db.merge.reset_mock();record_presence(db,self.id,user,{'records':[{**row,'endedAtMs':row['endedAtMs']-180000}]});db.merge.assert_not_called()
  record_presence(db,self.id,user,{'records':[{**row,'attention':'hidden'}]});db.merge.assert_not_called()
 def test_editor_list_is_visible_only_to_owner_or_admin(self):
  url=f'/api/courtside/matches/{self.id}/editors';self.user('other','OPERATOR')
  self.assertEqual(self.client.get(url).status_code,403)
  self.user('owner','OPERATOR');self.db.scalars=Mock(side_effect=[SimpleNamespace(all=lambda:[SimpleNamespace(id='u1',name='작업자')]),SimpleNamespace(all=lambda:['u1'])])
  response=self.client.get(url);self.assertEqual(response.status_code,200);self.assertEqual(response.json()['editorIds'],['u1']);self.assertEqual(response.headers['cache-control'],'private, no-store')

if __name__=='__main__':unittest.main()
