"""GPU routing must fail closed and report fresh selected-frame processing accurately."""
import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import gpu_bridge as gpu
import broadcast_frame_processing as frames

class GPUBridgeTests(unittest.TestCase):
 def test_isolated_workspace_can_use_same_t4_worker_lock(self):
  config={'workspace':'/tmp/courtside-stage-example','image':'test','workerLock':'/private/production/worker.lock'}
  script=gpu.runner_script(config,'/tmp/courtside-stage-example/jobs/abc','a'*24)
  self.assertIn('exec 9>/private/production/worker.lock',script)
  self.assertIn('flock -x 9',script)
  with self.assertRaises(ValueError):gpu.runner_script({**config,'workerLock':'/private/../other'},'/jobs/abc','a'*24)
 def test_gpu_smoke_mounts_only_read_only_model_in_isolated_workspace(self):
  workspace='/tmp/courtside-stage-'+'a'*24
  config={'workspace':workspace,'image':'test','workerLock':'/private/live/worker.lock',
   'stageReadOnlyPoseModel':'/private/live/runtime/kbl-pose/rtmw3d-x.onnx','stageOfflineWorker':True,'stageUser':'1000:1000'}
  with patch.dict(gpu.os.environ,{'COURTSIDE_GPU_STAGING_MODE':'1'}):
   script=gpu.runner_script(config,workspace+'/jobs/abc','b'*24)
   self.assertIn('--network none',script);self.assertIn('--user 1000:1000',script);self.assertIn('rtmw3d-x.onnx,readonly',script)
   mesh_config={**config,'stageReadOnlyBlender':'/private/live/runtime/blender-4.5.3-linux-x64',
                'stageReadOnlyMpfb':'/private/live/runtime/kbl-mpfb/mpfb2-master'}
   script=gpu.runner_script(mesh_config,workspace+'/jobs/abc','b'*24)
   self.assertIn('dst=/workspace/runtime/blender,readonly',script)
   self.assertIn('dst=/workspace/runtime/kbl-mpfb/mpfb2-master,readonly',script)
   with self.assertRaises(ValueError):gpu.runner_script({**mesh_config,'stageReadOnlyMpfb':'/private/secret'},workspace+'/jobs/abc','b'*24)
   with self.assertRaises(ValueError):gpu.runner_script({**mesh_config,'stageReadOnlyBlender':'/private/live/runtime/blender-4.5.3-linux-x64,ro'},workspace+'/jobs/abc','b'*24)
   with self.assertRaises(ValueError):gpu.runner_script({**config,'stageReadOnlyPoseModel':'/private/secret'},workspace+'/jobs/abc','b'*24)
  with patch.dict(gpu.os.environ,{'COURTSIDE_GPU_STAGING_MODE':'0'}):
   with self.assertRaises(ValueError):gpu.runner_script(config,workspace+'/jobs/abc','b'*24)
 def test_verified_t4_cache_is_reused(self):
  sha='a'*64;metrics={};config={'workspace':'/work','host':'worker'}
  with patch.object(gpu,'ssh',return_value=sha+'  /work/file\n') as ssh,patch.object(gpu,'scp') as scp:
   self.assertEqual(gpu.upload(config,'input.mp4',sha,metrics),'/workspace/media/'+sha+'.mp4')
  self.assertTrue(metrics['mediaCacheHit']);ssh.assert_called_once();scp.assert_not_called()
 def test_corrupt_t4_cache_is_replaced_only_after_verification(self):
  sha='a'*64;config={'workspace':'/work','host':'worker'};metrics={}
  with patch.object(gpu,'ssh',side_effect=['b'*64+'  old','','a'*64+'  upload','']) as ssh,patch.object(gpu,'scp') as scp:
   gpu.upload(config,'input.mp4',sha,metrics)
  self.assertFalse(metrics['mediaCacheHit']);scp.assert_called_once()
  self.assertTrue(ssh.call_args_list[1].args[1].startswith('mkdir -p '))
  self.assertTrue(ssh.call_args_list[-1].args[1].startswith('mv -f '))
 def test_corrupt_t4_transfer_does_not_replace_cache(self):
  sha='a'*64;config={'workspace':'/work','host':'worker'}
  with patch.object(gpu,'ssh',side_effect=['b'*64+'  old','','c'*64+'  upload','']) as ssh,patch.object(gpu,'scp'):
   with self.assertRaisesRegex(RuntimeError,'검증'):gpu.upload(config,'input.mp4',sha)
  commands=[call.args[1] for call in ssh.call_args_list]
  self.assertFalse(any(cmd.startswith('mv ') for cmd in commands));self.assertTrue(commands[-1].startswith('rm -f '))
 def test_missing_config_never_claims_gpu_available(self):
  with tempfile.TemporaryDirectory() as d,patch.object(gpu,'CONFIG',Path(d)/'absent.json'):
   self.assertFalse(gpu.enabled())
   with self.assertRaises(RuntimeError):gpu.config()
 def test_fresh_frame_does_not_report_cache_hit(self):
  case={'events':[{'id':'review-1','broadcastTrackingReady':False}]}
  packet={'frames':[{'frameIndex':150,'boxes':[{}],'floorPositions':[{'role':'referee'}]}]}
  with patch.object(frames.case_store,'load_case',return_value=case),patch.object(frames.case_store,'broadcast_packet',return_value=packet),patch.object(gpu,'tracking',return_value={'transferAndWorkerSeconds':12}) as run:
   r=frames.prepare('new','review-1',150)
   self.assertFalse(r['reusedExactFrame']);self.assertEqual(r['execution'],'T4');self.assertEqual(r['seconds'],12);run.assert_called_once()
 def test_failed_calibration_does_not_repeat_expensive_job(self):
  with patch.object(frames.case_store,'load_case',return_value={'events':[{'id':'review-1','broadcastTrackingReady':False}]}),patch.object(frames.case_store,'broadcast_packet',return_value={'frames':[{'frameIndex':150,'boxes':[],'floorPositions':[]}]}),patch.object(gpu,'tracking',return_value={'transferAndWorkerSeconds':12}) as run:
   with self.assertRaises(frames.CourtCalibrationRequired):frames.prepare('new','review-1',150)
   run.assert_called_once()
 def test_cached_failed_calibration_is_review_required_without_retracking(self):
  with patch.object(frames.case_store,'load_case',return_value={'events':[{'id':'review-1','broadcastTrackingReady':True}]}),patch.object(frames.case_store,'broadcast_packet',return_value={'frames':[{'frameIndex':150,'boxes':[{}],'floorPositions':[]}]}),patch.object(gpu,'tracking') as run:
   with self.assertRaises(frames.CourtCalibrationRequired):frames.prepare('new','review-1',150)
   run.assert_not_called()
 def test_exact_cached_frame_runs_no_gpu_job(self):
  with patch.object(frames.case_store,'load_case',return_value={'events':[{'id':'review-1','broadcastTrackingReady':True}]}),patch.object(frames.case_store,'broadcast_packet',return_value={'frames':[{'frameIndex':150,'boxes':[],'floorPositions':[{'role':'player'}]}]}),patch.object(gpu,'tracking') as run:
   self.assertTrue(frames.prepare('new','review-1',150)['reusedExactFrame']);run.assert_not_called()
if __name__=='__main__':unittest.main()

class WorkerControlTests(unittest.TestCase):
 def test_private_broker_does_not_start_or_query_ec2(self):
  with patch.dict(sys.modules,{'boto3':None}):
   gpu.ensure_running({'transport':'fixed-eic-broker','autoStart':False,'instanceId':'i-test'},lambda _:None)
   with self.assertRaises(ValueError):gpu.ensure_running({'transport':'fixed-eic-broker','autoStart':True},lambda _:None)
 def test_user_stop_cannot_be_undone_by_auto_start(self):
  import sys,types
  from unittest.mock import Mock
  client=Mock();client.describe_instances.return_value={'Reservations':[{'Instances':[{'State':{'Name':'stopped'}}]}]}
  with patch.dict(sys.modules,{'boto3':types.SimpleNamespace(client=lambda *a,**kw:client)}):
   with self.assertRaisesRegex(RuntimeError,'사용자 요청'):gpu.ensure_running({'instanceId':'existing','region':'us-east-1','autoStart':False},lambda s:None)
  client.start_instances.assert_not_called()
 def test_worker_bundle_contains_code_only(self):
  import tarfile
  with tempfile.TemporaryDirectory() as d,patch.object(gpu,'ROOT',Path(d)):
   root=Path(d);folder=root/'scripts/kbl_grayzone';folder.mkdir(parents=True)
   (folder/'gpu_worker.py').write_text('print(1)');(folder/'roboflow.env').write_text('secret');(folder/'test_worker.py').write_text('test')
   bundle,sha=gpu.worker_bundle()
   with tarfile.open(bundle) as tar:self.assertEqual(tar.getnames(),['scripts/kbl_grayzone/gpu_worker.py'])
   (folder/'gpu_worker.py').write_text('print(2)');self.assertNotEqual(sha,gpu.worker_bundle()[1])
