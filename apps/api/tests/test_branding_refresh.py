"""A club with many historical matches must not starve live API connections."""
import ast
from collections import Counter
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock
from uuid import UUID, uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.branding_refresh import BrandingRefreshQueue


class BrandingRefreshTests(unittest.TestCase):
    def make_queue(self, render, delay=0):
        queue = BrandingRefreshQueue(render, debounce_seconds=delay)
        self.addCleanup(queue.close)
        return queue

    def test_many_matches_wait_without_opening_sessions_and_coalesce_updates(self):
        entered, release, done = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        calls = []
        match_ids = [uuid4() for _ in range(80)]

        def render(match_id):
            calls.append(match_id)
            if len(calls) == 1:
                entered.set()
                self.assertTrue(release.wait(3))
            if len(calls) == len(match_ids):
                done.set()

        queue = self.make_queue(render)
        queue.submit(match_ids[0])
        self.assertTrue(entered.wait(1))
        for _ in range(3):
            for match_id in match_ids[1:]:
                queue.submit(match_id)
        # All submissions return while the only active DB/render callback is blocked.
        self.assertEqual(calls, [match_ids[0]])
        release.set()
        self.assertTrue(done.wait(3))
        self.assertEqual(Counter(calls), Counter(match_ids))

    def test_edit_during_render_gets_one_followup(self):
        entered, release, done = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        calls = []
        match_id = uuid4()

        def render(key):
            calls.append(key)
            if len(calls) == 1:
                entered.set()
                release.wait(3)
            else:
                done.set()

        queue = self.make_queue(render)
        queue.submit(match_id)
        self.assertTrue(entered.wait(1))
        for _ in range(10):
            queue.submit(match_id)
        release.set()
        self.assertTrue(done.wait(2))
        self.assertEqual(calls, [match_id, match_id])

    def test_failure_does_not_stop_next_match(self):
        done = threading.Event()
        failed_id, next_id = uuid4(), uuid4()

        def render(key):
            if key == failed_id:
                raise RuntimeError('render unavailable')
            done.set()

        queue = self.make_queue(render)
        with self.assertLogs('app.branding_refresh', level='ERROR'):
            queue.submit(failed_id)
            queue.submit(next_id)
            self.assertTrue(done.wait(2))

    def test_worker_closes_database_on_success_missing_match_and_failure(self):
        # Execute the actual callback without booting unrelated media services.
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'app/main.py').read_text())
        callback = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_render_latest_broadcast_branding')
        for missing, fail in [(False, False), (True, False), (False, True)]:
            db, rebuild = Mock(), Mock()
            if missing:
                db.get.return_value = None
            if fail:
                rebuild.side_effect = RuntimeError('failed')
            namespace = {'UUID': UUID, 'SessionLocal': Mock(return_value=db), 'Match': object, '_rebuild_broadcast_branding_assets': rebuild}
            exec(compile(ast.Module(body=[callback], type_ignores=[]), 'branding-callback', 'exec'), namespace)
            if fail:
                with self.assertRaises(RuntimeError):
                    namespace[callback.name](uuid4())
                db.rollback.assert_called_once()
            else:
                namespace[callback.name](uuid4())
            db.close.assert_called_once()
            self.assertEqual(rebuild.call_count, 0 if missing else 1)


if __name__ == '__main__':
    unittest.main()
