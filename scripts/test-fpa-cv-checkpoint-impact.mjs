import assert from 'node:assert/strict';
import {planCheckpoints,CHECKPOINT_PLAN_VERSION} from '../apps/web/public/fpa-cv/checkpoint-plan.mjs';

const uniforms={home:[[210,30,30]],away:[[30,100,230]],home_gk:[[240,170,10]],away_gk:[[30,220,140]],referee:[[230,240,150]]};
function fixture(duration=100){
  const roster=Array.from({length:10},(_,i)=>({id:`p${i}`,group:i<5?'home':'away',jersey:String(i%5+2)}));
  const frames=Array.from({length:duration*10},(_,i)=>({t:i/10,boxes:roster.map((p,j)=>({id:j+1,box:[.05+j*.09,.4,.08+j*.09,.5],confidence:.9,appearance:[{rgb:uniforms[p.group][0],weight:1}]}))}));
  const data={video:{clipStart:0,clipEnd:duration,width:1600,height:900},detector:{sampleFps:10,roi:[[0,0],[1,0],[1,1],[0,1]]},frames};
  const review={roster,uniforms,setup:{time:0},checkpoints:[]};
  const known=roster.map((p,j)=>({trackId:j+1,personId:p.id,team:p.group,from:0,to:duration}));
  return {data,review,known};
}
const f=fixture();
const known=f.known.map(s=>({...s,to:s.personId==='p8'||s.personId==='p9'?10:s.personId==='p0'?50:s.to}));
// The first two seconds after disconnection are still merged; a known player
// elsewhere cannot make that frame useful for identifying these missing ones.
for(const frame of f.data.frames)if(frame.t>=10&&frame.t<12)frame.boxes[9].box=frame.boxes[8].box.slice();
const input=JSON.stringify({f,known});
let plan=planCheckpoints(f.data,f.review,known);
assert.equal(plan.version,CHECKPOINT_PLAN_VERSION);
const first=plan.recommendations[0];
assert(first.time>=12&&first.time<15,'Long gap is prioritised at the first clear post-occlusion scene');
assert.deepEqual(new Set(first.intervals.map(g=>g.personId)),new Set(['p8','p9']));
assert(Math.abs(first.relatedSeconds-180)<1e-6,'Time counts two missing players, not the whole clip or all visible players');
assert(first.trackIds.includes(9)&&first.trackIds.includes(10));
assert.equal(plan.recommendations.length,2,'One recommendation for a shared gap, one for the separate home dropout');
assert.equal(JSON.stringify({f,known}),input,'Planning never changes human annotations or raw observations');
assert.deepEqual(plan,planCheckpoints(f.data,f.review,known),'Ranking is deterministic');

const nextKnown=known.map(s=>({...s,to:['p8','p9'].includes(s.personId)?100:s.to}));
plan=planCheckpoints(f.data,f.review,nextKnown);
assert.deepEqual(plan.recommendations[0].intervals.map(g=>g.personId),['p0'],'Applied recovery removes solved gaps from the next round');
assert.equal(planCheckpoints(f.data,f.review,f.known).recommendations.length,0);

const invisible=fixture();
for(const frame of invisible.data.frames)if(frame.t>=10)frame.boxes=frame.boxes.filter(b=>b.id!==10);
const short=invisible.known.map(s=>({...s,to:s.personId==='p9'?10:s.to}));
assert.equal(planCheckpoints(invisible.data,invisible.review,short).recommendations.length,0,'Missing detections cannot be replaced by known, clear players elsewhere');
for(const frame of invisible.data.frames)if(frame.t>=10)frame.boxes.push({id:11,box:[.9,.4,.93,.5],confidence:.9,appearance:[{rgb:uniforms.home_gk[0],weight:1}]});
assert.equal(planCheckpoints(invisible.data,invisible.review,short).recommendations.length,0,'A goalkeeper cannot count as a visible field player');
for(const frame of invisible.data.frames)if(frame.t>=10)frame.boxes.at(-1).appearance=[{rgb:uniforms.away[0],weight:1}];
assert(planCheckpoints(invisible.data,invisible.review,short).recommendations.length>0,'An unassigned same-team BB makes the scene actionable');
assert.equal(planCheckpoints(invisible.data,invisible.review,[...short,{trackId:11,team:'ignore',from:0,to:100}]).recommendations.length,0,'Explicit exclusions survive planning');

const partial=fixture(20),partialKnown=partial.known.filter(s=>!['p8','p9'].includes(s.personId));
const initial=planCheckpoints(partial.data,partial.review,partialKnown).recommendations[0];
const partialReview={...partial.review,checkpoints:[{time:initial.time,assignments:[{personId:'p8',trackId:9}]}]};
const confirmed=planCheckpoints(partial.data,partialReview,partialKnown);
assert(confirmed.recommendations.some(c=>c.missing.includes('p9')),'Confirming one player never suppresses another player in that scene');
assert(confirmed.recommendations.every(c=>!c.intervals.some(g=>g.personId==='p8')||Math.abs(c.time-initial.time)>=.15));

const shifted=structuredClone(f),offset=73;
shifted.data.video.clipStart+=offset;shifted.data.video.clipEnd+=offset;shifted.review.setup.time+=offset;
for(const frame of shifted.data.frames)frame.t+=offset;
const shiftedPlan=planCheckpoints(shifted.data,shifted.review,known.map(s=>({...s,from:s.from+offset,to:s.to+offset})));
assert(Math.abs(shiftedPlan.recommendations[0].time-offset-first.time)<1,'Recommendations do not depend on a particular video timestamp');
assert(Math.abs(shiftedPlan.recommendations[0].relatedSeconds-first.relatedSeconds)<1e-6);
console.log('PASS: actionable post-occlusion priority, exact affected seconds, next-round reprioritisation, no repeated gap filling, partial anchors, exclusions, visibility, colours, deterministic immutable inputs and timestamp independence.');
