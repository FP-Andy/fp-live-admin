import assert from 'node:assert/strict';
import {validateDataset,emptyReview,assign,trackRange,saveCheckpoint,validateReview,identityAt,checkpointFrame} from '../apps/web/public/fpa-cv/core.mjs';
import {reconnect} from '../apps/web/public/fpa-cv/identity.mjs';
import {effectiveSegments} from '../apps/web/public/fpa-cv/integrity.mjs';
import {recoveryCacheKey} from '../apps/web/public/fpa-cv/recovery-protocol.mjs';
import {planCheckpoints} from '../apps/web/public/fpa-cv/checkpoint-plan.mjs';

const palette={home_gk:[[240,170,10]],home:[[210,30,30]],referee:[[230,240,150]],away:[[30,100,230]],away_gk:[[30,220,140]]};
function fixture(edit=()=>{},duration=6){
  const roster=emptyReview({datasetId:'cp'}).roster.map((p,i)=>({...p,jersey:p.group==='referee'?'REF':String(i)}));
  const make=(id,i,x=.1+(i%7)*.12,y=.25+Math.floor(i/7)*.4)=>({id,box:[x,y,x+.025,y+.06],confidence:.9,appearance:[{rgb:palette[roster[i].group][0],weight:1}]});
  const frames=Array.from({length:duration*10},(_,n)=>{const t=n/10,boxes=roster.map((p,i)=>make(i+1,i));edit(boxes,t,make);return {t,boxes};});
  const data=validateDataset({schema:'fpa-tracks/v1',datasetId:'cp',video:{name:'fixture.mp4',fps:30,width:1600,height:900,duration,clipStart:0,clipEnd:duration},detector:{sampleFps:10,roi:[[0,0],[1,0],[1,1],[0,1]]},frames});
  let review={...emptyReview(data),roster,uniforms:palette,setup:{time:0}};
  for(let i=0;i<13;i++)review=assign(review,data,i+1,...trackRange(data,i+1),{personId:roster[i].id,source:'manual'});
  return {data,review};
}
const run=(data,review)=>{const result=reconnect(data,review);return {result,working:{...review,segments:effectiveSegments(review,result)}};};

// A human point supplies both preceding and subsequent fragments. No raw ID
// whitelist or video timestamp special case is used by the algorithm.
const first=fixture((boxes,t,make)=>{
  if(t>=.5)boxes.splice(boxes.findIndex(b=>b.id===2),1);
  if(t>=2)boxes.push(make(t<3?101:102,1,.55,.4));
});
let review=saveCheckpoint(first.review,first.data,4.00001,[{trackId:102,personId:'home-1'}]);
assert.equal(review.checkpoints[0].time,4);assert.equal(review.checkpoints[0].to,4.1);
assert.deepEqual(validateReview(JSON.parse(JSON.stringify(review)),first.data),review,'Checkpoint backup restores exact observed frame');
const altered=structuredClone(review);altered.checkpoints[0].to=6;
assert.equal(validateReview(altered,first.data).checkpoints[0].to,4.1,'Imported duration cannot expand a point into an entire track');
assert.throws(()=>saveCheckpoint(review,first.data,4,[{trackId:999,personId:'home-1'}]));
assert.throws(()=>saveCheckpoint(review,first.data,4,[{trackId:102,personId:'home-1'},{trackId:3,personId:'home-1'}]));
assert.throws(()=>saveCheckpoint(review,first.data,4,[{trackId:102,personId:'home-1'},{trackId:102,personId:'home-2'}]));
assert.throws(()=>saveCheckpoint(review,first.data,6,[{trackId:102,personId:'home-1'}]));
assert.throws(()=>saveCheckpoint(review,first.data,0,[{trackId:2,personId:'home-1'}]),/초기 설정 이후/);
assert.throws(()=>validateReview({...review,checkpoints:[...review.checkpoints,...review.checkpoints]},first.data),/중복/);
const key=await recoveryCacheKey('cp',review);
assert.notEqual(key,await recoveryCacheKey('cp',first.review));
assert.equal(key,await recoveryCacheKey('cp',{...review,checkpointBudget:15}),'Changing human budget does not rerun identity computation');
let {result,working}=run(first.data,review);
assert.equal(identityAt(working,101,2.5)?.personId,'home-1','A later confirmation recovers preceding tracklet');
assert.equal(identityAt(working,102,5)?.personId,'home-1','And following observations');
assert.equal(identityAt(working,102,4)?.source,'manual');
assert.equal(identityAt(working,102,4.1)?.source,'auto','A single frame is not exported as a manually reviewed track');
assert.equal(result.checkpointDiagnostics.coordinateSystem,'court-normalized');
// Same observations under different track IDs, absolute timestamps, resolution
// and a calibrated affine crop must retain the same identities.
const moved=structuredClone(first.data),shift=100;
moved.video={...moved.video,width:3840,height:2160,clipStart:shift,clipEnd:moved.video.clipEnd+shift,duration:moved.video.duration+shift};
const xy=([x,y])=>[.02+.94*x,.1+.7*y];moved.detector.roi=moved.detector.roi.map(xy);
for(const f of moved.frames){f.t+=shift;for(const b of f.boxes){b.id+=500;const a=xy(b.box.slice(0,2)),z=xy(b.box.slice(2));b.box=[...a,...z];}}
const movedData=validateDataset(moved),movedReview=validateReview({...review,setup:{time:shift},segments:review.segments.map(s=>({...s,trackId:s.trackId+500,from:s.from+shift,to:s.to+shift})),checkpoints:review.checkpoints.map(c=>({...c,time:c.time+shift,assignments:c.assignments.map(a=>({...a,trackId:a.trackId+500}))}))},movedData);
const movedWorking=run(movedData,movedReview).working;
for(const f of first.data.frames)for(const b of f.boxes)assert.equal(identityAt(movedWorking,b.id+500,f.t+shift)?.personId,identityAt(working,b.id,f.t)?.personId,'Geometry/ID/time transformations cannot introduce video-specific decisions');

// One raw ID silently changing people is not licensed by a point confirmation.
const unobservable=fixture();
review=saveCheckpoint(unobservable.review,unobservable.data,4,[{trackId:2,personId:'home-2'}]);
({result,working}=run(unobservable.data,review));
assert.equal(identityAt(working,2,0)?.personId,'home-1','Initial observed truth survives');
assert.equal(identityAt(working,2,4)?.personId,'home-2','Later observed truth wins only at its sample');
assert.equal(identityAt(working,2,2),null,'Incompatible anchors on an uninterrupted ID must expose uncertainty');
assert(result.checkpointDiagnostics.conflictingIntervals>0);

// A spatial discontinuity creates independent pieces of the same ID.
const switched=fixture((boxes,t,make)=>{
  if(t>=2){boxes[1]=make(2,2,.8,.7);boxes.splice(boxes.findIndex(b=>b.id===3),1);}
});
review=saveCheckpoint(switched.review,switched.data,4,[{trackId:2,personId:'home-2'}]);
({working}=run(switched.data,review));
assert.equal(identityAt(working,2,1)?.personId,'home-1');
assert.equal(identityAt(working,2,3)?.personId,'home-2');

// Explicit rejections and exclusions survive the new solver in both directions.
review={...saveCheckpoint(first.review,first.data,4,[{trackId:102,personId:'home-1'}]),rejections:[{trackId:101,personId:'home-1',from:2,to:3}]};
({working}=run(first.data,review));assert.equal(identityAt(working,101,2.5),null);
review=assign(review,first.data,101,2,3,{team:'ignore',jersey:''});
({working}=run(first.data,review));assert.equal(identityAt(working,101,2.5)?.team,'ignore');
({working}=run(first.data,{...review,autoReconnect:false}));
assert.equal(identityAt(working,102,4)?.personId,'home-1');assert.equal(identityAt(working,102,5),null);

const competing=fixture((boxes,t,make)=>{
  if(t>=.5)boxes.splice(boxes.findIndex(b=>b.id===2),1);
  if(t>=2)boxes.push(make(101,1,.3,.45),make(102,1,.7,.45));
});
review=saveCheckpoint(competing.review,competing.data,3,[{trackId:101,personId:'home-1'}]);
review=saveCheckpoint(review,competing.data,4,[{trackId:102,personId:'home-1'}]);
({result,working}=run(competing.data,review));
for(const f of result.data.frames){const ids=f.boxes.map(b=>identityAt(working,b.id,f.t)?.personId).filter(Boolean);assert.equal(ids.length,new Set(ids).size,'One roster slot cannot occupy two automatic BBs');}

const planned=fixture(()=>{},60),known=planned.review.segments.map(s=>({...s,to:10}));
let plan=planCheckpoints(planned.data,planned.review,known);
assert.equal(plan.recommendations.length,1,'A single shared gap needs one clear scene before the next recomputation');assert(plan.recommendations.every(c=>c.time>=10&&c.clear>0));
assert.equal(new Set(plan.recommendations.map(c=>c.time)).size,plan.recommendations.length);
assert(plan.recommendations[0].time<12,'Prioritise the first separated scene after a sustained dropout');
const picked=plan.recommendations[0].time;
review=saveCheckpoint(planned.review,planned.data,picked,[{trackId:2,personId:'home-1'}]);
plan=planCheckpoints(planned.data,review,known);
assert(!plan.recommendations.some(c=>c.time===picked&&c.intervals.some(g=>g.personId==='home-1')),'Saved people are not requested again, while other people remain reviewable');
assert.equal(planCheckpoints(planned.data,planned.review,planned.review.segments).recommendations.length,0,'Do not demand annotations solely to fill a budget');
assert.equal(checkpointFrame(first.data,4.03).frame.t,4);
console.log('PASS: point-only anchors, import validation, cache invalidation, bidirectional fragments, conflicting same ID, discontinuity, operator exclusions/rejections, one-to-one occupancy, adaptive scene budgets and dropout priority.');
