import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import object_cache as cache
from job_store import digest

class CacheCompatibilityTests(unittest.TestCase):
 def test_audited_pair_reuses_only_exact_same_input_and_model(self):
  previous='a'*64;current='b'*64
  expected={'schema':'kbl-object-cache/v1','workerCodeSha256':current,'sourceSha256':'c'*64,'frameIndex':42,'detectorSha256':'d'*64,'roleSha256':'e'*64,'settingsVersion':'v1','image':'image@sha256:'+'f'*64}
  expected['fingerprint']=digest(expected)
  old={**expected,'workerCodeSha256':previous};old['fingerprint']=digest({k:v for k,v in old.items() if k!='fingerprint'});old['verified']=True
  packet={'trackingProvenance':old,'inputSha256':'c'*64,'detector':{'modelSha256':'d'*64},'roleClassifier':{'modelSha256':'e'*64},'frames':[{'frameIndex':42}]}
  with tempfile.TemporaryDirectory() as tmp:
   manifest=Path(tmp)/'compat.json';manifest.write_text(json.dumps({'pairs':[{'from':previous,'to':current}]}))
   with patch.object(cache,'COMPATIBILITY',manifest):
    self.assertEqual(cache.status(packet,expected),'current')
    changed={**expected,'frameIndex':43};changed['fingerprint']=digest({k:v for k,v in changed.items() if k!='fingerprint'})
    self.assertEqual(cache.status(packet,changed),'changed')
    changed={**expected,'workerCodeSha256':'1'*64};changed['fingerprint']=digest({k:v for k,v in changed.items() if k!='fingerprint'})
    self.assertEqual(cache.status(packet,changed),'changed')
    packet['detector']['modelSha256']='2'*64;self.assertEqual(cache.status(packet,expected),'changed')
 def test_missing_manifest_fails_closed(self):
  with tempfile.TemporaryDirectory() as tmp,patch.object(cache,'COMPATIBILITY',Path(tmp)/'absent'):
   self.assertFalse(cache.compatible_previous({'workerCodeSha256':'a'*64},{'workerCodeSha256':'b'*64}))
 def test_release_mapping_targets_exact_bundle(self):
  manifest=json.loads(cache.COMPATIBILITY.read_text());self.assertEqual(manifest['schema'],'kbl-tracking-code-compat/v1')
  target=cache.code_sha(Path(__file__).resolve().parents[2]);self.assertTrue(manifest['pairs'])
  self.assertTrue(all(row['to']==target for row in manifest['pairs']))

if __name__=='__main__':unittest.main()
