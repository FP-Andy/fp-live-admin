import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import cloud_preflight as preflight


class CloudPreflightTests(unittest.TestCase):
 def test_missing_capabilities_are_reported_without_starting_jobs(self):
  with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'KBL_GPU_DISABLED':'1','KBL_VIDEO_RENDER_ENABLED':'0','KBL_DELIVERY_MODE':'web'},clear=True):
   result=preflight.checks(Path(folder))
  self.assertFalse(result['gpuConfig']);self.assertFalse(result['blender']);self.assertFalse(result['mpfbAddon'])
  self.assertFalse(result['renderEnabled']);self.assertTrue(result['webDelivery'])
 def test_ssh_policy_requires_pinned_hosts_and_no_autostart(self):
  with tempfile.TemporaryDirectory() as folder:
   config=Path(folder)/'ssh_config';config.write_text('Host gpu\n  StrictHostKeyChecking yes\n')
   gpu={'host':'gpu','sshConfig':str(config),'autoStart':False}
   output='stricthostkeychecking true\nidentityfile /private/key\nuserknownhostsfile /private/known_hosts\n'
   with patch.object(preflight,'executable',return_value=True),patch.object(preflight.subprocess,'run',return_value=SimpleNamespace(stdout=output)) as run:
    self.assertTrue(preflight.ssh_configuration(gpu));run.assert_called_once()
    gpu['autoStart']=True;self.assertFalse(preflight.ssh_configuration(gpu))
    gpu['autoStart']=False;run.reset_mock();config.write_text('Match=exec "touch bad"\n')
    self.assertFalse(preflight.ssh_configuration(gpu));run.assert_not_called()
 def test_gpu_config_is_reported_but_never_claimed_tested(self):
  with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'KBL_DELIVERY_MODE':'web','KBL_VIDEO_RENDER_ENABLED':'1'},clear=True):
   root=Path(folder);path=root/'runtime/kbl-cv/gpu.json';path.parent.mkdir(parents=True)
   path.write_text(json.dumps({'host':'gpu','sshConfig':'/private/config','image':'image','workspace':'/private/work','instanceId':'instance','region':'region','autoStart':False}))
   with patch.object(preflight,'ssh_configuration',return_value=True):result=preflight.checks(root)
   self.assertTrue(result['gpuConfig']);self.assertTrue(result['gpuSshPolicy']);self.assertTrue(result['gpuAutoStartDisabled'])
   self.assertNotIn('gpuVerified',result)
 def test_render_cache_rejects_noexec_or_shared_paths(self):
  with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'KBL_RENDER_CACHE_DIR':folder}),patch.object(os,'ST_NOEXEC',8,create=True):
   path=Path(folder);path.chmod(0o700)
   with patch.object(os,'statvfs',return_value=SimpleNamespace(f_flag=8)):
    self.assertFalse(preflight.render_cache_ready())
   with patch.object(os,'statvfs',return_value=SimpleNamespace(f_flag=0)):
    self.assertTrue(preflight.render_cache_ready());path.chmod(0o777);self.assertFalse(preflight.render_cache_ready())
 def test_staging_gpu_requires_isolated_workspace_and_shared_lock(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);path=root/'runtime/kbl-cv/gpu.json';path.parent.mkdir(parents=True)
   workspace='/home/ubuntu/courtside-stage-'+'a'*24;lock='/home/ubuntu/live/worker.lock'
   path.write_text(json.dumps({'workspace':workspace,'workerLock':lock}))
   with patch.dict(os.environ,{'COURTSIDE_STAGING_GPU_WORKSPACE':workspace,'COURTSIDE_STAGING_GPU_SHARED_LOCK':lock}):
    self.assertTrue(preflight.staging_gpu_isolation(root))
    path.write_text(json.dumps({'workspace':'/home/ubuntu/live','workerLock':lock}));self.assertFalse(preflight.staging_gpu_isolation(root))
    path.write_text(json.dumps({'workspace':workspace,'workerLock':workspace+'/worker.lock'}));self.assertFalse(preflight.staging_gpu_isolation(root))
   for invalid in ('/home/ubuntu/courtside-stage-abc123abc123','/home/ubuntu/courtside-stage-'+'z'*24):
    path.write_text(json.dumps({'workspace':invalid,'workerLock':lock}))
    with patch.dict(os.environ,{'COURTSIDE_STAGING_GPU_WORKSPACE':invalid,'COURTSIDE_STAGING_GPU_SHARED_LOCK':lock}):
     self.assertFalse(preflight.staging_gpu_isolation(root))

if __name__=='__main__':unittest.main()
