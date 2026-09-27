"""Exact equivalence to the existing per-bin color mean, without approximation."""
import unittest
import numpy as np
from fpa_cv_colors import rgb_histogram


class HistogramTests(unittest.TestCase):
    def test_exact_counts_and_means_across_rgb_bins(self):
        rng = np.random.default_rng(2026)
        cases = [rng.integers(0,256,(n,3),dtype=np.uint8) for n in [1,37,10000]]
        cases += [np.full((300,3), v, dtype=np.uint8) for v in [0,31,32,127,128,255]]
        cases.append(rng.integers(0,256,(1000,6),dtype=np.uint8)[:,::2])
        for pixels in cases:
            with self.subTest(shape=pixels.shape):
                counts, means = rgb_histogram(pixels)
                old = pixels.astype(np.int32)
                keys = (old[:,0]//32)*64+(old[:,1]//32)*8+old[:,2]//32
                expected_bins, expected_counts = np.unique(keys,return_counts=True)
                np.testing.assert_array_equal(np.flatnonzero(counts), expected_bins)
                np.testing.assert_array_equal(counts[expected_bins], expected_counts)
                expected_means = np.array([old[keys==key].mean(axis=0) for key in expected_bins])
                np.testing.assert_array_equal(means[expected_bins], expected_means)


if __name__=='__main__':
    unittest.main()
