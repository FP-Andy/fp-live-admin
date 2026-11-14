"""Keep the reviewable worker source list closed over local imports."""
import ast
import json
import re
import sys
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parent

class WorkerReleaseManifestTests(unittest.TestCase):
 def test_declared_modules_and_dynamic_entrypoints_exist(self):
  manifest=json.loads((ROOT/'worker-release-manifest.json').read_text())
  self.assertEqual(manifest['schema'],'courtside-worker-source/v1')
  declared=set(manifest['modules'])
  present={p.stem for p in ROOT.glob('*.py') if not p.name.startswith('test_')}
  self.assertEqual(declared,present)
  self.assertTrue(set(manifest['entrypoints'])<=declared)
  for name in manifest['assets']:self.assertTrue((ROOT/name).is_file(),name)
  allowed_external=set(manifest['externalModules'])|set(manifest['fpcSharedModules'])|set(sys.stdlib_module_names)
  for shared in manifest['fpcSharedModules']:
   self.assertTrue((ROOT.parent/(shared+'.py')).is_file(),shared)
  for name in declared:
   tree=ast.parse((ROOT/(name+'.py')).read_text())
   for node in ast.walk(tree):
    modules=[node.module or ''] if isinstance(node,ast.ImportFrom) else [a.name for a in node.names] if isinstance(node,ast.Import) else []
    for module in modules:
     local=module.split('.')[0]
     if local:self.assertTrue(local in declared or local in allowed_external, f'{name} imports missing or unlisted module {local}')
  for name in ('build_pose_assets','build_mpfb_assets','video_cpu_worker','video_renderer_cpu','video_depth','process'):
   self.assertIn(name,declared)
 def test_no_local_paths_credentials_or_historical_match_defaults(self):
  manifest=json.loads((ROOT/'worker-release-manifest.json').read_text())
  pattern=re.compile(r'/Users/[^/\s]+/|/Volumes/[^/\s]+/|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|game0[3-6][0-9]')
  for name in manifest['modules']:
   text=(ROOT/(name+'.py')).read_text()
   self.assertIsNone(pattern.search(text),name)
  self.assertNotIn('[[455,563]',(ROOT/'serve.py').read_text())
if __name__=='__main__':unittest.main()
