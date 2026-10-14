import unittest
from fpa_cv_substitution_redetect import crop_tiles,nms
from fpa_cv_detection_merge import remove_crop_fragments
class RedetectTests(unittest.TestCase):
    def test_tiles_include_lower_boundary_and_outside_with_overlap(self):
        tiles=crop_tiles([[.1,.1],[.9,.15],[.95,.8],[.05,.85]])
        self.assertEqual(len(tiles),2)
        self.assertLess(tiles[1][0],tiles[0][2])
        for tile in tiles:
            self.assertLessEqual(tile[1],.4)
            self.assertGreater(tile[3],.85)
            self.assertTrue(all(0<=v<=1 for v in tile))
    def test_crop_seam_dedup_keeps_nearby_separate_person(self):
        rows=[[1,1,10,20,.9,0],[1.1,1,10.1,20,.8,0],[12,1,21,20,.7,0]]
        self.assertEqual(nms(rows),[rows[0],rows[2]])
    def test_invalid_roi(self):
        with self.assertRaises(ValueError):crop_tiles([[0,0],[1,0],[1,1]])
    def test_full_court_can_recover_infield_loss(self):
        roi=[[.1,.1],[.9,.15],[.95,.8],[.05,.85]]
        self.assertLess(crop_tiles(roi,'court')[0][1],crop_tiles(roi)[0][1])
    def test_truncated_internal_edge(self):
        tiles=[[0,0,620,900],[380,0,1000,900]]
        partial=[600,200,620,260,.8,0];body=[595,200,650,260,.9,0]
        self.assertEqual(remove_crop_fragments([partial,body],tiles),[body])
        self.assertEqual(remove_crop_fragments([partial,body],tiles,['home','away']),[partial,body])
        shifted=[580,200,600,260,.8,0]
        self.assertEqual(remove_crop_fragments([shifted,body],tiles),[shifted,body])
    def test_outer_edge_and_uncovered_fragments_survive(self):
        tiles=[[100,0,620,900],[380,0,950,900]]
        a=[100,200,120,260,.8,0];b=[90,200,150,260,.9,0]
        self.assertEqual(remove_crop_fragments([a,b],tiles),[a,b])
        self.assertEqual(remove_crop_fragments([[600,200,620,260,.8,0]],tiles),[[600,200,620,260,.8,0]])
if __name__=='__main__':unittest.main()
