"""Ordering, bounded memory, failure propagation and cancellation of stages."""
import threading
import time
import unittest

from fpa_cv_pipeline import OrderedPipeline


class PipelineTests(unittest.TestCase):
    def assert_stopped(self, pipeline):
        self.assertFalse(any(worker.is_alive() for worker in pipeline.workers))

    def test_matches_serial_with_no_dropped_or_reordered_frames(self):
        stages = [('square', lambda x: x*x), ('label', lambda x: {'frame': x})]
        with OrderedPipeline(range(200), stages) as pipeline:
            actual = list(pipeline)
        with OrderedPipeline(range(200), stages, threaded=False) as serial:
            self.assertEqual(actual, list(serial))
        self.assert_stopped(pipeline)
        for stats in pipeline.stats.values():
            self.assertEqual(stats['items'], 200)

    def test_stages_overlap_without_waiting_for_prior_frame_consumer(self):
        second_detected = threading.Event()
        def detect(value):
            if value == 1:
                second_detected.set()
            return value
        def describe(value):
            if value == 0:
                self.assertTrue(second_detected.wait(2), 'Detection did not run ahead')
            return value
        with OrderedPipeline(range(3), [('detect', detect), ('describe', describe)]) as pipeline:
            self.assertEqual(list(pipeline), [0, 1, 2])
        self.assert_stopped(pipeline)

    def test_slow_consumer_bounds_prefetched_frames_and_early_exit_closes_source(self):
        generated = []
        closed = threading.Event()
        def source():
            try:
                for value in range(100000):
                    generated.append(value)
                    yield value
            finally:
                closed.set()
        with OrderedPipeline(source(), [('a', lambda x: x), ('b', lambda x: x)], capacity=2) as pipeline:
            self.assertEqual(next(iter(pipeline)), 0)
            time.sleep(.05)
            # Three bounded queues, one in-flight item per producer, one consumer.
            self.assertLessEqual(len(generated), 10)
        self.assertTrue(closed.is_set())
        self.assert_stopped(pipeline)

    def test_source_error_reaches_consumer(self):
        def source():
            yield 1
            raise OSError('decode failed')
        pipeline = OrderedPipeline(source(), [('next', lambda x: x)])
        with self.assertRaisesRegex(OSError, 'decode failed'):
            with pipeline:
                list(pipeline)
        self.assert_stopped(pipeline)

    def test_stage_error_reaches_consumer_and_stops_upstream(self):
        def detect(value):
            if value == 3:
                raise ValueError('inference failed')
            return value
        pipeline = OrderedPipeline(range(10000), [('detect', detect), ('next', lambda x: x)])
        with self.assertRaisesRegex(ValueError, 'inference failed'):
            with pipeline:
                list(pipeline)
        self.assert_stopped(pipeline)

    def test_consumer_error_stops_blocked_producers(self):
        pipeline = OrderedPipeline(range(10000), [('next', lambda x: x)])
        with self.assertRaisesRegex(RuntimeError, 'tracker failed'):
            with pipeline:
                for _ in pipeline:
                    raise RuntimeError('tracker failed')
        self.assert_stopped(pipeline)

    def test_empty_source_and_source_only(self):
        for data in ([], [1, 2, 3]):
            with OrderedPipeline(data) as pipeline:
                self.assertEqual(list(pipeline), data)
            self.assert_stopped(pipeline)


if __name__ == '__main__':
    unittest.main()
