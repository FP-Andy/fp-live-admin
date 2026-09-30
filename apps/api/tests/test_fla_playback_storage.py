import os
import unittest
from unittest.mock import Mock,patch
from app.fpa_cv_storage import FpaStorage

class PlaybackStorageTests(unittest.TestCase):
    def test_acceleration_is_browser_only_and_opt_in(self):
        with patch.dict(os.environ,{'FPA_CV_S3_BUCKET':'test','FPA_CV_S3_ACCELERATE':'1'}):
            regional=Mock();edge=Mock();store=FpaStorage(client=regional);store._accelerated=edge
            key='fpa-cv/uploads/'+'a'*32+'/source.mp4'
            store.url(key,browser=True);edge.generate_presigned_url.assert_called_once()
            regional.generate_presigned_url.assert_not_called()
            store.url(key);regional.generate_presigned_url.assert_called_once()
            with patch.dict(os.environ,{'FPA_CV_S3_ACCELERATE':'0'}):
                store.url(key,browser=True)
            self.assertEqual(regional.generate_presigned_url.call_count,2)
