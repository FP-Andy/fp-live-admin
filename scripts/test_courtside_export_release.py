import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import courtside_export_release as exporter

class ReleaseExportTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);self.repo=self.root/'repo';self.repo.mkdir();self.dest=self.root/'releases';self.dest.mkdir()
  subprocess.run(['git','init','-q',str(self.repo)],check=True)
  self.paths=('scripts/kbl_grayzone/example.py','scripts/fpa_cv_bytetrack.py','scripts/fpa_cv_uniforms.py',
              'apps/web/public/kbl-grayzone/example.mjs','assets/courtside-report/font.dat')
  for i,name in enumerate(self.paths):
   p=self.repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(('tracked-'+str(i)).encode())
  self.commit()
 def git(self,*args):return subprocess.run(['git','-C',str(self.repo),*args],check=True,capture_output=True,text=True).stdout.strip()
 def commit(self):
  self.git('add','-A');self.git('-c','user.name=QA','-c','user.email=qa@example.invalid','commit','-qm','fixture')
  self.sha=self.git('rev-parse','HEAD')
 def test_export_uses_commit_not_mutable_or_untracked_files(self):
  (self.repo/self.paths[0]).write_text('modified after commit');(self.repo/'scripts/kbl_grayzone/untracked-secret.txt').write_text('private')
  with patch.object(exporter,'PATHS',self.paths):result=exporter.export(self.repo,self.sha,self.dest)
  self.assertEqual((result/self.paths[0]).read_text(),'tracked-0')
  self.assertFalse((result/'scripts/kbl_grayzone/untracked-secret.txt').exists())
  self.assertEqual((result/'.courtside-release').read_text().strip(),self.sha)
 def test_symlink_and_missing_inputs_fail_without_release(self):
  path=self.repo/self.paths[0];path.unlink();path.symlink_to('/etc/passwd');self.commit()
  with patch.object(exporter,'PATHS',self.paths),self.assertRaises(ValueError):exporter.export(self.repo,self.sha,self.dest)
  self.assertEqual(list(self.dest.iterdir()),[])
  with patch.object(exporter,'PATHS',self.paths+('missing',)),self.assertRaises(ValueError):exporter.export(self.repo,self.sha,self.dest)
  self.assertEqual(list(self.dest.iterdir()),[])
 def test_rejects_non_commit_argument(self):
  with self.assertRaises(ValueError):exporter.export(self.repo,'main',self.dest)

if __name__=='__main__':unittest.main()
