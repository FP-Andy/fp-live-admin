import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import review_package_jobs as jobs


class PackageJobsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        jobs.ACTIVE.clear();self.addCleanup(jobs.ACTIVE.clear)
        patches=[patch.object(jobs,'ROOT',Path(self.temp.name)),
                 patch.object(jobs.case_store,'load_case',return_value={'revision':3}),
                 patch.object(jobs.report_inputs,'version',return_value='version-a'),
                 patch.object(jobs.report_jobs,'stamp',return_value='fingerprint-a'),
                 patch.object(jobs.review_flow,'require_report'),patch.object(jobs.POOL,'submit')]
        for p in patches:p.start();self.addCleanup(p.stop)
        self.payload={'revision':3,'version':'version-a'}

    def test_submit_returns_immediately_and_duplicate_requests_reuse_job(self):
        first=jobs.submit('game-test',self.payload)['job']
        self.assertEqual(first['state'],'queued')
        self.assertEqual(jobs.submit('game-test',self.payload)['job']['jobId'],first['jobId'])
        jobs.POOL.submit.assert_called_once_with(jobs.run,first['jobId'])
        self.assertEqual(jobs.latest('game-test')['jobId'],first['jobId'])

    def test_completed_job_persists_and_is_reused_only_after_package_validation(self):
        first=jobs.submit('game-test',self.payload)['job'];result={'packageId':'a'*24,'download':'/case-review-package/game-test/'+('a'*24)+'.zip','bytes':20,'sceneCount':1}
        with patch.object(jobs.report_bundle,'build',return_value=result) as build:
            jobs.run(first['jobId']);build.assert_called_once_with('game-test',self.payload)
        self.assertEqual(jobs.status('game-test',first['jobId'])['result'],result)
        with patch.object(jobs.report_bundle,'bundle_file') as verify:
            self.assertEqual(jobs.submit('game-test',self.payload)['job']['jobId'],first['jobId'])
            verify.assert_called_once_with('game-test',result['packageId'])

    def test_interrupted_jobs_are_reported_and_can_be_retried(self):
        first=jobs.submit('game-test',self.payload)['job'];jobs.ACTIVE.clear()
        self.assertEqual(jobs.status('game-test',first['jobId'])['state'],'interrupted')
        self.assertNotEqual(jobs.submit('game-test',self.payload)['job']['jobId'],first['jobId'])

    def test_failed_or_cross_case_job_does_not_expose_result(self):
        first=jobs.submit('game-test',self.payload)['job']
        with patch.object(jobs.report_bundle,'build',side_effect=RuntimeError('changed')):
            jobs.run(first['jobId'])
        self.assertEqual(jobs.status('game-test',first['jobId'])['state'],'failed')
        with self.assertRaises(ValueError):jobs.status('other-case',first['jobId'])

    def test_changed_input_does_not_start_work(self):
        with self.assertRaises(RuntimeError):jobs.submit('game-test',{'revision':2,'version':'version-a'})
        with self.assertRaises(RuntimeError):jobs.submit('game-test',{'revision':3,'version':'old'})
        jobs.POOL.submit.assert_not_called()

    def test_changed_scene_while_queued_does_not_build_an_old_request(self):
        first=jobs.submit('game-test',self.payload)['job']
        with patch.object(jobs.report_jobs,'stamp',return_value='changed'),patch.object(jobs.report_bundle,'build') as build:
            jobs.run(first['jobId']);build.assert_not_called()
        self.assertEqual(jobs.status('game-test',first['jobId'])['state'],'failed')


if __name__=='__main__':unittest.main()
