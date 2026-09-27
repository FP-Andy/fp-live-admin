import assert from 'node:assert/strict';
import {ReviewBatch,previewSegments} from '../apps/web/public/fpa-cv/review-batch.mjs';
import {emptyReview,validateReview,assign,identityAt} from '../apps/web/public/fpa-cv/core.mjs';
import {emptyRecovery,recoveryInputs} from '../apps/web/public/fpa-cv/recovery-protocol.mjs';
const data={tracks:[{id:1,first:0,last:9},{id:2,first:0,last:9}],datasetId:'batch',video:{clipStart:0,clipEnd:10},detector:{sampleFps:1},frames:[{t:0,boxes:[{id:1},{id:2}]},{t:9,boxes:[{id:1},{id:2}]}]};
let review=emptyReview(data),calls=[],cancelled=0;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const create=()=>new ReviewBatch({data,getReview:()=>review,saveState:state=>{review={...review,batch:state};},compute:inputs=>{const d=deferred();calls.push({inputs,...d});return d.promise;},hydrate:r=>r,cancel:()=>cancelled++});
let batch=create(),first=batch.run({restore:true});assert.equal(calls.length,1);
review={...review,autoReconnect:false};assert(batch.dirty);assert.equal(batch.view.status,'pending');
assert.equal(await batch.run(),false,'No second job while the submitted snapshot is running');
calls[0].resolve({result:emptyRecovery(data,'complete')});await first;
assert.equal(batch.view.status,'staged');assert.equal(batch.round,0);assert.equal(calls.length,1,'Edits cannot trigger inference');
review={...review,autoReconnect:true};assert.equal(batch.view.status,'complete','Undo back to the applied state is immediately clean');
review={...review,autoReconnect:false};let job=batch.run();assert.equal(calls.length,2);
review={...review,roster:review.roster.map((p,i)=>({...p,jersey:i?'9':'8'}))};
assert.equal(calls[1].inputs.roster[0].jersey,'','Submitted inputs are immutable');
calls[1].resolve({result:emptyRecovery(data,'complete')});await job;
assert.equal(batch.round,1);assert.equal(batch.view.status,'staged','Mid-calculation edits remain pending');
// A reload restores only the last applied snapshot. Draft corrections survive.
review=validateReview(review,data);batch=create();job=batch.run({restore:true});
assert.equal(calls[2].inputs.roster[0].jersey,'');calls[2].resolve({result:emptyRecovery(data,'complete')});await job;
assert.equal(batch.round,1);assert(batch.dirty);assert.equal(review.roster[0].jersey,'8');
job=batch.run();calls[3].reject(Error('test failure'));await job;assert.equal(batch.round,1);assert(batch.dirty);assert.equal(batch.view.status,'error');
job=batch.run();batch.cancel();calls[4].resolve({result:emptyRecovery(data,'complete')});await job;assert.equal(batch.round,1);assert.equal(cancelled,1,'Explicit cancellation only');
job=batch.run();calls[5].resolve({result:emptyRecovery(data,'complete')});await job;assert.equal(batch.round,2);assert.equal(batch.view.status,'complete');
review={...review,events:[{row:{Action:'shot'}}],checkpointBudget:15};assert(!batch.dirty,'FPA and display preferences do not create pending identity changes');
for(let i=0;i<20;i++){
 review={...review,autoReconnect:!review.autoReconnect};job=batch.run();calls.at(-1).resolve({result:emptyRecovery(data,'complete')});await job;
}
assert.equal(batch.round,22,'No fixed round limit');
assert.equal(batch.history.length,23);assert.equal(batch.history.at(-1).version,23);
assert.equal(new Set(batch.history.map(h=>h.version)).size,23,'Reloading cannot duplicate result history');
const historyState=validateReview({...review,events:[],workflow:{reviewing:true}},data);assert.deepEqual(historyState.batch.history,batch.history);assert.equal(historyState.workflow.reviewing,true);
// A human correction is displayed immediately, even when a previous run has
// masks or the same person on a different automatic box.
let base=emptyReview(data);base.roster=base.roster.map((p,i)=>({...p,jersey:String(i+1)}));
let edited=assign(base,data,2,2,5,{personId:'home-1',locked:true});
let result={...emptyRecovery(data,'complete'),segments:[{trackId:1,personId:'home-1',from:0,to:10,source:'auto'},{trackId:2,personId:'away-1',from:0,to:10,source:'auto'}],masks:[{trackId:2,personId:'home-1',from:0,to:10}]};
let working={...edited,segments:previewSegments(edited,result,recoveryInputs(base))};
assert.equal(identityAt(working,2,3).personId,'home-1');assert.equal(identityAt(working,1,3),null);
assert.equal(identityAt(working,1,1).personId,'home-1');assert.equal(identityAt(working,2,6).personId,'away-1');
edited={...base,rejections:[{trackId:1,personId:'home-1',from:2,to:5}]};
working={...edited,segments:previewSegments(edited,result,recoveryInputs(base))};assert.equal(identityAt(working,1,3),null);
console.log('PASS: batch-only computation, immutable submissions, pending edits during calculation, reload, undo, failure, cancellation, unlimited rounds, FPA reuse, immediate correction/rejection overlays.');
