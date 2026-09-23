"""FIFO, coalescing, failure isolation and restart recovery without real sends."""
import os
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault('DATABASE_URL', 'sqlite:////tmp/fpc-queue-import.db')
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
from app.competition_queue import CompetitionSend, CompetitionSendWorker, enqueue
from app.models import HighlightJob

@compiles(JSONB, 'sqlite')
def compile_jsonb(element, compiler, **kw):
    return 'JSON'

class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_engine('sqlite:///'+self.tmp.name+'/queue.db')
        self.sessions = sessionmaker(bind=self.engine)
        HighlightJob.__table__.create(self.engine)
        CompetitionSend.__table__.create(self.engine)
        self.mutex = threading.Lock()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.engine.dispose)

    @contextmanager
    def lock(self):
        got = self.mutex.acquire(blocking=False)
        try: yield got
        finally:
            if got: self.mutex.release()

    def add(self, name):
        with self.sessions() as db:
            if not db.get(HighlightJob, name):
                db.add(HighlightJob(id=name, job_metadata={}))
                db.commit()
            return enqueue(db, name, {'job_id':name})

    def worker(self, callback):
        return CompetitionSendWorker(self.sessions, self.engine, callback, lock=self.lock)

    def test_fifo_and_duplicate_coalescing(self):
        for name in ['a','b','c','a','b']: self.add(name)
        calls=[]
        worker=self.worker(lambda job_id:calls.append(job_id))
        while worker.run_one(): pass
        self.assertEqual(calls,['a','b','c'])
        # An intentional resend is accepted after the previous task finished.
        self.add('a'); worker.run_one()
        self.assertEqual(calls,['a','b','c','a'])

    def test_busy_worker_does_not_start_another_job(self):
        self.add('a'); self.add('b')
        entered,release=threading.Event(),threading.Event()
        calls=[]
        def send(job_id):
            calls.append(job_id); entered.set(); release.wait(3)
        thread=threading.Thread(target=self.worker(send).run_one)
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertFalse(self.worker(lambda **kw:self.fail('parallel send')).run_one())
            self.assertEqual(self.add('a'),'sending')
            with self.sessions() as db:
                self.assertEqual(db.query(CompetitionSend).count(),2)
        finally:
            release.set(); thread.join(3)
        self.worker(lambda job_id:calls.append(job_id)).run_one()
        self.assertEqual(calls,['a','b'])

    def test_failure_does_not_block_next_job(self):
        self.add('a'); self.add('b')
        def fail(**kw): raise RuntimeError('synthetic')
        with self.assertLogs('app.competition_queue',level='ERROR'):
            self.worker(fail).run_one()
        calls=[]; self.worker(lambda job_id:calls.append(job_id)).run_one()
        self.assertEqual(calls,['b'])
        with self.sessions() as db:
            self.assertEqual(db.query(CompetitionSend).order_by(CompetitionSend.id).first().status,'failed')
            self.assertTrue(db.get(HighlightJob,'a').job_metadata['competition_callback_status'].startswith('failed'))

    def test_restart_recovers_running_before_waiting(self):
        self.add('a'); self.add('b')
        with self.sessions() as db:
            db.query(CompetitionSend).filter_by(job_id='a').one().status='running'; db.commit()
        calls=[]; worker=self.worker(lambda job_id:calls.append(job_id))
        worker.run_one(); worker.run_one()
        self.assertEqual(calls,['a','b'])

    def test_shutdown_leaves_pending_task_persisted(self):
        self.add('a'); worker=self.worker(lambda **kw:self.fail('started after shutdown'))
        worker.close(); self.assertFalse(worker.run_one())
        with self.sessions() as db:
            self.assertEqual(db.query(CompetitionSend).one().status,'queued')

if __name__=='__main__': unittest.main()
