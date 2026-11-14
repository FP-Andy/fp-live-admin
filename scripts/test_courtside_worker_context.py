"""The worker build context must contain exactly reviewed tracked files."""
from pathlib import Path
import subprocess
import unittest

ROOT=Path(__file__).resolve().parents[1]
IGNORE=ROOT/'infra/app/Dockerfile.courtside-worker.dockerignore'

class WorkerContextTests(unittest.TestCase):
 def test_context_is_explicit_and_excludes_private_material(self):
  lines=[line for line in IGNORE.read_text().splitlines() if line and not line.startswith('#')]
  self.assertEqual(lines[0],'**')
  allowed={line[1:] for line in lines[1:] if line.startswith('!') and not line.endswith('/')}
  self.assertTrue(all('*' not in name and '?' not in name for name in allowed))
  args=['git','ls-files','-z','--','scripts/kbl_grayzone','apps/web/public/kbl-grayzone','assets/courtside-report']
  expected={p for p in subprocess.check_output(args,cwd=ROOT,text=True).split('\0') if p}
  expected.update(['scripts/fpa_cv_bytetrack.py','scripts/fpa_cv_uniforms.py','infra/app/courtside-linux-amd64-py311.lock'])
  self.assertEqual(allowed,expected)
  for name in allowed:
   self.assertFalse(any(part in name for part in ('/frames/','/posters/','/review-survey/','/assets/poses/','/data/')),name)
   self.assertNotIn(Path(name).name,('case.mjs','case.html','index.html'))
if __name__=='__main__':unittest.main()
