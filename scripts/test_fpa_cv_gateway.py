"""Gateway authorization, optimistic review storage, deletion, and availability."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

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

    def test_s3_multipart_library_and_owner_checks(self):
        store=Mock();store.begin.return_value='multipart';store.head.return_value={'ContentLength':7}
        store.part_url.return_value='https://s3.example/part';store.url.return_value='https://s3.example/source'
        with patch('app.fpa_cv_uploads.store',return_value=store):
            created=self.client.post('/api/tracking/uploads/multipart',json={'name':'game.mp4','size':7})
            self.assertEqual(created.status_code,201)
            upload=created.json();uid=upload['id'];base=f'/api/tracking/uploads/{uid}'
            self.assertNotIn('key',upload);self.assertNotIn('multipartId',upload)
            self.assertEqual(self.client.get('/api/tracking/uploads',headers={'x-test-user':'other'}).json()['uploads'],[])
            self.assertEqual(self.client.post(base+'/parts',headers={'x-test-user':'other'},json={'parts':[1]}).status_code,404)
            self.assertEqual(self.client.post(base+'/parts',json={'parts':[2]}).status_code,400)
            self.assertEqual(self.client.post(base+'/parts',json={'parts':[1]}).json()['parts'][0]['number'],1)
            self.assertEqual(self.client.get(base+'/source').status_code,409)
            body={'parts':[{'PartNumber':1,'ETag':'"'+'a'*32+'"'}]}
            self.assertEqual(self.client.post(base+'/complete',json={'parts':[]}).status_code,400)
            self.assertEqual(self.client.post(base+'/complete',json=body).json()['status'],'uploaded')
            self.assertEqual(self.client.post(base+'/complete',json=body).status_code,200)
            store.finish.assert_called_once()
            self.assertEqual(self.client.get(base+'/source',follow_redirects=False).headers['location'],'https://s3.example/source')
            self.assertEqual(self.client.post(base+'/remove').status_code,200)
            store.delete.assert_called_once()

    def test_s3_size_mismatch_does_not_mark_uploaded(self):
        store=Mock();store.begin.return_value='multipart';store.head.return_value={'ContentLength':3}
        with patch('app.fpa_cv_uploads.store',return_value=store):
            uid=self.client.post('/api/tracking/uploads/multipart',json={'name':'game.mp4','size':7}).json()['id']
            response=self.client.post(f'/api/tracking/uploads/{uid}/complete',json={'parts':[{'PartNumber':1,'ETag':'a'*32}]})
            self.assertEqual(response.status_code,409)
            self.assertEqual(self.client.get('/api/tracking/uploads').json()['uploads'][0]['status'],'uploading')

    def test_batch_cannot_start_unowned_job_and_upload_with_job_cannot_delete(self):
        with patch('app.fpa_cv_uploads.remote',new_callable=AsyncMock) as remote,patch('app.fpa_cv_uploads.store') as store:
            self.assertEqual(self.client.post('/api/tracking/batch/start',headers={'x-test-user':'other'},json={'ids':[self.job]}).status_code,404)
            self.assertEqual(self.client.post(f'/api/tracking/uploads/{self.upload}/remove').status_code,409)
            remote.assert_not_called();store.assert_not_called()

    def test_s3_assets_require_owner_and_completed_result(self):
        with SessionLocal() as db:
            row=db.get(FpaCvResource,self.upload);row.payload={'key':f'fpa-cv/uploads/{self.upload}/source.mp4'}
            row=db.get(FpaCvResource,self.job);row.payload={**row.payload,'storage':'s3','s3Assets':{'tracks.json':f'fpa-cv/jobs/{self.job}/tracks.json'}};db.commit()
        store=Mock();store.url.return_value='https://s3.example/tracks'
        with patch('app.fpa_cv_storage.storage',return_value=store):
            url=f'/api/tracking/jobs/{self.job}/tracks.json'
            self.assertEqual(self.client.get(url,headers={'x-test-user':'other'}).status_code,404)
            self.assertEqual(self.client.get(url,follow_redirects=False).status_code,307)
            with SessionLocal() as db:
                row=db.get(FpaCvResource,self.job);row.payload={**row.payload,'status':'running'};db.commit()
            self.assertEqual(self.client.get(url).status_code,409)
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
