"""Exercise new video endpoints using a disposable local database, never AWS."""
import os
os.environ['DATABASE_URL']='sqlite:////tmp/fla-test-unused-engine.db'
import unittest
from uuid import uuid4
from types import SimpleNamespace
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
@compiles(JSONB,'sqlite')
def sqlite_json(type_,compiler,**kw):return 'JSON'
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.db import Base,get_db
from app.models import User,Match,Event,State,PossessionSegment,DominanceBin,FpaCvResource
from app.auth import require_session_user
from app.futsal_fla_video import create_router,FIXTURES,candidates

class FlaVideoTests(unittest.TestCase):
    def setUp(self):
        self.engine=create_engine('sqlite://',connect_args={'check_same_thread':False},poolclass=StaticPool)
        Base.metadata.create_all(self.engine,tables=[m.__table__ for m in (User,Match,Event,State,PossessionSegment,DominanceBin,FpaCvResource)])
        self.Session=sessionmaker(bind=self.engine);self.user=User(id='local-test',role='SUPERADMIN',name='test')
        self.id=uuid4();self.client_id=str(uuid4())
        with self.Session() as db:
            db.add(User(id=self.user.id,role='SUPERADMIN',name='test'))
            db.add(Match(id=self.id,name='test',sport='FUTSAL',metadata_json={}))
            db.add(FpaCvResource(id='upload',kind='upload',owner_id=self.user.id,payload={'status':'uploaded','name':'test.mp4'}));db.commit()
        def database():
            with self.Session() as db:yield db
        app=FastAPI();app.dependency_overrides[get_db]=database;app.dependency_overrides[require_session_user]=lambda:self.user;app.include_router(create_router())
        self.client=TestClient(app);self.base=f'/api/futsal/fla-video/matches/{self.id}'
        r=self.client.put(self.base+'/config',json={'upload_id':'upload','offset_ms':5000,'duration_ms':90000,'version':0});self.assertEqual(r.status_code,200,r.text)
        self.version=1
    def tearDown(self):self.client.close();self.engine.dispose()
    def update(self,**overrides):
        body=dict(request_id=str(uuid4()),client_id=self.client_id,version=self.version,action='save',cursor_ms=0,frontier_ms=0,possession_team='HOME',selected_team='HOME',direction='L2R',rate=1,segments=[]);body.update(overrides)
        result=self.client.post(self.base+'/recording',json=body)
        if result.status_code==200:self.version=result.json()['state']['version']
        return result,body
    def test_replay_events_are_saved_without_double_counting_possession(self):
        r,_=self.update(action='start');self.assertEqual(r.status_code,200,r.text)
        r,body=self.update(cursor_ms=2000,frontier_ms=2000,segments=[dict(start_ms=0,end_ms=2000,team='HOME')]);self.assertEqual(r.status_code,200,r.text)
        retry=self.client.post(self.base+'/recording',json=body);self.assertEqual(retry.status_code,200);self.assertEqual(retry.json()['possession']['HOME'],2000)
        r,_=self.update(cursor_ms=500,frontier_ms=2000,selected_team='AWAY');self.assertEqual(r.status_code,200,r.text)
        payload=dict(event_id=str(uuid4()),client_id=self.client_id,type='ATTACK_LANE',clock_ms=500,team='AWAY',lane='LEFT')
        for _ in range(2):r=self.client.post(self.base+'/events',json=payload);self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(len(r.json()['events']),1);self.assertEqual(r.json()['possession']['HOME'],2000)
        r,_=self.update(cursor_ms=1000,frontier_ms=2000,action='finish');self.assertEqual(r.status_code,200,r.text)
        r,_=self.update(cursor_ms=3000,frontier_ms=3000,segments=[dict(start_ms=2000,end_ms=3000,team='AWAY')]);self.assertEqual(r.status_code,409)
    def test_bad_intervals_future_events_and_conflicting_writer_are_rejected(self):
        self.update(action='start')
        for start in (1,1000):
            r,_=self.update(cursor_ms=2000,frontier_ms=2000,segments=[dict(start_ms=start,end_ms=2000,team='HOME')]);self.assertEqual(r.status_code,400,r.text)
        r,_=self.update(cursor_ms=60000,frontier_ms=60000,segments=[dict(start_ms=0,end_ms=60000,team='HOME')]);self.assertEqual(r.status_code,400)
        r,_=self.update(client_id=str(uuid4()));self.assertEqual(r.status_code,409)
        r,_=self.update(version=0);self.assertEqual(r.status_code,409)
        r=self.client.post(self.base+'/events',json=dict(event_id=str(uuid4()),client_id=self.client_id,type='ATTACK_LANE',clock_ms=1,team='HOME',lane='CENTER'));self.assertEqual(r.status_code,400)
    def test_reset_preserves_video_frontier_and_allows_explicit_start_reconfiguration(self):
        self.update(action='start')
        self.update(cursor_ms=2000,frontier_ms=2000,segments=[dict(start_ms=0,end_ms=2000,team='HOME')])
        payload=dict(event_id=str(uuid4()),client_id=self.client_id,type='XG',clock_ms=1000,team='AWAY',xg=.24)
        r=self.client.post(self.base+'/events',json=payload);self.assertEqual(r.status_code,200,r.text)
        for kind in ('possession','events','recording'):
            payload=dict(request_id=str(uuid4()),client_id=self.client_id,version=self.version,kind=kind)
            r=self.client.post(self.base+'/reset',json=payload);self.assertEqual(r.status_code,200,r.text)
            self.version=r.json()['state']['version']
            retry=self.client.post(self.base+'/reset',json=payload);self.assertEqual(retry.json()['state']['version'],self.version)
            if kind=='possession':
                self.assertEqual(r.json()['possession']['HOME'],0);self.assertEqual(r.json()['state']['frontier_ms'],2000);self.assertEqual(len(r.json()['events']),1)
            if kind=='events':self.assertEqual(len(r.json()['events']),0);self.assertEqual(r.json()['state']['frontier_ms'],2000)
        self.assertFalse(r.json()['state']['started']);self.assertEqual(r.json()['state']['frontier_ms'],0)
        r=self.client.put(self.base+'/config',json=dict(upload_id='upload',offset_ms=12000,duration_ms=90000,version=self.version));self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['state']['offset_ms'],12000)

    def test_fixtures_and_strict_ordered_filename_matching(self):
        self.assertEqual(len(FIXTURES),39);self.assertEqual(sum(f['stage']=='정규' for f in FIXTURES),17)
        f=next(f for f in FIXTURES if f['stage']=='정규' and f['home']=='경남' and f['away']=='대구')
        uploads=[SimpleNamespace(id='ok',payload={'name':'1경기 경남 대구.MP4'}),SimpleNamespace(id='reverse',payload={'name':'1경기 대구 vs 경남.MP4'})]
        self.assertEqual(candidates(f,uploads),['ok'])
        for _ in range(2):self.assertEqual(self.client.post('/api/futsal/fla-video/fixtures/create').status_code,200)
        with self.Session() as db:self.assertEqual(db.query(Match).count(),40)
    def test_shot_coordinates_and_upload_access(self):
        self.update(action='start')
        payload=dict(event_id=str(uuid4()),client_id=self.client_id,type='XG',clock_ms=0,team='HOME',shot_x=38,shot_y=10,is_goal=True,goalmouth_x=.9,goalmouth_y=.8,xg=.36)
        r=self.client.post(self.base+'/events',json=payload);self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['events'][0]['xg'],.36);self.assertEqual(r.json()['events'][0]['goalmouth_x'],.9);self.assertEqual(r.json()['events'][0]['shot_x'],38)
        payload.update(event_id=str(uuid4()),shot_x=5)
        self.assertEqual(self.client.post(self.base+'/events',json=payload).status_code,422)
        self.user=User(id='outsider',role='OPERATOR',name='test')
        self.assertEqual(self.client.get('/api/futsal/fla-video/uploads/upload/source').status_code,404)

if __name__=='__main__':unittest.main()
