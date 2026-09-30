"""Exercise immutable analysis snapshots using SQLite and an in-memory S3 fake."""
import os
os.environ['DATABASE_URL'] = 'sqlite:////tmp/snapshot-test-unused.db'
import copy
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
@compiles(JSONB, 'sqlite')
def sqlite_json(type_, compiler, **kw): return 'JSON'
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.db import Base, get_db
from app.auth import require_session_user
from app.models import FpaCvResource, Match, User
from app.futsal_analysis_snapshots import router, INPUTS


class Snapshots(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine, tables=[m.__table__ for m in (User, Match, FpaCvResource)])
        self.Session = sessionmaker(bind=self.engine)
        self.user = User(id='one', name='검수자', role='OPERATOR')
        self.job_id = 'a' * 32
        review = {'setup': {'time': 0}, 'roster': [{'id': 'home-1', 'group': 'home', 'jersey': '2'}],
                  'segments': [], 'uniforms': {}, 'autoReconnect': True, 'rejections': [], 'checkpoints': [],
                  'events': [{'row': {'Team': 'home', 'Player': '2', 'Action': 'Shot'}, 'log': 'test'}]}
        review['batch'] = {'round': 2, 'applied': {k: copy.deepcopy(review[k]) for k in INPUTS}}
        with self.Session() as db:
            db.add_all([User(id='one', name='검수자', role='OPERATOR'), User(id='two', name='다른 사용자', role='OPERATOR')])
            db.add(FpaCvResource(id=self.job_id, kind='job', owner_id='one', review=review, review_version=7,
                                payload={'status': 'completed', 'datasetId': 'sample', 'name': '테스트 경기', 'uploadId': 'b'*32, 'video': {'clipStart': 0, 'clipEnd': 10}}))
            db.commit()
        self.objects = {}
        def put(**kw):
            if kw['Key'] in self.objects: raise RuntimeError('Already exists')
            self.objects[kw['Key']] = kw['Body']
        store = SimpleNamespace(bucket='local-test', key=lambda key: key, client=SimpleNamespace(
            put_object=put, get_object=lambda **kw: {'Body': io.BytesIO(self.objects[kw['Key']])}))
        self.mock = patch('app.futsal_analysis_snapshots.storage', return_value=store); self.storage_mock = self.mock.start()
        def database():
            with self.Session() as db: yield db
        app = FastAPI(); app.include_router(router)
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[require_session_user] = lambda: self.user
        self.client = TestClient(app)
        self.url = '/api/futsal/analysis-snapshots'
        self.body = {'jobId': self.job_id, 'requestId': 'c'*32, 'confirmed': True, 'reviewVersion': 7,
                     'heatmap': {'schema': 'fpa-heatmaps/v1', 'datasetId': 'sample', 'video': 'test', 'resultVersion': 3, 'from': 0, 'to': 10,
                                 'width': 1, 'height': 1, 'scale': 10, 'players': [{'id': 'home-1', 'group': 'home', 'jersey': '2', 'grid': [8],
                                    'positions': [{'t': 0, 'x': .5, 'y': .5, 'seconds': 8}]}]}}
    def tearDown(self):
        self.client.close(); self.mock.stop(); self.engine.dispose()
    def save(self): return self.client.post(self.url, json=self.body)
    def test_freeze_both_sources_version_and_safe_retry(self):
        result = self.save(); self.assertEqual(result.status_code, 201, result.text)
        summary = result.json(); self.assertEqual(summary['meanCoverage'], .8)
        self.assertEqual(summary['eventCount'], 1); self.assertEqual(summary['quality'][0]['longestMissing'], 2)
        self.assertEqual(self.save().json()['version'], 1); self.assertEqual(len(self.objects), 1)
        first = self.client.get(self.url + '/' + summary['id']).json()
        with self.Session() as db:
            job = db.get(FpaCvResource, self.job_id); review = copy.deepcopy(job.review); review['events'] = []; job.review = review; job.review_version = 8; db.commit()
        self.assertEqual(self.client.get(self.url + '/' + summary['id']).json(), first)
        self.body.update(requestId='d'*32, reviewVersion=8)
        second = self.save(); self.assertEqual(second.status_code, 201, second.text)
        self.assertEqual(second.json()['version'], 2); self.assertEqual(second.json()['eventCount'], 0)
        self.assertEqual(len(self.client.get(self.url).json()['snapshots']), 2)
        self.assertEqual(first['fpa']['rows'][0]['Action'], 'Shot')
    def test_conflicts_pending_inputs_and_invalid_coordinates_do_not_save(self):
        self.body['reviewVersion'] = 6; self.assertEqual(self.save().status_code, 409)
        self.body['reviewVersion'] = 7
        self.body['heatmap']['players'][0]['positions'][0]['x'] = 2
        self.assertEqual(self.save().status_code, 400)
        self.body['heatmap']['players'][0]['positions'][0]['x'] = .5
        with self.Session() as db:
            job = db.get(FpaCvResource, self.job_id); review = copy.deepcopy(job.review); review['checkpoints'] = [{'time': 3}]; job.review = review; db.commit()
        self.assertEqual(self.save().status_code, 409); self.assertEqual(self.objects, {})
    def test_owner_isolation_and_immutable_routes(self):
        self.assertEqual(self.save().status_code, 201)
        self.user = User(id='two', name='other', role='OPERATOR')
        self.assertEqual(self.client.get(self.url).json()['snapshots'], [])
        self.assertEqual(self.client.get(self.url + '/' + 'c'*32).status_code, 404)
        self.assertEqual(self.save().status_code, 404)
        self.assertEqual(self.client.put(self.url + '/' + 'c'*32, json={}).status_code, 405)
    def test_changed_retry_payload_cannot_silently_reuse_original(self):
        self.assertEqual(self.save().status_code, 201)
        self.body['heatmap']['scale'] = 20
        self.assertEqual(self.save().status_code, 409)
    def test_storage_failure_does_not_mark_complete(self):
        self.storage_mock.return_value.client.put_object = lambda **kw: (_ for _ in ()).throw(IOError('offline'))
        self.assertEqual(self.save().status_code, 503)
        self.assertEqual(self.client.get(self.url).json()['snapshots'], [])

    def augmented(self):
        heat = self.body['heatmap']
        heat['augmentation'] = {'enabled': True, 'algorithm': 'personal-activity-density/v1', 'targetRatio': .3, 'targetBasis': 'duration', 'use': 'heatmap-only'}
        heat['players'][0]['augmentation'] = {'schema': 'fpa-heatmap-augmentation/v1', 'algorithm': 'personal-activity-density/v1', 'from': 0, 'to': 10, 'inferredSeconds': 2, 'estimatedGrid': [2], 'gaps': [{'from': 8, 'to': 10, 'inferredSeconds': 2, 'kind': 'activityPattern'}]}
        return heat

    def test_augmented_snapshot_keeps_measured_coverage_and_grid(self):
        heat = self.augmented()
        response = self.save(); self.assertEqual(response.status_code, 201, response.text)
        summary = response.json()
        self.assertEqual(summary['meanCoverage'], .8)
        self.assertEqual(summary['meanEstimatedCoverage'], .2)
        saved = self.client.get(self.url + '/' + summary['id']).json()['heatmap']
        self.assertEqual(saved, heat)
        self.assertEqual(saved['players'][0]['grid'], [8])

    def test_reject_density_overcount_overlap_and_known_absence(self):
        base = copy.deepcopy(self.augmented())
        changes = [lambda h: h['players'][0]['augmentation']['estimatedGrid'].__setitem__(0, 3),
                   lambda h: h['players'][0]['augmentation']['gaps'][0].update({'from': 7}),
                   lambda h: h['players'][0].update({'blockedIntervals': [{'from': 8, 'to': 10, 'reason': 'outside'}]}),
                   lambda h: h['players'][0]['augmentation']['gaps'].append({'from': 8, 'to': 10, 'inferredSeconds': 2, 'kind': 'activityPattern'}),
                   lambda h: h.pop('augmentation'),
                   lambda h: h['augmentation'].update({'targetRatio': .9})]
        for change in changes:
            self.body['heatmap'] = copy.deepcopy(base); change(self.body['heatmap'])
            self.assertEqual(self.save().status_code, 400)
        self.assertEqual(self.objects, {})
