import io,json,os,subprocess,sys,tempfile,unittest,uuid
import hashlib
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
from app.courtside_recording_source import copy_part_to_shared_store

class S3:
 def head_object(self,**kw):return {'ContentLength':4,'ETag':'v1'}
 def get_object(self,**kw):return {'ContentLength':4,'ETag':'v1','Body':io.BytesIO(b'test')}

class RecordingExternalTests(unittest.TestCase):
 @unittest.skipUnless(hasattr(os,'geteuid') and os.geteuid()==0,'requires isolated root test container')
 def test_root_api_copy_is_readable_by_unprivileged_store_owner(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);os.chown(root,1000,1000)
   mid=str(uuid.uuid4());sid=str(uuid.uuid4())
   result=copy_part_to_shared_store(S3(),'bucket',root,mid,'a'*24,sid,'take-00001-part-000001.mp4')
   path=root/result['relativePath']
   def drop_privileges():
    os.setgroups([]);os.setgid(1000);os.setuid(1000)
   proc=subprocess.run([sys.executable,'-c','import pathlib,sys;sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())',str(path)],
                       preexec_fn=drop_privileges,capture_output=True,check=True)
   self.assertEqual(proc.stdout,b'test')
   self.assertEqual(path.stat().st_uid,1000)
   self.assertEqual((root/'outputs/kbl-fpc-relay'/mid).stat().st_uid,1000)
   # A later idempotent request can reuse the same completed file.
   self.assertEqual(copy_part_to_shared_store(S3(),'bucket',root,mid,'a'*24,sid,'take-00001-part-000001.mp4')['sha256'],result['sha256'])

 def test_space_pressure_cleanup_runs_before_rechecking_free_space(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);mid=str(uuid.uuid4());sid=str(uuid.uuid4());cleanup=unittest.mock.Mock()
   low=SimpleNamespace(f_bavail=1,f_frsize=1);enough=SimpleNamespace(f_bavail=3*1024**3,f_frsize=1)
   with patch('os.fstatvfs',side_effect=[low,enough]):
    result=copy_part_to_shared_store(S3(),'bucket',root,mid,'a'*24,sid,'take-00001-part-000001.mp4',on_space_pressure=cleanup)
   cleanup.assert_called_once();self.assertEqual((root/result['relativePath']).read_bytes(),b'test')
 def test_interrupted_transfer_resumes_and_source_change_restarts(self):
  class Interrupted(io.BytesIO):
   def __init__(self,data):super().__init__(data);self.first=True
   def read(self,n=-1):
    if self.first:self.first=False;return super().read(3)
    raise OSError('connection lost')
  class ResumableS3:
   def __init__(self):self.data=b'0123456789';self.etag='v1';self.calls=[];self.fail=True
   def head_object(self,**kw):return {'ContentLength':len(self.data),'ETag':self.etag}
   def get_object(self,**kw):
    self.calls.append(kw);start=int(kw['Range'][6:-1]) if 'Range' in kw else 0
    body=Interrupted(self.data[start:]) if self.fail else io.BytesIO(self.data[start:])
    self.fail=False
    result={'ContentLength':len(self.data)-start,'ETag':self.etag,'Body':body}
    if start:result['ContentRange']=f'bytes {start}-{len(self.data)-1}/{len(self.data)}'
    return result
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);mid=str(uuid.uuid4());sid=str(uuid.uuid4());iid='a'*24;name='take-00001-part-000001.mp4';s3=ResumableS3()
   with self.assertLogs('uvicorn.error',level='INFO') as logs:
    with self.assertRaises(OSError):copy_part_to_shared_store(s3,'bucket',root,mid,iid,sid,name)
    result=copy_part_to_shared_store(s3,'bucket',root,mid,iid,sid,name)
   self.assertIn('complete=False resumed_bytes=0 transferred_bytes=3',logs.output[0])
   self.assertIn('complete=True resumed_bytes=3 transferred_bytes=7',logs.output[1])
   for sensitive in (mid,sid,name,'bucket','v1','connection lost'):
    self.assertNotIn(sensitive,' '.join(logs.output))
   self.assertEqual(s3.calls[-1]['Range'],'bytes=3-');self.assertEqual(s3.calls[-1]['IfMatch'],'v1')
   self.assertEqual((root/result['relativePath']).read_bytes(),s3.data)
   self.assertEqual(result['sha256'],hashlib.sha256(s3.data).hexdigest())
   s3.fail=True
   with self.assertRaises(OSError):copy_part_to_shared_store(s3,'bucket',root,mid,iid,sid,name)
   s3.data=b'abcdefghij';s3.etag='v2'
   result=copy_part_to_shared_store(s3,'bucket',root,mid,iid,sid,name)
   self.assertNotIn('Range',s3.calls[-1]);self.assertEqual((root/result['relativePath']).read_bytes(),s3.data)
   self.assertEqual(len(list((root/'outputs').rglob('.incoming-*'))),0)

 def test_resume_rejects_wrong_range_and_keeps_partial_private(self):
  class Broken(io.BytesIO):
   def read(self,n=-1):
    if self.tell()==0:return super().read(2)
    raise OSError('interrupted')
  class S3BadRange:
   def __init__(self):self.first=True
   def head_object(self,**kw):return {'ContentLength':4,'ETag':'v1'}
   def get_object(self,**kw):
    if self.first:self.first=False;return {'ContentLength':4,'ETag':'v1','Body':Broken(b'test')}
    return {'ContentLength':2,'ETag':'v1','ContentRange':'bytes 0-1/4','Body':io.BytesIO(b'st')}
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);args=(S3BadRange(),'bucket',root,str(uuid.uuid4()),'a'*24,str(uuid.uuid4()),'take-00001-part-000001.mp4')
   with self.assertRaises(OSError):copy_part_to_shared_store(*args)
   with self.assertRaisesRegex(ValueError,'변경'):copy_part_to_shared_store(*args)
   self.assertEqual(list(root.rglob('*.mp4')),[])

 def test_external_copy_is_scoped_and_fails_closed_when_disconnected(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder)/'project';root.mkdir();(root/'runtime').mkdir();(root/'outputs').mkdir()
   mount=Path(folder)/'volume';mount.mkdir();backing=Path(folder)/'backing';backing.mkdir();token='b'*32
   base=mount/'kbl-work/kbl-fpc-relay';base.mkdir(parents=True);(mount/'.fpc-kbl-work-storage').write_text(token)
   (root/'runtime/kbl-storage.json').write_text(json.dumps({'schema':'fpc-kbl-storage/v1','mount':str(mount),'backing':str(backing),'token':token}))
   (root/'outputs/kbl-fpc-relay').symlink_to(base);mid=str(uuid.uuid4());sid=str(uuid.uuid4());iid='a'*24
   with patch.object(os.path,'ismount',return_value=True):
    result=copy_part_to_shared_store(S3(),'bucket',root,mid,iid,sid,'take-00001-part-000001.mp4')
    self.assertEqual((root/result['relativePath']).read_bytes(),b'test')
    (mount/'.fpc-kbl-work-storage').unlink()
    with self.assertRaisesRegex(ValueError,'외장 녹화'):copy_part_to_shared_store(S3(),'bucket',root,mid,iid,sid,'take-00001-part-000001.mp4')

if __name__=='__main__':unittest.main()
