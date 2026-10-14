"""Recovery jobs use the persistent lane without downloading entire S3 videos."""
import io,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,Mock
from fpa_cv_jobs import TrackingJobs,JobError

class RecoveryJobs(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.manager=TrackingJobs(self.temp.name,probe=False,start_worker=False)
  self.manager.capability.update(ready=True,gpu='0',gpuLabel='CUDA')
  self.upload=self.manager.receive_upload(io.BytesIO(b'video'),5,'sample.mp4')
  model=Path(self.temp.name)/'model';model.touch()
  self.env=patch.dict(os.environ,{'FPA_CV_RF_PYTHON':__import__('sys').executable,'FPA_CV_RF_MODEL':str(model)});self.env.start()
  self.value={'id':'a'*32,'uploadId':self.upload['id'],'plan':{'schema':'fpa-substitution-redetection/v1','windows':[{'id':2,'from':5,'to':19}]}}
 def tearDown(self):self.env.stop();self.manager.close();self.temp.cleanup()
 def test_persistence_idempotency_cancel_and_no_default_retry(self):
  first=self.manager.create_recovery(self.value);self.assertEqual(first['kind'],'recovery')
  self.manager.create_recovery(self.value);self.assertEqual(len(self.manager.queue),1)
  restored=TrackingJobs(self.temp.name,probe=False,start_worker=False)
  try:self.assertIn(first['id'],restored.queue)
  finally:restored.close()
  self.value['plan']['windows'][0]['to']=20
  with self.assertRaises(JobError):self.manager.create_recovery(self.value)
  self.manager.cancel(first['id']);self.assertEqual(self.manager.get(first['id'])['status'],'cancelled')
  with self.assertRaises(JobError):self.manager.retry(first['id'])
 def test_s3_ranges_result_archive_progress_and_model_isolation(self):
  info,path=self.manager._upload(self.upload['id']);info.update(storage='s3',key='fpa-cv/uploads/'+info['id']+'/source.mp4');(path.parent/'upload.json').write_text(json.dumps(info));path.unlink()
  self.manager.create_recovery(self.value);job=self.manager.jobs[self.value['id']]
  def launch(command,**kwargs):
   self.assertIn('--s3-key',command);self.assertIn('--detector',command);self.assertEqual(command[command.index('--detector')+1],'rfdetr')
   Path(command[command.index('--output')+1]).write_text(json.dumps({'id':job['id'],'windows':[{'frames':[{'t':5,'boxes':[]}]}]}))
   return Mock(stdout=io.StringIO('FPA_PROGRESS {"progress":50,"eta":1,"elapsed":1}\n'),wait=lambda **kw:0,poll=lambda:0,pid=999999999)
  with patch('fpa_cv_recovery_jobs.subprocess.Popen',side_effect=launch),patch.object(self.manager,'_archive') as archive:
   self.manager._execute_recovery(job);archive.assert_called_once();self.assertEqual(archive.call_args.args[-1],['recovery.json'])
  self.assertEqual(job['status'],'completed');self.assertFalse(path.exists());self.assertEqual(job['progress'],100)
 def test_shutdown_before_process_is_terminal(self):
  self.manager.create_recovery(self.value);job=self.manager.jobs[self.value['id']];job['status']='cancelling'
  with patch('fpa_cv_recovery_jobs.subprocess.Popen') as process:self.manager._execute_recovery(job);process.assert_not_called()
  self.assertEqual(job['status'],'cancelled')

if __name__=='__main__':unittest.main()
