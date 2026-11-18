import assert from 'node:assert/strict';
import {mountReportVideoBox} from '../../apps/web/public/kbl-grayzone/report-video-box.mjs';

class Element {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.disabled=false;this.checked=false;this.textContent='';}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
}
const nodes=Object.fromEntries(['includeVideos','videoReadyList','reportVideoProgress','checkVideoReady'].map(id=>[id,new Element()]));
let iframeCount=0;
globalThis.document={getElementById:id=>nodes[id],createElement:tag=>{if(tag==='iframe')iframeCount++;return new Element(tag);}};
let lookups=0,otherWrites=0;
const job={jobId:'a'.repeat(24),state:'running',stage:'영상 제작 2/7',videos:[]};
const api=async(path,payload)=>{
 if(path.endsWith('/report-video-readiness'))return {ready:true,events:[{number:1,eventId:'review-1',ready:true,autoPrepare:true}]};
 if(path.endsWith('/report-video-batches'))return {job:++lookups===1?null:job};
 if(path.includes('/report-video-batches/'))return {job:{...job,state:'complete'}};
 if(payload)otherWrites++;
 throw Error('Unexpected request: '+path);
};
const box=mountReportVideoBox({caseId:'game-test',api,onChange(){},onComplete:async()=>{},onPrepared:async()=>{}});
assert.equal(box.canGenerate(),false,'The prior batch must be checked before enabling generation');
await box.restore();nodes.includeVideos.checked=true;await nodes.checkVideoReady.onclick();
assert.equal(box.canGenerate(),true);
await box.start(1);
assert.equal(iframeCount,0,'An already running batch must not start another automatic pose preparation');
assert.equal(otherWrites,0);
console.log('Existing batch is restored before any new automatic preparation.');

let created=0,previewFrames=0;
const originalCreate=globalThis.document.createElement;
globalThis.document.createElement=tag=>{if(tag==='iframe')previewFrames++;return originalCreate(tag);};
const newApi=async(path,payload)=>{
 if(path.endsWith('/report-video-readiness'))return {ready:true,events:[{number:1,eventId:'review-1',ready:true,autoPrepare:true}]};
 if(path.endsWith('/report-video-batches')&&payload){created++;assert.deepEqual(payload,{revision:1,events:['review-1']});return {job:{...job,state:'complete',report:{pdf:'/report.pdf'}}};}
 if(path.endsWith('/report-video-batches'))return {job:null};
 if(path.includes('/report-video-batches/'))return {job:{...job,state:'complete',report:{pdf:'/report.pdf'}}};
 throw Error('Unexpected request: '+path);
};
const next=mountReportVideoBox({caseId:'game-test',api:newApi,onChange(){},onComplete:async()=>{},onPrepared:async()=>{throw Error('browser must not prepare pose');}});
await next.restore();nodes.includeVideos.checked=true;await nodes.checkVideoReady.onclick();await next.start(1);
assert.equal(created,1,'The batch is registered before any pose preparation');
assert.equal(previewFrames,0,'The user browser never owns the pose preparation');
console.log('New jobs are registered immediately and pose work is server-owned.');

let retryPayload;
const partial={jobId:'d'.repeat(24),state:'interrupted',stage:'확인 필요',events:['review-1','review-2','review-3','review-4'],videos:[{eventId:'review-1',state:'complete',jobId:'e'.repeat(24)},{eventId:'review-2',state:'failed',error:'실패'},{eventId:'review-3',state:'stale',error:'확인 필요'}]};
const retryApi=async(path,payload)=>{
 if(path.endsWith('/report-video-batches')&&payload){retryPayload=payload;return {job:{...job,state:'complete',videos:[],report:{pdf:'/report.pdf'}}};}
 if(path.endsWith('/report-video-batches'))return {job:partial};
 if(path.includes('/report-video-batches/'))return {job:{...job,state:'complete',videos:[],report:{pdf:'/report.pdf'}}};
 throw Error('Unexpected request: '+path);
};
const retryBox=mountReportVideoBox({caseId:'game-test',api:retryApi,onChange(){},onComplete:async()=>{},getRevision:()=>3,canRetry:()=>true});
await retryBox.restore();
const retryButton=nodes.reportVideoProgress.children.find(el=>el.tagName==='button');assert.ok(retryButton);
await retryButton.onclick();assert.deepEqual(retryPayload,{revision:3,events:['review-2','review-4']});
console.log('Retry submits all failed and unstarted scenes, preserving completed and stale scenes.');

const subset={jobId:'b'.repeat(24),state:'complete',stage:'PDF·영상 제작 완료',events:['review-2'],videos:[{eventId:'review-2',state:'complete',jobId:'e'.repeat(24)}]};
const subsetBox=mountReportVideoBox({caseId:'game-test',api:async()=>({job:subset}),onChange(){},onComplete:async()=>{},getTotal:()=>4});
await subsetBox.restore();assert.ok(nodes.reportVideoProgress.children.some(el=>el.textContent==='선택한 1개 장면 제작 완료'));

const queued={jobId:'f'.repeat(24),state:'running',stage:'영상 제작 2/3',events:['review-1','review-2','review-3'],currentEvent:'review-2',videos:[{eventId:'review-1',state:'complete',jobId:'e'.repeat(24)}]};
const queueApi=async path=>path.endsWith('/report-video-batches')?{job:queued}:new Promise(()=>{});
const queueBox=mountReportVideoBox({caseId:'game-test',api:queueApi,onChange(){},onComplete:async()=>{}});await queueBox.restore();
const lines=nodes.reportVideoProgress.children.map(el=>el.textContent);
assert.ok(lines.includes('2번 장면 제작 중'));assert.ok(lines.includes('제작 대기 · 3번'));
console.log('Current and remaining scenes are displayed in queue order.');
