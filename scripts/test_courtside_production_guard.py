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
 def test_staging_t4_bridge_has_no_direct_worker_network_or_static_keys(self):
  data=yaml.safe_load((ROOT/'infra/app/courtside.eic.staging.yml').read_text())
  worker=data['services']['courtside-v2'];broker=data['services']['courtside-eic']
  self.assertEqual(self.worker['network_mode'],'none')
  self.assertEqual(worker['entrypoint'][-1],'scripts/kbl_grayzone/gpu_eic_bootstrap.py')
  self.assertEqual(worker['environment']['KBL_GPU_DISABLED'],'0')
  self.assertEqual(worker['environment']['COURTSIDE_GPU_STAGING_MODE'],'1')
  self.assertIn('COURTSIDE_STAGING_GPU_WORKSPACE:?',worker['environment']['COURTSIDE_STAGING_GPU_WORKSPACE'])
  self.assertIn('COURTSIDE_STAGING_GPU_SHARED_LOCK:?',worker['environment']['COURTSIDE_STAGING_GPU_SHARED_LOCK'])
  self.assertEqual(broker['user'],'1000:1000');self.assertTrue(broker['read_only'])
  self.assertEqual(broker['cap_drop'],['ALL']);self.assertNotIn('ports',broker)
  self.assertEqual(broker['networks'],['courtside-eic-egress'])
  self.assertNotIn('AWS_ACCESS_KEY_ID',broker.get('environment',{}))
  self.assertTrue(all(v.endswith(':ro') for v in broker['volumes'][1:]))
  self.assertTrue(all(v.endswith(':ro') for v in worker['volumes']))
 def test_staging_video_tools_are_mounted_read_only(self):
  data=yaml.safe_load((ROOT/'infra/app/courtside.video.staging.yml').read_text())
  worker=data['services']['courtside-v2']
  self.assertEqual(worker['environment']['KBL_VIDEO_RENDER_ENABLED'],'1')
  self.assertEqual(worker['environment']['KBL_BLENDER'],'/opt/courtside-blender/blender')
  self.assertTrue(all(v.endswith(':ro') for v in worker['volumes']))
 def test_explicit_enabled_overlay_keeps_credentials_and_worker_isolated(self):
  data=yaml.safe_load((ROOT/'infra/app/courtside.production.enabled.yml').read_text())
  worker=data['services']['courtside-v2'];broker=data['services']['courtside-eic']
  self.assertEqual(data['services']['web']['build']['args']['NEXT_PUBLIC_COURTSIDE_ENABLED'],'1')
  self.assertEqual(data['services']['api']['environment']['COURTSIDE_ALLOW_GPU_ACTIONS'],'1')
  self.assertEqual(data['services']['api']['environment']['COURTSIDE_ALLOW_RECORDING_RELAY'],'1')
  self.assertEqual(self.worker['network_mode'],'none');self.assertTrue(all(v.endswith(':ro') for v in worker['volumes']))
  self.assertNotIn('COURTSIDE_GPU_STAGING_MODE',worker['environment'])
  self.assertEqual(broker['networks'],['courtside-eic-egress']);self.assertNotIn('ports',broker)
  self.assertEqual(broker['user'],'1000:1000');self.assertEqual(broker['cap_drop'],['ALL'])
  self.assertTrue(broker['volumes'][1].endswith(':ro'));self.assertNotIn('AWS_ACCESS_KEY_ID',broker['environment'])
if __name__=='__main__':unittest.main()
