import assert from 'node:assert/strict';
import {uploadParts,transferMeter} from '../apps/web/public/fpa-cv/upload-parts.mjs';
const file=new Blob([new Uint8Array(125)]),partSize=10;
let active=0,peak=0,signatures=0;const signed=[],progress=[];
const parts=new Map([[2,'existing-etag']]),attempts=new Map();
const result=await uploadParts({file,partSize,parts,sleep:async()=>{},
 sign:async numbers=>{signatures++;signed.push(numbers);await new Promise(r=>setTimeout(r,1));return numbers.map(number=>({number,url:`${number}:${signatures}`}));},
 put:async(url,blob,update)=>{
  const n=Number(url.split(':')[0]);assert.notEqual(n,2);
  const attempt=(attempts.get(n)||0)+1;attempts.set(n,attempt);active++;peak=Math.max(peak,active);update(blob.size);
  await new Promise(r=>setTimeout(r,5));active--;
  if(n===4&&attempt===1)throw Error('transient');
  return 'etag-'+n;
 },progress:n=>{assert(n>=0&&n<=125);progress.push(n);}
});
assert.equal(peak,6);assert.equal(active,0);assert.equal(result.length,13);
assert.deepEqual(result.map(x=>x.PartNumber),Array.from({length:13},(_,i)=>i+1));
assert.equal(result[1].ETag,'existing-etag');assert.equal(attempts.get(4),2);
assert(signed.every(numbers=>numbers.length<=6));assert(signatures<12);assert.equal(progress.at(-1),125);
// A permanently failing part must not erase parts already accepted by S3.
const retryParts=new Map();
await assert.rejects(uploadParts({file:new Blob([new Uint8Array(30)]),partSize:10,parts:retryParts,sleep:async()=>{},
 sign:async ns=>ns.map(number=>({number,url:String(number)})),
 put:async url=>{if(url==='2')throw Error('offline');return 'accepted';}
}),/offline/);
assert.equal(retryParts.size,2);
const retried=[];
await uploadParts({file:new Blob([new Uint8Array(30)]),partSize:10,parts:retryParts,
 sign:async ns=>ns.map(number=>({number,url:String(number)})),
 put:async url=>{retried.push(url);return 'accepted';}
});assert.deepEqual(retried,['2']);
let time=0;const meter=transferMeter(1000,()=>time);
assert.equal(meter(100).remaining,null);time=5000;
assert.deepEqual(meter(600),{bytes:600,rate:100,remaining:4});
time=6000;assert(meter(200).rate<=100); // No false spike from a restarted part.
console.log('PASS: six-part concurrency, batched signing, retry, resume, ordered completion, bounded progress, measured rate/ETA');
