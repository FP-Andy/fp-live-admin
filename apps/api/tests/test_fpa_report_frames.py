"""Frame extraction stays authenticated, bounded, and independent of browser codecs."""
import os
os.environ.setdefault('DATABASE_URL','sqlite:////tmp/fla-test-unused-engine.db')
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from fastapi import HTTPException
from app import fpa_cv_report_frames as frames
from app.fpa_cv import report_frame

class ReportFrameTests(unittest.TestCase):
    def setUp(self):frames._cache.clear()
    def test_jpeg_is_cached_without_reusing_a_signed_url(self):
        with patch.object(frames.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'\xff\xd8JPEG')) as run:
            self.assertEqual(frames.extract_frame('u',12.3,lambda:'https://private.invalid/object'),b'\xff\xd8JPEG')
            self.assertEqual(frames.extract_frame('u',12.3,lambda:1/0),b'\xff\xd8JPEG')
            self.assertEqual(run.call_count,1)
            self.assertEqual(run.call_args.kwargs['timeout'],35)
    def test_decoder_failures_do_not_expose_credentials(self):
        with patch.object(frames.subprocess,'run',side_effect=subprocess.TimeoutExpired('private signed url',35)):
            with self.assertRaises(HTTPException) as e:frames.extract_frame('u',1,lambda:'secret')
            self.assertEqual(e.exception.status_code,503)
            self.assertNotIn('secret',e.exception.detail)
    def test_route_checks_owner_before_cache_and_validates_time(self):
        job=SimpleNamespace(payload={'status':'completed','storage':'s3','uploadId':'u'})
        upload=SimpleNamespace(id='u',payload={'duration':60,'key':'private-key'})
        with patch('app.fpa_cv.owned',side_effect=HTTPException(404)):
            with self.assertRaises(HTTPException) as e:report_frame('x',1,None,None)
            self.assertEqual(e.exception.status_code,404)
        for t in (-1,float('nan'),float('inf'),61):
            with patch('app.fpa_cv.owned',side_effect=[job,upload]):
                with self.assertRaises(HTTPException) as e:report_frame('x',t,None,None)
                self.assertEqual(e.exception.status_code,400)
        with patch('app.fpa_cv.owned',side_effect=[job,upload]),patch.object(frames,'extract_frame',return_value=b'\xff\xd8JPEG'):
            response=report_frame('x',5,None,None)
            self.assertEqual(response.media_type,'image/jpeg')
            self.assertEqual(response.headers['cache-control'],'private, no-store')
