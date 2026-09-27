"""Gateway authorization, optimistic review storage, deletion, and availability."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

TEMP=tempfile.TemporaryDirectory()
os.environ['DATABASE_URL']='sqlite:///'+str(Path(TEMP.name)/'test.db')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'apps/api'))
from fastapi import FastAPI, Header
from fastapi.testclient import TestClient
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from app.db import Base, engine, SessionLocal
from app.models import User, FpaCvResource
from app.auth import require_session_user
from app.fpa_cv import router

@compiles(JSONB,'sqlite')
def json_type(element,compiler,**kw):return 'JSON'

class GatewayTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.create_all(engine,tables=[User.__table__,FpaCvResource.__table__])
        self.app=FastAPI();self.app.include_router(router)
        self.client=TestClient(self.app)
        self.job='a'*32;self.upload='b'*32
        with SessionLocal() as db:
            db.add(User(id='owner',name='owner',role='OPERATOR'));db.add(User(id='other',name='other',role='OPERATOR'))
            db.add(FpaCvResource(id=self.upload,kind='upload',owner_id='owner',payload={}))
            db.add(FpaCvResource(id=self.job,kind='job',owner_id='owner',payload={'id':self.job,'uploadId':self.upload,'datasetId':'dataset','status':'completed'}));db.commit()
        def user(x_test_user: str=Header(default='owner')):return User(id=x_test_user,name=x_test_user,role='OPERATOR')
        self.app.dependency_overrides[require_session_user]=user
    def tearDown(self):
        self.client.close();Base.metadata.drop_all(engine,tables=[FpaCvResource.__table__,User.__table__])
    def test_requires_login_and_ownership(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.client.get('/api/tracking/jobs').status_code,401)
    def test_review_version_and_owner(self):
        url=f'/api/tracking/jobs/{self.job}/review'
        self.assertEqual(self.client.get(url,headers={'x-test-user':'other'}).status_code,404)
        body={'version':0,'review':{'datasetId':'dataset','checkpoints':[1]}}
        self.assertEqual(self.client.put(url,json=body).json(),{'version':1})
        self.assertEqual(self.client.put(url,json=body).status_code,409)
        body['version']=1;body['review']['datasetId']='wrong'
        self.assertEqual(self.client.put(url,json=body).status_code,400)
        self.assertEqual(self.client.get(url).json()['review']['checkpoints'],[1])
    def test_foreign_origin_and_unowned_creation_do_not_reach_worker(self):
        with patch('app.fpa_cv.remote',new_callable=AsyncMock) as remote:
            self.assertEqual(self.client.post('/api/tracking/preparations',json={'uploadId':self.upload},headers={'Origin':'https://attacker.invalid'}).status_code,403)
            self.assertEqual(self.client.post('/api/tracking/preparations',json={'uploadId':self.upload},headers={'x-test-user':'other'}).status_code,404)
            remote.assert_not_called()
    def test_purge_removes_server_review_and_last_upload_record(self):
        with patch('app.fpa_cv.remote',new_callable=AsyncMock,return_value={'id':self.job,'purged':True,'sourceDeleted':True}):
            self.assertEqual(self.client.post(f'/api/tracking/jobs/{self.job}/purge').status_code,200)
        self.assertEqual(self.client.get(f'/api/tracking/jobs/{self.job}/review').status_code,404)
        with SessionLocal() as db:self.assertIsNone(db.get(FpaCvResource,self.upload))
    def test_disconnected_gpu_is_not_reported_ready(self):
        with patch.dict(os.environ,{'FPA_CV_WORKER_URL':'','FPA_CV_WORKER_TOKEN':''}):
            data=self.client.get('/api/tracking/capabilities').json()
            self.assertFalse(data['ready']);self.assertEqual(data['execution'],'aws');self.assertEqual(data['reviewStorage'],'server')
    def test_public_origin_behind_cloudfront_can_check_and_upload(self):
        headers={'Host':'ec2-origin.internal','Origin':'https://console.fineludens.kr'}
        with patch.dict(os.environ,{'FPA_CV_ALLOWED_ORIGINS':'https://console.fineludens.kr'}), patch('app.fpa_cv.remote',new_callable=AsyncMock) as remote:
            remote.return_value={'ready':True}
            self.assertEqual(self.client.post('/api/tracking/uploads/check',headers=headers,json={}).json(),{'ready':True})
            remote.assert_awaited_once_with('capabilities')
            remote.return_value={'id':'c'*32}
            result=self.client.post('/api/tracking/uploads?name=test.mp4',headers={**headers,'Content-Type':'application/octet-stream'},content=b'test-video')
            self.assertEqual(result.status_code,201)
        with SessionLocal() as db:self.assertEqual(db.get(FpaCvResource,'c'*32).owner_id,'owner')
    def test_upload_check_rejects_untrusted_origin_even_with_forwarded_host(self):
        with patch.dict(os.environ,{'FPA_CV_ALLOWED_ORIGINS':'https://console.fineludens.kr'}), patch('app.fpa_cv.remote',new_callable=AsyncMock) as remote:
            for origin in ['https://attacker.invalid','https://console.fineludens.kr.attacker.invalid','null']:
                response=self.client.post('/api/tracking/uploads/check',headers={'Host':'ec2-origin.internal','Origin':origin,'X-Forwarded-Host':'console.fineludens.kr'})
                self.assertEqual(response.status_code,403)
            remote.assert_not_called()
    def test_upload_check_rejects_expired_session_and_unready_worker(self):
        with patch('app.fpa_cv.remote',new_callable=AsyncMock,return_value={'ready':False}) as remote:
            self.assertEqual(self.client.post('/api/tracking/uploads/check').status_code,503)
            remote.reset_mock()
            self.app.dependency_overrides.clear()
            self.assertEqual(self.client.post('/api/tracking/uploads/check').status_code,401)
            remote.assert_not_called()

if __name__=='__main__':unittest.main()
