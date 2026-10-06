"""Fault injection: no network, no database or worker startup required."""
import asyncio
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch, MagicMock
from types import SimpleNamespace
from uuid import uuid4
from datetime import datetime
import tempfile
TEMP=tempfile.TemporaryDirectory(prefix='fpc-outbox-test-')
os.environ['DATABASE_URL']='sqlite:///'+str(Path(TEMP.name)/'db.sqlite')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import outbox_delivery as delivery

class Recovery(unittest.IsolatedAsyncioTestCase):
    async def run_fault(self, phase):
        stop=asyncio.Event(); row=SimpleNamespace(id=uuid4(),payload={'synthetic': True},kind='STATE',target_url='https://fixture.invalid/hook',attempts=0)
        sent=[]; failed=MagicMock(); good=MagicMock()
        failed.query.return_value.filter.return_value.filter.return_value.order_by.return_value.limit.return_value.all.return_value=[row]
        failed.query.return_value.filter.return_value.all.return_value=[]
        good.query.return_value.filter.return_value.filter.return_value.order_by.return_value.limit.return_value.all.return_value=[row]
        good.query.return_value.filter.return_value.all.return_value=[]
        async def post(url,content,headers):sent.append(headers['X-Webhook-Id']);return SimpleNamespace(status_code=200,raise_for_status=lambda:None)
        client=MagicMock();client.__aenter__.return_value=SimpleNamespace(post=post)
        client.__aexit__.return_value=False
        good.commit.side_effect=lambda:stop.set()
        if phase=='session': factory=[RuntimeError('session unavailable'),good]
        else:
            if phase=='query':failed.query.side_effect=RuntimeError('database disconnected')
            if phase=='commit':failed.commit.side_effect=RuntimeError('commit response lost')
            factory=[failed,good]
        async def pause(event,seconds):await asyncio.sleep(0)
        delivery.HEALTH.update(consecutive_errors=0,recoveries=0,last_delivery_at=None)
        with patch('app.db.SessionLocal',side_effect=factory),patch.object(delivery.httpx,'AsyncClient',return_value=client),patch.object(delivery,'pause',pause):
            await asyncio.wait_for(delivery.outbox_worker(stop),timeout=2)
        self.assertEqual(delivery.HEALTH['recoveries'],1)
        self.assertEqual(delivery.HEALTH['consecutive_errors'],0)
        self.assertFalse(delivery.HEALTH['running'])
        self.assertIsNotNone(delivery.HEALTH['last_delivery_at'])
        self.assertEqual(sent,[str(row.id)]*(2 if phase=='commit' else 1))
        if phase!='session':failed.rollback.assert_called_once();failed.close.assert_called_once()
        good.delete.assert_called_once_with(row)

    async def test_session_creation_failure_recovers(self):await self.run_fault('session')
    async def test_query_disconnect_recovers(self):await self.run_fault('query')
    async def test_commit_failure_replays_same_delivery_id(self):await self.run_fault('commit')
    async def test_shutdown_interrupts_idle_sleep(self):
        stop=asyncio.Event();task=asyncio.create_task(delivery.pause(stop,30));stop.set();await asyncio.wait_for(task,.2)

if __name__=='__main__':unittest.main()
