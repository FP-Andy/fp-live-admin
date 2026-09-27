"""Shared-frame handoff must preserve descriptor values and free its resources."""
from multiprocessing import shared_memory
import unittest

import numpy as np

from fpa_cv_appearance_worker import AppearanceWorker
from fpa_cv_colors import appearance
from fpa_cv_uniforms import classify_uniform


class AppearanceWorkerTests(unittest.TestCase):
    def test_multiple_frames_match_in_process_exactly_and_release_shared_memory(self):
        uniforms = {'home_gk': [[255, 200, 0]], 'home': [[210, 20, 20]],
                    'away': [[20, 150, 220]], 'away_gk': [[50, 220, 100]],
                    'referee': [[230, 230, 230]]}
        worker = AppearanceWorker((180, 320, 3), uniforms)
        name = worker.memory.name
        try:
            rng = np.random.default_rng(92)
            boxes = np.array([[.1, .2, .7, .9], [0, 0, 1, 1], [.999, .999, 1, 1]], dtype=np.float32)
            for frame in (rng.integers(0, 256, (180, 320, 3), dtype=np.uint8),
                          np.full((180, 320, 3), [20, 20, 210], dtype=np.uint8)[:, ::-1]):
                expected = [appearance(frame, box) for box in boxes]
                descriptors, classifications = worker.describe(frame, boxes)
                self.assertEqual(descriptors, expected)
                self.assertEqual(classifications, [classify_uniform(a, uniforms) for a in expected])
            self.assertEqual(worker.describe(frame, np.empty((0, 4), np.float32)), ([], []))
            with self.assertRaises(ValueError):
                worker.describe(frame[:10], boxes)
        finally:
            worker.close()
        self.assertFalse(worker.process.is_alive())
        with self.assertRaises(FileNotFoundError):
            shared_memory.SharedMemory(name=name)

    def test_crashed_worker_does_not_leave_consumer_waiting(self):
        worker = AppearanceWorker((32, 32, 3), {})
        try:
            worker.process.kill()
            worker.process.join(timeout=2)
            with self.assertRaises((OSError, EOFError, RuntimeError)):
                worker.describe(np.zeros((32, 32, 3), np.uint8), np.zeros((1, 4), np.float32))
        finally:
            worker.close()


if __name__ == '__main__':
    unittest.main()
