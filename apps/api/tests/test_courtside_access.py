import unittest,uuid
from types import SimpleNamespace
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.auth import require_session_user
from app.db import get_db
from app.courtside_access import router

class CourtsideAccessTests(unittest.TestCase):
 def setUp(self):
  self.id=uuid.uuid4();self.match=SimpleNamespace(sport='BASKETBALL',archived=False,operator_id='owner')
  self.db=SimpleNamespace(get=lambda cls,key:self.match if key==self.id else None)
  self.app=FastAPI();self.app.include_router(router);self.app.dependency_overrides[get_db]=lambda:self.db
  self.client=TestClient(self.app);self.url=f'/api/courtside/matches/{self.id}/access'
 def user(self,id,role):self.app.dependency_overrides[require_session_user]=lambda:SimpleNamespace(id=id,role=role)
 def test_missing_session_rejected(self):self.assertEqual(self.client.get(self.url).status_code,401)
 def test_operator_scope_matches_recording_policy(self):
  self.user('other','OPERATOR');r=self.client.get(self.url);self.assertEqual(r.status_code,200);self.assertTrue(r.json()['canRead']);self.assertFalse(r.json()['canEdit']);self.assertEqual(r.headers['cache-control'],'private, no-store');self.assertFalse(r.json()['workbenchReady'])
  self.user('owner','OPERATOR');self.assertTrue(self.client.get(self.url).json()['canEdit'])
  self.match.operator_id=None;self.user('other','OPERATOR');self.assertTrue(self.client.get(self.url).json()['canEdit'])
 def test_admin_archived_and_wrong_sport(self):
  self.user('admin','SUPERADMIN');self.assertTrue(self.client.get(self.url).json()['canEdit'])
  self.match.archived=True;self.assertFalse(self.client.get(self.url).json()['canEdit'])
  self.match.sport='FOOTBALL';self.assertEqual(self.client.get(self.url).status_code,404)
  self.assertEqual(self.client.get(f'/api/courtside/matches/{uuid.uuid4()}/access').status_code,404)

if __name__=='__main__':unittest.main()
