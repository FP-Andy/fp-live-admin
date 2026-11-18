import datetime, hashlib, json, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import gpu_retention as retention

class RetentionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.job='a'*24; self.archive=b'verified result';self.sha=hashlib.sha256(self.archive).hexdigest()
  self.local=self.root/'outputs/kbl-pose-frames'/self.job;self.local.mkdir(parents=True)
  self.path=self.local/'transport.json';(self.local/'gpu-result.tar').write_bytes(self.archive)
  self.ticket={'state':'complete','jobId':self.job,'completedAt':'2026-01-01T00:00:00+00:00','artifacts':{'gpu-result.tar':self.sha}}
  self.path.write_text(json.dumps(self.ticket))
  self.remote=self.root/'worker';self.folder=self.remote/'jobs'/self.job;self.folder.mkdir(parents=True)
  (self.folder/'phase').write_text('complete');(self.folder/'result.tar').write_bytes(self.archive)
  (self.folder/'request.json').write_text('preserve');(self.folder/'tracks.json').write_text('duplicate')
 def run_remote(self,sha=None):
  p=subprocess.run([sys.executable,'-c',retention.REMOTE,str(self.remote),json.dumps([{'job':self.job,'sha256':sha or self.sha}])],capture_output=True,text=True,check=True)
  return json.loads(p.stdout)
 def test_local_requires_old_complete_intact_verified_archive(self):
  self.assertIsNotNone(retention.verified(self.path,clock=1800000000))
  self.assertIsNone(retention.verified(self.path,clock=1767225601))
  self.ticket['state']='running';self.path.write_text(json.dumps(self.ticket));self.assertIsNone(retention.verified(self.path,clock=1800000000))
  self.ticket['state']='complete';self.path.write_text(json.dumps(self.ticket));(self.local/'gpu-result.tar').write_bytes(b'bad')
  self.assertIsNone(retention.verified(self.path,clock=1800000000))
 def test_remote_deletes_duplicate_only_when_archive_matches(self):
  self.assertEqual(self.run_remote('b'*64)['cleanedJobs'],[]);self.assertTrue((self.folder/'result.tar').exists())
  self.assertEqual(self.run_remote()['cleanedJobs'],[self.job]);self.assertFalse((self.folder/'result.tar').exists())
  self.assertFalse((self.folder/'tracks.json').exists());self.assertTrue((self.folder/'request.json').exists())
  self.assertEqual(self.run_remote()['cleanedJobs'],[self.job])
 def test_remote_preserves_running_and_busy_jobs(self):
  import fcntl
  (self.folder/'phase').write_text('running');self.assertEqual(self.run_remote()['cleanedJobs'],[])
  (self.folder/'phase').write_text('complete')
  with (self.remote/'worker.lock').open('w') as f:
   fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);self.assertEqual(self.run_remote()['cleanedJobs'],[])
  self.assertTrue((self.folder/'result.tar').exists())
 def test_remote_preserves_dispatch_locked_and_symlink_archive(self):
  import fcntl
  with (self.folder/'dispatch.lock').open('w') as f:
   fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);self.assertEqual(self.run_remote()['cleanedJobs'],[])
  archive=self.folder/'result.tar';archive.unlink();outside=self.root/'outside';outside.write_bytes(self.archive);archive.symlink_to(outside)
  self.assertEqual(self.run_remote()['cleanedJobs'],[]);self.assertTrue(outside.exists())
 def test_cleanup_records_ack_and_skips_it_later(self):
  def ssh(config,command,timeout):
   return subprocess.run(command,shell=True,capture_output=True,text=True,check=True).stdout
  with patch('gpu_bridge.ssh',side_effect=ssh):
   self.assertEqual(retention.cleanup({'workspace':str(self.remote)},self.root,1800000000),{'eligible':1,'cleaned':1})
   self.assertEqual(retention.cleanup({'workspace':str(self.remote)},self.root,1800000000),{'eligible':0})
  self.assertTrue((self.local/'gpu-result.tar').exists())
if __name__=='__main__':unittest.main()
