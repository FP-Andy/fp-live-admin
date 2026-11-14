"""The unfinished production wiring must fail closed until explicitly completed."""
from pathlib import Path
import unittest
import yaml

ROOT=Path(__file__).resolve().parents[1]

class ProductionGuardTests(unittest.TestCase):
 def setUp(self):
  data=yaml.safe_load((ROOT/'infra/app/courtside.production.disabled.yml').read_text())
  self.api=data['services']['api'];self.worker=data['services']['courtside-v2']
 def test_network_gpu_and_recording_are_disabled(self):
  self.assertEqual(self.worker['network_mode'],'none')
  self.assertTrue(self.worker['read_only'])
  self.assertIn('courtside',self.worker['profiles'])
  self.assertEqual(self.worker['environment']['KBL_GPU_DISABLED'],'1')
  self.assertEqual(self.worker['environment']['KBL_VIDEO_RENDER_ENABLED'],'0')
  self.assertEqual(self.api['environment']['COURTSIDE_ALLOW_GPU_ACTIONS'],'0')
  self.assertEqual(self.api['environment']['COURTSIDE_ALLOW_RECORDING_RELAY'],'0')
  self.assertNotIn('privileged',self.worker)
 def test_shared_root_and_code_mounts_are_explicit(self):
  am=self.api['volumes'][0];wm=self.worker['volumes'][0]
  self.assertTrue(am.startswith('${COURTSIDE_STORE_HOST:?'))
  self.assertTrue(wm.startswith('${COURTSIDE_STORE_HOST:?'))
  self.assertEqual(self.api['environment']['COURTSIDE_DATA_ROOT'],'/courtside-data')
  self.assertTrue(all(v.endswith(':ro') for v in self.worker['volumes'][1:]))
  self.assertTrue(all('COURTSIDE_RELEASE_ROOT:?' in v for v in self.worker['volumes'][1:]))
  self.assertIn('COURTSIDE_WORKER_IMAGE:?',self.worker['image'])
  self.assertIn('no-new-privileges:true',self.worker['security_opt'])
  compile(self.worker['healthcheck']['test'][-1],'<healthcheck>','exec')
if __name__=='__main__':unittest.main()
