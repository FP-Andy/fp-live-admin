import assert from 'node:assert/strict';
import {ServerReview} from '../apps/web/public/fpa-cv/server-review.mjs';
const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
let version=0,saved=null,fail=false,puts=0;
const request=async(url,options)=>{
 if(!options)return {ok:true,json:async()=>({version,review:saved})};
 puts++;if(fail)throw Error('offline');
 const body=JSON.parse(options.body);if(body.version!==version)return {ok:false,status:409,json:async()=>({detail:'conflict'})};
 saved=body.review;version++;return {ok:true,json:async()=>({version})};
};
const create=()=>new ServerReview('test',{request,storage});
let sync=create();assert.equal(await sync.open(),null);
sync.stage({datasetId:'d',value:1});sync.stage({datasetId:'d',value:2});await sync.flush();
assert.equal(puts,1);assert.equal(saved.value,2);assert.equal(sync.dirty,false);
fail=true;sync.stage({datasetId:'d',value:3});await assert.rejects(sync.flush());assert.ok(storage.getItem(sync.key));
fail=false;sync=create();assert.equal((await sync.open()).value,3);await sync.flush();assert.equal(saved.value,3);
sync.stage({datasetId:'d',value:4});version++;saved={datasetId:'d',value:'other'};
await assert.rejects(sync.flush());assert.equal(sync.conflict,true);assert.equal(saved.value,'other');
sync=create();assert.equal((await sync.open()).value,4);assert.equal(sync.conflict,true);assert.equal(saved.value,'other');
console.log('PASS: coalesced saves, persistent retry after reload, optimistic conflicts preserve both revisions.');

// A native browser fetch rejects a ServerReview instance as its receiver.
// Injected arrow-function mocks above do not expose that browser-only failure.
const originalFetch=globalThis.fetch;
let browserRequests=0;
globalThis.fetch=function(...args){
 assert.equal(this,globalThis,'browser fetch must receive the global object');
 browserRequests++;
 return request(...args);
};
try{
 const browserSync=new ServerReview('browser-context',{storage});
 assert.deepEqual(await browserSync.open(),saved);
 browserSync.stage({datasetId:'browser-dataset',value:'edited'});
 await browserSync.flush();
 assert.equal(browserRequests,2);
 assert.equal(saved.value,'edited');
 assert.equal(browserSync.dirty,false);
}finally{
 globalThis.fetch=originalFetch;
}
console.log('PASS: default browser fetch receiver for opening and autosaving reviews.');
