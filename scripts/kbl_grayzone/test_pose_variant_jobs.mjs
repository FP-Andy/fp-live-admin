import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoseVariant} from '../../apps/web/public/kbl-grayzone/pose-variant-jobs.mjs';

const capture='a'.repeat(24),jobId='b'.repeat(24);
const job=state=>({jobId,captureId:capture,state,stage:'보정 중'});
const result={variantId:'c'.repeat(24),pose:{meshUrl:'/mesh'}};
test('submits once and waits for a completed job',async()=>{
 const calls=[];let polls=0;
 const api=async(path,options)=>{calls.push([path,options]);if(options)return {job:job('queued')};return {job:++polls===1?job('running'):{...job('complete'),result}};};
 const messages=[];
 assert.deepEqual(await createPoseVariant(api,'/jobs',capture,{sleep:async()=>{},onProgress:s=>messages.push(s)}),result);
 assert.equal(calls.filter(([,options])=>options).length,1);assert.equal(polls,2);assert.equal(messages.length,2);
});
test('a temporary polling failure does not submit a duplicate job',async()=>{
 let posts=0,polls=0;
 const api=async(path,options)=>{if(options){posts++;return {job:job('queued')};}if(++polls===1)throw Error('offline');return {job:{...job('complete'),result}};};
 assert.deepEqual(await createPoseVariant(api,'/jobs',capture,{sleep:async()=>{}}),result);assert.equal(posts,1);
});
test('interrupted jobs and different scene results are not applied',async()=>{
 const api=async(path,options)=>options?{job:job('running')}:{job:{...job('interrupted'),error:'다시 시도하세요'}};
 await assert.rejects(createPoseVariant(api,'/jobs',capture,{sleep:async()=>{}}),/다시 시도/);
 await assert.rejects(createPoseVariant(async()=>({job:{...job('queued'),captureId:'f'.repeat(24)}}),'/jobs',capture,{sleep:async()=>{}}),/작업 정보/);
});
