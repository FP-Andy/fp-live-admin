"""Blender failure cannot masquerade as a completed pose revision."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from pose_jobs import mesh_build_outputs

class MeshBuildOutputTests(unittest.TestCase):
 def test_failed_or_incomplete_build_is_not_published(self):
  with TemporaryDirectory() as tmp:
   path=Path(tmp); row=path/'clip.json'; meshes=path/'clip-meshes.json'
   with self.assertRaisesRegex(RuntimeError,'인체 메시 생성 실패'):
    mesh_build_outputs(path,'clip',SimpleNamespace(returncode=1))
   row.write_text('{}')
   with self.assertRaisesRegex(RuntimeError,'인체 메시 생성 실패'):
    mesh_build_outputs(path,'clip',SimpleNamespace(returncode=0))
   meshes.write_text('{}')
   self.assertEqual(mesh_build_outputs(path,'clip',SimpleNamespace(returncode=0)),(row,meshes))
   with self.assertRaisesRegex(RuntimeError,'인체 메시 생성 실패'):
    mesh_build_outputs(path,'clip',SimpleNamespace(returncode=1))
if __name__=='__main__':unittest.main()
