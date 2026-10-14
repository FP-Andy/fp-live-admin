import test from 'node:test';import assert from 'node:assert/strict';
import {guardSubstitutionIdentities} from '../apps/web/public/fpa-cv/substitution-identity-guard.mjs';
import {augmentPlayerActivity} from '../apps/web/public/fpa-cv/heatmap-augmentation.mjs';
const o=(id,t,x,y=.5)=>({t,dt:.1,b:{id,confidence:.9,box:[x-.01,y-.03,x+.01,y]},xy:[x,y],heatXY:[x,y]});
const q=o=>({t:o.t,x:o.xy[0],y:o.xy[1],seconds:.1,trackId:o.b.id,source:'automatic'});
function fixture(tracks,positions,entryTrackId=1){const p={id:'new',group:'home',jersey:'7',activeFrom:0,activeTo:100,substitutionStint:{kind:'substitute',entryTrackId},positions,observed:positions.length*.1,grid:Array(8).fill(0)};const snapshot={heatmap:{court:{lengthM:40,widthM:20}}},result={status:'ready',events:[{inPersonId:'new',status:'confirmed'}],heatmap:{from:0,to:100,width:4,height:2,players:[p],substitutionsApplied:true}};return {p,snapshot,result,ev:{step:.1,paths:new Map(tracks.map((list,i)=>[i,{list}]))}};}
const run=f=>guardSubstitutionIdentities(f.snapshot,f.ev,f.result);
test('entry identity wins even when the inherited report starts on another teammate',()=>{
 const a=[o(1,0,.2),o(1,.1,.2),o(1,.2,.2)],b=[o(2,0,.7),o(2,.1,.7)];const f=fixture([a,b],[q(b[0]),q(b[1]),q(a[2])]);const original=structuredClone(f.snapshot);run(f);
 assert.deepEqual(f.p.positions.map(p=>p.trackId),[1]);assert.deepEqual(f.snapshot,original);assert.equal(f.result.status,'review');assert.equal(f.result.identityGuard.audit[0].conflicts[0].reason,'simultaneous-distinct-bodies');
});
test('quarantine rejects a whole rival fragment, not only the jumping frame',()=>{
 const a=[0,.1,.2,.3].map(t=>o(1,t,.2)),b=[0,.1,.2,.3].map(t=>o(2,t,.7));const f=fixture([a,b],[q(a[0]),q(b[1]),q(b[2]),q(a[3])]);run(f);
 assert.deepEqual(f.p.positions.map(p=>p.trackId),[1,1]);assert.equal(f.p.blockedIntervals[0].to,.3);
});
test('overlapping duplicate boxes on the same body can hand off',()=>{
 const a=[o(1,0,.2),o(1,.1,.201)],b=[o(2,.1,.201),o(2,.2,.202)];const f=fixture([a,b],[q(a[0]),q(b[0]),q(b[1])]);assert.equal(run(f).changed.size,0);
});
test('same raw ID teleport is a new incompatible fragment',()=>{
 const a=[o(1,0,.2),o(1,.1,.7),o(1,.2,.7)];const f=fixture([a],a.map(q));run(f);assert.equal(f.p.positions.length,1);assert.equal(f.result.identityGuard.audit[0].conflicts[0].reason,'impossible-transition');
});
test('disconnected descendants are withheld after a proved identity conflict',()=>{
 const a=[o(1,0,.2),o(1,.1,.2)],b=[o(2,0,.7),o(2,.1,.7)],c=[o(3,10,.7)];const f=fixture([a,b,c],[q(a[0]),q(b[1]),q(c[0])]);run(f);assert.equal(f.p.positions.length,1);assert.equal(f.p.blockedIntervals[0].to,100);
});
test('a reviewed anchor can resume a gap, with no silent override of a proved conflict',()=>{
 const a=[o(1,0,.2),o(1,.1,.2)],b=[o(2,0,.7),o(2,.1,.7)],c=[o(3,10,.7)];const f=fixture([a,b,c],[q(a[0]),{...q(b[1]),identitySource:'assistant-video-review'},{...q(c[0]),identitySource:'assistant-video-review'}]);run(f);
 assert.deepEqual(f.p.positions.map(p=>p.trackId),[1,3]);assert.equal(f.result.identityGuard.audit[0].manualConflictSeconds,.1);
});
test('legacy manual source does not excuse an impossible identity jump',()=>{
 const a=[o(1,0,.2)],b=[o(2,.1,.7)];const f=fixture([a,b],[q(a[0]),{...q(b[0]),source:'manual'}]);run(f);assert.equal(f.p.positions.length,1);assert.equal(f.result.identityGuard.audit[0].manualConflictSeconds,.1);
});
test('ordinary gaps are not removed merely because the raw ID changed',()=>{
 const a=[o(1,0,.2)],b=[o(2,10,.7)];const f=fixture([a,b],[q(a[0]),q(b[0])]);assert.equal(run(f).changed.size,0);
});
test('repeat verification preserves prior quarantine audit and retained coordinates',()=>{
 const a=[o(1,0,.2),o(1,.1,.7)];const f=fixture([a],a.map(q));run(f);const before=structuredClone(f.result);run(f);assert.deepEqual(f.result,before);
});
test('augmentation cannot refill quarantined identity time',()=>{
 const p={positions:[{t:0,x:.2,y:.5,seconds:10},{t:20,x:.3,y:.5,seconds:10}],blockedIntervals:[{from:10,to:20,reason:'identity-conflict'}]};
 const a=augmentPlayerActivity(p,{from:0,to:30,width:4,height:2,targetRatio:.3});assert.equal(a.inferredSeconds,0);
});

test('automatic continuation does not resurrect observations outside a video-reviewed scope',async()=>{
 const {continueSubstitutionReport}=await import('../apps/web/public/fpa-cv/substitution-continuity.mjs');
 const rows=[0,.1,.2,.3,.4,.5].map(t=>o(1,t,.2));const f=fixture([rows],[q(rows[0])]);
 const path={id:1,ids:[1],list:rows};const ev={step:.1,paths:new Map([[1,path]]),pathOf:new Map([[1,path]]),crossings:[]};
 const automatic=structuredClone(f.result);continueSubstitutionReport(f.snapshot,ev,{log:{substitutions:[]}},automatic);assert(automatic.heatmap.players[0].positions.length>1);
 f.p.substitutionStint.visualReviewId='verified-scope';continueSubstitutionReport(f.snapshot,ev,{log:{substitutions:[]}},f.result);assert.equal(f.p.positions.length,1);
});

test('explicit video-reviewed time scope survives an earlier raw-ID identity switch',()=>{
 const a=[o(1,0,.2),o(1,.1,.2)],b=[o(2,0,.7),o(2,.1,.7),o(2,.2,.2)];const f=fixture([a,b],[q(a[0]),q(b[2])]);
 f.p.substitutionStint.visualReviewId='video-reviewed-time-ranges';const before=structuredClone(f.p.positions);run(f);assert.deepEqual(f.p.positions,before);assert.equal(f.result.identityGuard.audit.length,0);
});
