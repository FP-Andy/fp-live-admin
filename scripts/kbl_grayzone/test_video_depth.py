import os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import video_depth
from video_depth import draw

class DepthTests(unittest.TestCase):
 def test_explicit_cache_must_be_private_and_owned(self):
  with tempfile.TemporaryDirectory() as folder:
   path=Path(folder);path.chmod(0o700)
   with patch.dict(os.environ,{'KBL_RENDER_CACHE_DIR':str(path)}):self.assertEqual(video_depth.cache_directory(),path)
   path.chmod(0o777)
   with patch.dict(os.environ,{'KBL_RENDER_CACHE_DIR':str(path)}):
    with self.assertRaisesRegex(RuntimeError,'접근 권한'):video_depth.cache_directory()
   link=path/'link';link.symlink_to(path,target_is_directory=True)
   with patch.dict(os.environ,{'KBL_RENDER_CACHE_DIR':str(link)}):
    with self.assertRaisesRegex(RuntimeError,'접근 권한'):video_depth.cache_directory()
 def test_intersecting_triangles_use_per_pixel_depth_independent_of_order(self):
  verts=np.array([[-.8,-.8,1],[.8,-.8,1],[0,.8,1],[-1.6,-1.6,2],[1.6,-1.6,2],[0,1.6,2]])
  faces=np.array([[0,1,2],[3,4,5]]);colors=np.array([[0,0,255],[255,0,0]],dtype=np.uint8);k=np.array([[20,0,32],[0,20,32],[0,0,1]])
  a=np.zeros((64,64,3),np.uint8);b=a.copy();draw(a,verts,faces,colors,k);draw(b,verts,faces[::-1],colors[::-1],k)
  np.testing.assert_array_equal(a,b);np.testing.assert_array_equal(a[32,32],[0,0,255])
 def test_crossing_depth_changes_visible_triangle_across_image(self):
  xy=np.array([[-.8,-.8],[.8,-.8],[0,.8]])
  def triangle(z):return np.column_stack((xy*np.asarray(z)[:,None],z))
  verts=np.vstack((triangle([.6,2.,2.]),triangle([1.,1.,1.])))
  image=np.zeros((64,64,3),np.uint8);draw(image,verts,[[0,1,2],[3,4,5]],[[0,0,255],[255,0,0]],[[20,0,32],[0,20,32],[0,0,1]])
  np.testing.assert_array_equal(image[18,18],[0,0,255]);np.testing.assert_array_equal(image[18,44],[255,0,0])
 def test_triangle_crossing_near_plane_is_clipped_not_discarded(self):
  verts=np.array([[-.02,-.02,.01],[.5,-.5,1],[0,.5,1]])
  image=np.zeros((64,64,3),np.uint8);draw(image,verts,[[0,1,2]],[[255,0,0]],[[20,0,32],[0,20,32],[0,0,1]])
  self.assertGreater(np.count_nonzero(image),0)
