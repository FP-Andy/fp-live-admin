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

    def substitution_log(self):
        return {'schema':'fpa-substitution-log/v1','video':{'name':'test.mp4','duration':90,'from':5,'to':90},
                'players':[{'id':'a','team':'home','name':'A','jersey':'7'},{'id':'b','team':'home','name':'B','jersey':'8'}],
                'initialPlayers':['a'],'substitutions':[]}
    def save_log(self,log,revision=None,request_id=None,client_id=None):
        if revision is None:revision=self.client.get(self.base).json()['substitutions']['revision']
        payload={'log':log,'revision':revision,'request_id':request_id or str(uuid4()),'client_id':client_id or self.client_id}
        return self.client.put(self.base+'/substitutions',json=payload)
    def test_substitutions_reentry_roundtrip_retry_and_possession_isolation(self):
        log=self.substitution_log()
        r=self.save_log(log);self.assertEqual(r.status_code,200,r.text)
        self.update(action='start')
        self.update(cursor_ms=2000,frontier_ms=2000,segments=[dict(start_ms=0,end_ms=2000,team='HOME')])
        log['substitutions']=[dict(id='s1',time=5.5,team='home',outId='a',inId='b',note='OUT'),dict(id='s2',time=7,team='home',outId='b',inId='a',note='재출전')]
        revision=r.json()['substitutions']['revision'];request_id=str(uuid4())
        r=self.save_log(log,revision,request_id);self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(self.save_log(log,revision,request_id).json(),r.json())
        restored=self.client.get(self.base).json()
        self.assertEqual(restored['substitutions']['log'],log)
        self.assertEqual(restored['possession']['HOME'],2000)
        self.assertEqual(restored['events'],[])
        self.assertEqual(restored['state']['version'],self.version)
        self.assertEqual(self.save_log(log,revision).status_code,409)
    def test_substitution_validation_future_wrong_video_and_revision(self):
        log=self.substitution_log();self.update(action='start')
        self.update(cursor_ms=2000,frontier_ms=2000,segments=[dict(start_ms=0,end_ms=2000,team='HOME')])
        for event in [dict(id='future',time=7.001,team='home',outId='a',inId='b',note=''),dict(id='bench',time=6,team='home',outId='b',inId='a',note=''),dict(id='self',time=6,team='home',outId='a',inId='a',note='')]:
            log['substitutions']=[event];self.assertEqual(self.save_log(log).status_code,400)
        log['substitutions']=[];log['video']['name']='other.mp4';self.assertEqual(self.save_log(log).status_code,400)
        log['video']['name']='test.mp4'
        self.assertEqual(self.save_log(log,client_id=str(uuid4())).status_code,200)
        self.assertEqual(self.save_log(log,revision=0).status_code,409)
        log['initialPlayers']=['a','a'];self.assertEqual(self.save_log(log).status_code,400)
        log['initialPlayers']=['a'];log['players'][1]['jersey']='007';self.assertEqual(self.save_log(log).status_code,400)
        self.assertEqual(self.client.get(self.base).json()['substitutions']['log']['substitutions'],[])
    def test_substitution_reset_and_config_invalidate_old_log_revisions(self):
        log=self.substitution_log();r=self.save_log(log);self.assertEqual(r.status_code,200,r.text)
        revision=r.json()['substitutions']['revision']
        r=self.client.put(self.base+'/config',json=dict(upload_id='upload',offset_ms=6000,duration_ms=90000,version=self.version));self.assertEqual(r.status_code,200,r.text)
        self.assertIsNone(r.json()['substitutions']['log']);self.assertGreater(r.json()['substitutions']['revision'],revision)
        self.assertEqual(self.save_log(log,revision).status_code,409)
        self.version=r.json()['state']['version'];log['video']['from']=6
        self.assertEqual(self.save_log(log).status_code,200)
        self.update(action='start')
        for kind in ['events','recording']:
            r=self.client.post(self.base+'/reset',json=dict(request_id=str(uuid4()),client_id=self.client_id,version=self.version,kind=kind));self.assertEqual(r.status_code,200,r.text)
            self.version=r.json()['state']['version']
            if kind=='events':self.assertIsNotNone(r.json()['substitutions']['log'])
            else:self.assertIsNone(r.json()['substitutions']['log'])
    def test_saving_unchanged_kickoff_preserves_the_roster(self):
        log=self.substitution_log();r=self.save_log(log);revision=r.json()['substitutions']['revision']
        r=self.client.put(self.base+'/config',json=dict(upload_id='upload',offset_ms=5000,duration_ms=90000,version=self.version))
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['substitutions'],{'revision':revision,'log':log})

    def test_time_only_substitutions_without_player_assignment(self):
        log=self.substitution_log();log.update(schema='fpa-substitution-log/v2',players=[],initialPlayers=[])
        self.update(action='start')
        self.update(cursor_ms=2000,frontier_ms=2000,segments=[dict(start_ms=0,end_ms=2000,team='HOME')])
        before=self.client.get(self.base).json()
        log['substitutions']=[dict(id='h',time=6,team='home',note=''),dict(id='a',time=7,team='away',note='')]
        r=self.save_log(log);self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['substitutions']['log'],log)
        restored=self.client.get(self.base).json()
        self.assertEqual(restored['possession'],before['possession'])
        self.assertEqual(restored['events'],before['events'])
        self.assertEqual(restored['state']['version'],before['state']['version'])
        self.assertEqual(restored['substitutions']['log']['players'],[])
        original=log['substitutions'].copy()
        for cue in [dict(id='dup',time=6,team='home',note=''),dict(id='future',time=7.1,team='home',note=''),dict(id='partial',time=6.5,team='home',outId='a',note='')]:
            log['substitutions']=original+[cue]
            self.assertEqual(self.save_log(log).status_code,400)
        log['substitutions']=original;log['schema']='fpa-substitution-log/v1'
        self.assertEqual(self.save_log(log).status_code,400,'Legacy malformed pairs must not be silently converted')

    def test_completed_recording_can_add_edit_delete_substitutions_without_reopening(self):
        self.update(action='start')
        self.update(cursor_ms=2000,frontier_ms=2000,segments=[dict(start_ms=0,end_ms=2000,team='HOME')])
        self.update(action='finish',cursor_ms=2000,frontier_ms=2000)
        before=self.client.get(self.base).json()
        with self.Session() as db:
            metadata=dict(db.get(Match,self.id).metadata_json)
            state_count=db.query(State).count()
        log=self.substitution_log();log.update(schema='fpa-substitution-log/v2',players=[],initialPlayers=[])
        # Final whistle/archival frontier need not span the entire source clip.
        log['substitutions']=[dict(id='h',time=25,team='home',note='')]
        for note in ['', '시각 검수 완료']:
            log['substitutions'][0]['note']=note
            self.assertEqual(self.save_log(log,client_id=str(uuid4())).status_code,200)
        restored=self.client.get(self.base).json()
        self.assertTrue(restored['state']['ended'])
        for key in ['state','events','segments','possession']:
            self.assertEqual(restored[key],before[key])
        log['substitutions']=[];self.assertEqual(self.save_log(log).status_code,200)
        with self.Session() as db:
            self.assertEqual(db.get(Match,self.id).metadata_json['fla_video'],metadata['fla_video'])
            self.assertEqual(db.query(State).count(),state_count)

    def test_archived_dashboard_match_can_log_source_time_without_video_start(self):
        with self.Session() as db:
            match=db.get(Match,self.id);match.archived=True
            match.metadata_json={**match.metadata_json,'fla_video':{'upload_id':'upload','configured':False,'duration_ms':0,'offset_ms':0,'started':False,'ended':False}}
            db.add(Event(id=uuid4(),match_id=self.id,type='XG',clock_ms=1000,team='HOME',xg=.4))
            db.commit()
        before=self.client.get(self.base).json()
        self.assertFalse(before['can_write']);self.assertTrue(before['can_write_substitutions'])
        log=self.substitution_log();log.update(schema='fpa-substitution-log/v2',players=[],initialPlayers=[]);log['video']['from']=0
        log['substitutions']=[dict(id='a',time=35,team='away',note='교체')]
        self.assertEqual(self.save_log(log).status_code,200)
        restored=self.client.get(self.base).json()
        for key in ['match','state','events','segments','possession']:
            self.assertEqual(restored[key],before[key])
        self.assertEqual(restored['substitutions']['log'],log)
        log['substitutions'][0]['time']=40
        self.assertEqual(self.save_log(log).status_code,200)
        log['substitutions']=[]
        self.assertEqual(self.save_log(log).status_code,200)
        self.assertEqual(self.update(action='start')[0].status_code,403)
        self.assertEqual(self.client.post(self.base+'/events',json=dict(event_id=str(uuid4()),client_id=self.client_id,type='ATTACK_LANE',clock_ms=1000,team='HOME',lane='CENTER')).status_code,403)
        self.assertEqual(self.client.post(self.base+'/reset',json=dict(request_id=str(uuid4()),client_id=self.client_id,version=self.version,kind='recording')).status_code,403)

    def test_source_only_log_locks_video_bounds_and_retains_write_permissions(self):
        self.client.put(self.base+'/video',json={'upload_id':'upload','version':self.version})
        log=self.substitution_log();log.update(schema='fpa-substitution-log/v2',players=[],initialPlayers=[]);log['video']['from']=0
        log['substitutions']=[dict(id='h',time=25,team='home',note='')]
        self.assertEqual(self.save_log(log).status_code,200)
        for key,value in [('name','other.mp4'),('duration',91),('from',1),('to',80)]:
            old=log['video'][key];log['video'][key]=value
            self.assertEqual(self.save_log(log).status_code,400)
            log['video'][key]=old
        for time in [90,91]:
            log['substitutions'][0]['time']=time
            self.assertEqual(self.save_log(log).status_code,400)
        log['substitutions'][0]['time']=25
        with self.Session() as db:
            db.add(User(id='owner',role='OPERATOR',name='owner'))
            match=db.get(Match,self.id);match.archived=True;match.operator_id='owner';db.commit()
        self.user=User(id='other',role='OPERATOR',name='other')
        self.assertFalse(self.client.get(self.base).json()['can_write_substitutions'])
        self.assertEqual(self.save_log(log).status_code,403)
        self.user=User(id='owner',role='OPERATOR',name='owner')
        self.assertTrue(self.client.get(self.base).json()['can_write_substitutions'])
        self.assertEqual(self.save_log(log).status_code,404,'Source-video access is still required')

    def test_fixtures_and_strict_ordered_filename_matching(self):
        self.assertEqual(len(FIXTURES),39);self.assertEqual(sum(f['stage']=='정규' for f in FIXTURES),17)
        f=next(f for f in FIXTURES if f['stage']=='정규' and f['home']=='경남' and f['away']=='대구')
        uploads=[SimpleNamespace(id='ok',payload={'name':'1경기 경남 대구.MP4'}),SimpleNamespace(id='reverse',payload={'name':'1경기 대구 vs 경남.MP4'})]
        self.assertEqual(candidates(f,uploads),['ok'])
        for _ in range(2):self.assertEqual(self.client.post('/api/futsal/fla-video/fixtures/create').status_code,200)
        with self.Session() as db:self.assertEqual(db.query(Match).count(),40)
    def test_linked_video_requires_operator_kickoff_before_recording(self):
        r=self.client.put(self.base+'/video',json={'upload_id':'upload','version':self.version})
        self.assertEqual(r.status_code,200,r.text)
        self.version=r.json()['state']['version']
        self.assertEqual(r.json()['state']['duration_ms'],0)
        r,_=self.update(action='start');self.assertEqual(r.status_code,409)
        r=self.client.put(self.base+'/config',json={'upload_id':'upload','offset_ms':5000,'duration_ms':90000,'version':self.version})
        self.assertEqual(r.status_code,200,r.text);self.version=r.json()['state']['version']
        r,_=self.update(action='start');self.assertEqual(r.status_code,200,r.text)
        r=self.client.put(self.base+'/video',json={'upload_id':'upload','version':self.version})
        self.assertEqual(r.status_code,409)
    def test_legacy_original_is_selectable_without_auto_matching(self):
        uid,jid='a'*32,'b'*32
        with self.Session() as db:
            db.add(FpaCvResource(id=uid,kind='upload',owner_id=self.user.id,payload={'name':'DJI_20260912093904_0001_W.MP4','size':1000}))
            db.add(FpaCvResource(id=jid,kind='job',owner_id=self.user.id,payload={'uploadId':uid,'status':'completed','result':{'original':'source'}}))
            db.commit()
        listing=self.client.get('/api/futsal/fla-video/fixtures').json()
        self.assertTrue(next(u for u in listing['uploads'] if u['id']==uid)['legacy'])
        self.assertTrue(all(uid not in f['candidates'] for f in listing['fixtures']))
        r=self.client.get(f'/api/futsal/fla-video/uploads/{uid}/source',follow_redirects=False)
        self.assertEqual(r.status_code,307);self.assertEqual(r.headers['location'],f'/api/tracking/jobs/{jid}/source')
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
