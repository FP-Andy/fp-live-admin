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
