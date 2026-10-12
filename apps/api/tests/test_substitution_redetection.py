"""Private evidence persistence, stale geometry, pinning and malformed inputs."""
import copy
import unittest
from uuid import UUID
from unittest.mock import patch
import test_analysis_snapshots as fixture
from app.models import FpaCvResource, Match
from app.fla_substitutions import TrackingResolution
from app.futsal_substitution_redetection import log_context, check_resolution
from fastapi import HTTPException

class Redetection(unittest.TestCase):
    save=fixture.Snapshots.save
    def setUp(self):
        fixture.Snapshots.setUp(self)
        self.save()
        self.match_id=UUID('72adc60a-b83a-5ec9-8938-86986607ace8')
        self.log={'schema':'fpa-substitution-log/v2','video':{'name':'sample.mp4','duration':10,'from':0,'to':10},'players':[],'initialPlayers':[],
                  'substitutions':[{'id':'event','team':'home','time':5,'note':''}]}
        with self.Session() as db:
            s=db.get(FpaCvResource,'c'*32);s.payload={**s.payload,'matchId':str(self.match_id),'uploadId':'b'*32}
            db.add(Match(id=self.match_id,name='fixture',sport='FUTSAL',metadata_json={'fla_video':{'upload_id':'b'*32},'fla_substitutions':{'revision':1,'log':self.log}}));db.commit()
        self.recovery={'id':'d'*32,'schema':'fpa-substitution-redetection/v1','snapshotId':'c'*32,'datasetId':'sample','logRevision':1,'logContext':log_context(self.log),
                       'video':{'name':'sample.mp4','duration':10},'roi':[[0,0],[1,0],[1,.8],[0,.8]],'model':'yolo26s.pt',
                       'windows':[{'id':1,'eventIds':['event'],'from':0,'to':10,'frames':[{'t':5,'boxes':[{'id':1001000001,'box':[.2,.3,.4,.6],'confidence':.9}]}]}]}
        self.recovery_mock=patch('app.futsal_substitution_redetection.storage',return_value=self.storage_mock.return_value);self.recovery_mock.start()
        self.endpoint=self.url+'/'+'c'*32+'/redetection'
    def tearDown(self):
        self.recovery_mock.stop();fixture.Snapshots.tearDown(self)
    def test_private_immutable_pin_revision_and_geometry(self):
        self.assertEqual(self.client.get(self.endpoint).json()['status'],'missing')
        r=self.client.post(self.endpoint,json=self.recovery);self.assertEqual(r.status_code,201,r.text)
        self.assertEqual(self.client.post(self.endpoint,json=self.recovery).status_code,201)
        self.assertTrue(self.client.get(self.endpoint).json()['recovery']['reviewOnly'])
        self.assertNotIn('recovery',self.client.get(self.endpoint+'?metadata=true').json())
        bad=copy.deepcopy(self.recovery);bad['windows'][0]['frames'][0]['boxes'][0]['confidence']=.8
        self.assertEqual(self.client.post(self.endpoint,json=bad).status_code,409)
        with self.Session() as db:
            m=db.get(Match,self.match_id);log=copy.deepcopy(self.log);log['substitutions'][0]['note']='reviewed'
            decision={'snapshotId':'c'*32,'redetectionId':'d'*32,'outPersonId':'home-1','outTrackId':12,'inTrackId':1001000001}
            log['substitutions'][0]['tracking']=decision
            check_resolution(db,self.user,db.get(FpaCvResource,'c'*32),TrackingResolution(**decision),log)
            m.metadata_json={**m.metadata_json,'fla_substitutions':{'revision':2,'log':log}};db.commit()
        self.assertEqual(self.client.get(self.endpoint).json()['status'],'ready')
        with self.Session() as db:
            m=db.get(Match,self.match_id);log=copy.deepcopy(log);log['substitutions'][0]['time']=6
            m.metadata_json={**m.metadata_json,'fla_substitutions':{'revision':3,'log':log}};db.commit()
        self.assertEqual(self.client.get(self.endpoint).json()['status'],'stale')
        self.assertNotIn('recovery',self.client.get(self.endpoint).json())
        self.user.id='two';self.assertEqual(self.client.get(self.endpoint).status_code,404)
    def test_bad_windows_ids_video_and_resolution(self):
        for mutate in [lambda v:v.update(snapshotId='a'*32),lambda v:v.update(logRevision=0),lambda v:v['windows'][0].update(to=90),lambda v:v['windows'][0]['frames'][0]['boxes'][0].update(id=100),lambda v:v['windows'][0]['frames'][0]['boxes'][0].update(box=[.5,.5,.3,.3])]:
            v=copy.deepcopy(self.recovery);mutate(v);self.assertIn(self.client.post(self.endpoint,json=v).status_code,(400,409))
        for v in [None,[],{}, {'windows':[None]}]:self.assertIn(self.client.post(self.endpoint,json=v).status_code,(400,409))
        self.assertEqual(self.client.post(self.endpoint,json=self.recovery).status_code,201)
        with self.Session() as db:
            snapshot=db.get(FpaCvResource,'c'*32)
            for extra in [{},{'redetectionId':'d'*32}]:
                with self.assertRaises(HTTPException):check_resolution(db,self.user,snapshot,TrackingResolution(snapshotId='c'*32,outPersonId='home-1',outTrackId=10,inTrackId=1999999999,**extra),self.log)
