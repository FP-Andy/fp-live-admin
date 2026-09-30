import assert from 'node:assert/strict';
import {reconstructGap,reconstructPlayer,occupancyGrid} from '../apps/web/public/fpa-cv/heatmap-reconstruction.mjs';
const sum=a=>a.reduce((s,x)=>s+x,0),near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const point=t=>({t,x:(10+t)/40,y:.5,seconds:.1,trackId:7,source:'manual'});
const left=Array.from({length:11},(_,i)=>point(i/10)),right=Array.from({length:11},(_,i)=>point(2.1+i/10));
for(const method of ['linear','hermite','bridge-linear','bridge-hermite']){
  const result=reconstructGap(left,right,{method,diffusion:.15});assert(result.accepted);near(result.seconds,1);
  for(const p of result.samples)near(p.x,(10+p.t)/40);
  near(sum(occupancyGrid(result.samples)),1);
}
assert.equal(reconstructGap(left,right.map(p=>({...p,trackId:8}))).reason,'identityBoundary');
assert.equal(reconstructGap(left,right,{maxGapSeconds:.5}).reason,'longGap');
assert.equal(reconstructGap(left,right,{},[{from:1.5,to:1.6,reason:'outside'}]).reason,'blockedInterval');
assert.equal(reconstructGap(left,[]).reason,'missingAnchor');
assert.equal(reconstructGap(left.slice(-2),right).reason,'shortContext');
assert.equal(reconstructGap(left,right.map(p=>({...p,x:.99}))).reason,'implausibleMotion');
const jitter=structuredClone(left);jitter[4].y=.99;assert.equal(reconstructGap(jitter,right).reason,'unstableAnchor');
const input={positions:[...left,...right],grid:[1,2],coverage:.22,missing:4,observed:2.2,blockedIntervals:[]},original=JSON.stringify(input);
const result=reconstructPlayer(input,{method:'bridge-linear',diffusion:.15});
assert.equal(JSON.stringify(input),original,'All observed data must remain byte-for-byte unchanged');
near(result.inferredSeconds,1);near(sum(result.estimatedGrid),1);near(result.unfilledSeconds,3);assert.equal(result.gaps.length,1);
assert.equal(reconstructPlayer({positions:left,missing:10}).inferredSeconds,0,'No leading or trailing extrapolation');
assert.equal(reconstructPlayer({...input,blockedIntervals:[{from:1.4,to:1.8}]}).inferredSeconds,0);
near(sum(occupancyGrid([{x:0,y:0,seconds:1,sigma:.4},{x:1,y:1,seconds:2,sigma:.4}])),3,'Court boundaries conserve admitted time');
assert.throws(()=>occupancyGrid([{x:-.1,y:.5,seconds:1}]));
assert.throws(()=>reconstructGap(left,right,{sampleSeconds:0}));
console.log('PASS: anchor identity, blocked exits/conflicts, no extrapolation, motion limits, uncertainty mass conservation, immutable observations.');
