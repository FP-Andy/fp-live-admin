"""GPU queue ownership, budget, cumulative import and stale-log contracts."""
import copy
import json
from unittest.mock import patch
import unittest
from test_substitution_redetection import Redetection
from app.models import FpaCvResource, Match
from app import futsal_recovery_jobs as jobs

class RecoveryQueue(Redetection):
    def setUp(self):
        super().setUp()
        self.endpoint_jobs=self.url+'/'+'c'*32+'/recovery-jobs'
        self.patch_store=patch.object(jobs,'storage',return_value=self.storage_mock.return_value);self.patch_store.start()
        self.statuses={}
        async def remote(path,method='GET',**kw):
            if path=='uploads/register':return {}
            if path=='recoveries':
                v=kw['json'];self.statuses.setdefault(v['id'],{'status':'queued','stage':'queued','progress':0});return self.statuses[v['id']]
            if path.endswith('/cancel'):
                self.statuses[path.split('/')[1]]={'status':'cancelled','stage':'cancelled'};return self.statuses[path.split('/')[1]]
            return self.statuses[path.split('/')[1]]
        self.patch_remote=patch.object(jobs,'remote',side_effect=remote);self.patch_remote.start()
        with self.Session() as db:
            source=db.get(FpaCvResource,self.job_id);source.payload={**source.payload,'options':{'roi':self.recovery['roi']}}
            db.add(FpaCvResource(id='b'*32,kind='upload',owner_id='one',payload={'id':'b'*32,'name':'sample.mp4','size':100,'file':'source.mp4','key':'fpa-cv/uploads/'+ 'b'*32+'/source.mp4','storage':'s3','status':'uploaded','createdAt':1}));db.commit()
        self.plan={**self.recovery,'baseRecoveryId':None,'windows':[{'from':5,'to':5.4,'eventIds':['event']}]}
    def tearDown(self):
        self.patch_store.stop();self.patch_remote.stop();super().tearDown()
    def submit(self):return self.client.post(self.endpoint_jobs,json={'plan':self.plan})
    def complete(self,jid):
        key=f'fpa-cv/jobs/{jid}/recovery.json';value=copy.deepcopy(self.recovery);value['id']=jid
        with self.Session() as db:plan=db.get(FpaCvResource,jid).payload['plan']
        w=plan['windows'][0];value['windows']=[{**w,'frames':[{'t':w['from'],'boxes':[{'id':1000000000+w['id']*1000000+1,'box':[.2,.3,.4,.6],'confidence':.9}]}]}]
        self.objects[key]=json.dumps(value).encode();self.statuses[jid]={'status':'completed','progress':100,'s3Assets':{'recovery.json':key}}
    def test_bounded_idempotent_request_and_owner(self):
        a=self.submit();self.assertEqual(a.status_code,202,a.text);jid=a.json()['id']
        self.assertEqual(self.submit().json()['id'],jid)
        self.assertNotIn('plan',a.json());self.assertNotIn('key',a.text)
        self.user.id='two';self.assertEqual(self.submit().status_code,404);self.assertEqual(self.client.get(self.endpoint_jobs).status_code,404)
    def test_cumulative_import_preserves_pin_and_has_separate_id(self):
        self.assertEqual(self.client.post(self.endpoint,json=self.recovery).status_code,201)
        with self.Session() as db:
            m=db.get(Match,self.match_id);log=copy.deepcopy(self.log)
            log['substitutions'][0]['tracking']={'snapshotId':'c'*32,'redetectionId':'d'*32,'outPersonId':'home-1','outTrackId':12,'inTrackId':1001000001}
            m.metadata_json={**m.metadata_json,'fla_substitutions':{'revision':1,'log':log}};db.commit()
        self.plan['baseRecoveryId']='d'*32
        r=self.submit();self.assertEqual(r.status_code,202,r.text);jid=r.json()['id'];self.complete(jid)
        poll=self.client.get(self.endpoint_jobs);self.assertEqual(poll.status_code,200,poll.text)
        job=poll.json()['jobs'][0];self.assertEqual(job['status'],'completed');self.assertNotEqual(job['recoveryId'],jid)
        data=self.client.get(self.endpoint).json();self.assertEqual(data['id'],job['recoveryId']);self.assertEqual(data['windowCount'],2)
        self.assertEqual(data['recovery']['windows'][0],self.recovery['windows'][0]);self.assertEqual(data['recovery']['ancestorIds'],['d'*32])
        self.assertEqual(self.client.get(self.endpoint_jobs).json(),poll.json())
    def test_changed_geometry_does_not_auto_import(self):
        jid=self.submit().json()['id'];self.complete(jid)
        with self.Session() as db:
            m=db.get(Match,self.match_id);log=copy.deepcopy(self.log);log['substitutions'][0]['time']=6
            m.metadata_json={**m.metadata_json,'fla_substitutions':{'revision':2,'log':log}};db.commit()
        self.assertEqual(self.client.get(self.endpoint_jobs).json()['jobs'][0]['status'],'stale')
        self.assertEqual(self.client.get(self.endpoint).json()['status'],'missing')
    def test_budget_invalid_and_cancel(self):
        for windows in [[None],[{'from':5,'to':7,'eventIds':['event']}],[{'from':5,'to':5.4,'eventIds':['wrong']}]]:
            original=self.plan['windows'];self.plan['windows']=windows
            self.assertEqual(self.submit().status_code,400);self.plan['windows']=original
        jid=self.submit().json()['id'];r=self.client.post(self.endpoint_jobs+'/'+jid+'/cancel',json={});self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['status'],'cancelled')
    def test_cannot_forge_cumulative_ancestry(self):
        self.recovery['ancestorIds']=['f'*32]
        self.assertEqual(self.client.post(self.endpoint,json=self.recovery).status_code,400)

if __name__=='__main__':unittest.main()
