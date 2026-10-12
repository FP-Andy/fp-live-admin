import unittest
from fpa_cv_substitution_redetect import crop_tiles,nms
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
if __name__=='__main__':unittest.main()
