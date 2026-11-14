import test from 'node:test';
import assert from 'node:assert/strict';
import {taskElapsedSeconds} from '../../apps/web/public/kbl-grayzone/task-duration.mjs';
test('elapsed time is available only with reliable timestamps',()=>{
 const start=Date.parse('2026-11-11T00:00:00Z'),now=start+90000;
 assert.equal(taskElapsedSeconds({state:'running'},start,now),90);
 assert.equal(taskElapsedSeconds({state:'complete'},start,now),null);
 assert.equal(taskElapsedSeconds({state:'complete',completedAt:'2026-11-11T00:00:20Z'},start,now),20);
 assert.equal(taskElapsedSeconds({state:'complete'},null,now),null);
});
