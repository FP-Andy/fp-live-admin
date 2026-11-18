import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import broadcast_reconstruction as spatial

class SpatialConcurrencyTests(unittest.TestCase):
 def test_stale_capture_cannot_replace_a_newer_scene(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);folder=root/'reconstructions'/'review-1';folder.mkdir(parents=True)
   (folder/'current.json').write_text(json.dumps({'captureId':'b'*24}))
   with patch.dict(spatial.CASES,{'game-test':root}),patch.object(spatial,'context',side_effect=RuntimeError('validated')):
    with self.assertRaisesRegex(RuntimeError,'다른 작업자'):
     spatial.save('game-test','review-1',{'expectedCaptureId':'a'*24})
    with self.assertRaisesRegex(RuntimeError,'validated'):
     spatial.save('game-test','review-1',{'expectedCaptureId':'b'*24})
   self.assertEqual(json.loads((folder/'current.json').read_text())['captureId'],'b'*24)

 def test_absent_capture_is_a_version_and_snapshot_is_atomic(self):
  with tempfile.TemporaryDirectory() as tmp,patch.dict(spatial.CASES,{'game-test':Path(tmp)}),patch.object(spatial,'current',return_value=None):
   self.assertEqual(spatial.snapshot('game-test','review-1'),{'saved':None,'captureVersion':None})
   with patch.object(spatial,'context',side_effect=RuntimeError('validated')):
    with self.assertRaisesRegex(RuntimeError,'validated'):spatial.save('game-test','review-1',{'expectedCaptureId':None})

if __name__=='__main__':unittest.main()
