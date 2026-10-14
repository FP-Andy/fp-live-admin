"""A reviewed derivative must never leak or outlive its exact source versions."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch
import test_substitution_redetection as fixture
from app.models import FpaCvResource, Match
from app.futsal_substitution_redetection import REVIEWED_KIND

class ReviewedReport(unittest.TestCase):
    save = fixture.Redetection.save
    setUp = fixture.Redetection.setUp
    tearDown = fixture.Redetection.tearDown

    def publish(self):
        self.assertEqual(self.client.post(self.endpoint, json=self.recovery).status_code, 201)
        self.review_id = 'e'*32
        self.read_url = self.url+'/'+'c'*32+'/reviewed-report?review_id='+self.review_id
        self.result = {'status':'review', 'events':[], 'heatmap':self.body['heatmap'], 'provenance':{
            'snapshotId':'c'*32, 'matchId':str(self.match_id), 'jobId':self.job_id,
            'logRevision':1, 'redetectionId':'d'*32, 'reviewedReportId':self.review_id}}
        content=json.dumps(self.result).encode()
        key='fpa-cv/snapshots/'+'c'*32+'/reviewed-'+self.review_id+'.json'
        self.objects[key]=content
        with self.Session() as db:
            db.add(FpaCvResource(id=self.review_id,kind=REVIEWED_KIND,owner_id='one',payload={
                **self.result['provenance'],'key':key,'sha256':hashlib.sha256(content).hexdigest(),'createdAt':'2026-10-15'}))
            db.commit()
        return key

    def test_exact_sources_read_without_modifying_snapshot_and_owner_isolation(self):
        before=self.client.get(self.url+'/'+'c'*32).json()
        self.publish()
        self.assertEqual(self.client.get(self.endpoint+'?metadata=true').json()['reviewedReportId'], self.review_id)
        self.assertEqual(self.client.get(self.read_url).json(),self.result)
        self.assertEqual(self.client.get(self.url+'/'+'c'*32).json(),before)
        self.user.id='two'
        self.assertEqual(self.client.get(self.read_url).status_code,404)

    def test_log_revision_or_new_recovery_invalidates_without_silent_fallback(self):
        self.publish()
        with self.Session() as db:
            m=db.get(Match,self.match_id);m.metadata_json={**m.metadata_json,'fla_substitutions':{'revision':2,'log':self.log}};db.commit()
        self.assertIsNone(self.client.get(self.endpoint+'?metadata=true').json()['reviewedReportId'])
        self.assertEqual(self.client.get(self.read_url).status_code,409)
        with self.Session() as db:
            m=db.get(Match,self.match_id);m.metadata_json={**m.metadata_json,'fla_substitutions':{'revision':1,'log':self.log}};db.commit()
        newer=copy.deepcopy(self.recovery);newer['id']='f'*32
        self.assertEqual(self.client.post(self.endpoint,json=newer).status_code,201)
        self.assertEqual(self.client.get(self.read_url).status_code,409)

    def test_corrupted_or_wrong_provenance_is_never_returned(self):
        key=self.publish();self.objects[key]=b'{}'
        self.assertEqual(self.client.get(self.read_url).status_code,503)
        bad=copy.deepcopy(self.result);bad['provenance']['matchId']='other';self.objects[key]=json.dumps(bad).encode()
        with self.Session() as db:
            r=db.get(FpaCvResource,self.review_id);r.payload={**r.payload,'sha256':hashlib.sha256(self.objects[key]).hexdigest()};db.commit()
        self.assertEqual(self.client.get(self.read_url).status_code,503)

    def test_missing_review_keeps_standard_flow(self):
        self.assertIsNone(self.client.get(self.endpoint+'?metadata=true').json()['reviewedReportId'])
        self.assertEqual(self.client.get(self.url+'/'+'c'*32+'/reviewed-report?review_id='+'e'*32).status_code,409)
