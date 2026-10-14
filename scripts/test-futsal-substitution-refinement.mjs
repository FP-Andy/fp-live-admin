import assert from 'node:assert/strict';
import {refineEvidence,addOverlapLinks,weakObservationSupported} from '../apps/web/public/fpa-cv/substitution-refinement.mjs';
import {buildContinuationGraph,continueSubstitutionReport} from '../apps/web/public/fpa-cv/substitution-continuity.mjs';
const snapshot={review:{uniforms:{home:[[255,0,0]],away:[[0,0,255]]}}};
function path(id,from,to,{team='home',shift=0,shadow=false}={}){
 const list=[];
 for(let i=Math.round(from*10);i<Math.round(to*10);i++){
  const t=i/10,x=.2+t*.02+shift;
  list.push({t,dt:.1,xy:[x+(shadow?.03:0),.5],heatXY:[x+(shadow?.03:0),.5],b:{id,confidence:.9,appearance:[{rgb:team==='home'?[255,0,0]:[0,0,255],weight:.2}],box:[x-.015,.46,x+.015+(shadow?.06:0),.5]}});
 }
 return {id,ids:[id],list};
}
const evidence=paths=>({step:.1,paths:new Map(paths.map(p=>[p.id,p])),pathOf:new Map(paths.map(p=>[p.id,p])),crossings:[]});
const graph=paths=>{const ev=refineEvidence(evidence(paths),snapshot);return addOverlapLinks(ev,snapshot,buildContinuationGraph(ev,snapshot));};
let a=path(1,0,8,{shadow:true}),b=path(2,0,15);
assert.equal(graph([a,b]).next.get(1)?.b,2);
assert(!graph([a,b,path(3,0,15)]).next.has(1),'equal duplicates do not assign an identity');
assert(!graph([a,path(2,0,15,{team:'away'})]).next.has(1));
b=path(2,0,15);for(const o of b.list)if(o.t<4){o.xy[0]+=.15;o.b.box[0]+=.15;o.b.box[2]+=.15;}
assert(!graph([a,b]).next.has(1),'previously separate people cannot be merged');

const switchPath=path(4,0,8);
for(const o of switchPath.list)if(o.t>=4)o.b.appearance=[{rgb:[0,0,255],weight:.2}];
const original=JSON.stringify(switchPath),ev=refineEvidence(evidence([switchPath]),snapshot);
assert.equal(ev.splits.length,1);assert.equal(ev.splits[0].time,4);
assert.notEqual(ev.pathAt(4,3).id,ev.pathAt(4,5).id);
assert.equal(JSON.stringify(switchPath),original);
const flash=path(5,0,8);flash.list[40].b.appearance=[{rgb:[0,0,255],weight:.2}];
assert.equal(refineEvidence(evidence([flash]),snapshot).splits.length,0,'one bad colour frame must not split');

const make=points=>({id:'sub-x',group:'home',jersey:'7',activeFrom:0,activeTo:8,substitutionStint:{kind:'substitute',entryTrackId:4,from:0,to:8},positions:points.map(o=>({t:o.t,x:o.xy[0],y:o.xy[1],seconds:o.dt,trackId:o.b.id,source:'automatic'})),observed:points.length*.1,grid:[],blockedIntervals:[],inactiveIntervals:[]});
const report=p=>({heatmap:{from:0,to:12,width:80,height:40,players:[p]},events:[{id:'e',inPersonId:p.id,status:'automatic'}]});
let p=make(switchPath.list);p.positions[50].source='manual';
const r=report(p);continueSubstitutionReport(snapshot,evidence([switchPath,path(6,4,12)]),{log:{substitutions:[]}},r);
assert(p.positions.some(q=>q.t===5&&q.source==='manual'),'explicit human observation preserved');
assert(!p.positions.some(q=>q.trackId===4&&q.t>=4&&q.source==='automatic'),'already assigned wrong-team observations removed');
assert(p.positions.some(q=>q.trackId===6&&q.t>6),'original person recovered after ID switched to opponent');
assert(r.continuation.audit[0].manualConflicts>0);

const weak=path(8,0,5);weak.list[20].b.confidence=.2;
const we=refineEvidence(evidence([weak]),snapshot);
assert(weakObservationSupported(weak,20,we,'home'));
weak.list[20].xy[0]+=.2;
assert(!weakObservationSupported(weak,20,we,'home'),'weak teleport rejected');
weak.list[20].xy[0]-=.2;weak.list[0].b.confidence=.2;
assert(!weakObservationSupported(weak,0,we,'home'),'unbracketed birth rejected');

const wide=path(10,0,2),one=path(11,0,2),two=path(12,0,2,{shift:.05,team:'away'});
for(const o of wide.list){o.b.box[0]-=.02;o.b.box[2]+=.075;}
const qe=refineEvidence(evidence([wide,one,two]),snapshot);
assert.equal(qe.excluded.size,20,'merged two-person box excluded');
assert(!qe.qualityReason(one.list[0]),'real bodies retained');
assert.equal(refineEvidence(evidence([wide,one]),snapshot).excluded.size,0,'one contained body is not two people');
const expanding=path(15,0,4);
for(const o of expanding.list)if(o.t>=2&&o.t<3){const b=o.b.box;b[0]-=.02;b[2]+=.02;b[1]-=.04;}
const ge=refineEvidence(evidence([expanding]),snapshot);
assert.equal(ge.qualityReason(expanding.list[25]),'geometry-jump','unresolved enlarged contact box is not a foot position');
assert(!ge.qualityReason(expanding.list[35]),'body geometry recovered after contact');
console.log('PASS: duplicate handoff, ambiguity, prior separation, stable switch splitting, automatic-tail repair, human preservation, alternate path recovery, weak detections and merged-box quality.');

const briefA=path(21,0,2),briefB=path(22,1.8,5);
assert.equal(graph([briefA,briefB]).next.get(21)?.b,22,'two repeated same-body frames can bridge a tracker reset');
assert(!graph([briefA,briefB,path(23,1.8,5)]).next.has(21),'short overlap still requires reciprocal uniqueness');
const missing=path(24,0,7);missing.list=missing.list.filter(o=>o.t<2||o.t>4.5);
const gapEvidence=refineEvidence(evidence([missing]),snapshot);
assert.notEqual(gapEvidence.pathAt(24,1).id,gapEvidence.pathAt(24,5).id,'ID reappearance after a gap is not automatic identity evidence');
assert(gapEvidence.splits.some(s=>s.reason==='observation-gap'));
const mixed=path(25,0,8);for(const o of mixed.list)if(o.t>=2&&o.t<5)o.b.appearance=[{rgb:[0,0,255],weight:.2},{rgb:[255,0,0],weight:.1}];
const mixedEvidence=refineEvidence(evidence([mixed]),snapshot);
assert.equal(mixedEvidence.splits.length,0,'both visible shirt colours must not establish a team change');
assert.equal(mixedEvidence.team(mixed.list[30]),null);
for(const o of mixed.list)if(o.t>=5)o.b.appearance=[{rgb:[0,0,255],weight:.2}];
assert.equal(refineEvidence(evidence([mixed]),snapshot).splits[0].time,5,'clean opposite kit still splits after contact');
console.log('PASS v2: brief duplicated track reset, ambiguity, raw-ID gap, mixed shirt quarantine and clean post-contact switch.');

const reused=path(4,0,8);reused.list=reused.list.filter(o=>o.t<2||o.t>=5);
for(const o of reused.list)if(o.t>=5){o.xy[0]+=.2;o.heatXY[0]+=.2;o.b.box[0]+=.2;o.b.box[2]+=.2;}
const replacement=path(40,1.8,8),gapPerson=make(reused.list),gapReport=report(gapPerson);
gapPerson.positions.find(q=>q.t===6).source='manual';
continueSubstitutionReport(snapshot,evidence([reused,replacement]),{log:{substitutions:[]}},gapReport);
assert(!gapPerson.positions.some(q=>q.trackId===4&&q.t>=5&&q.source==='automatic'),'disconnected reused raw ID must not retain its automatic tail');
assert(gapPerson.positions.some(q=>q.trackId===4&&q.t===6&&q.source==='manual'),'manual tail remains unchanged');
assert(gapPerson.positions.some(q=>q.trackId===40&&q.t>6),'use the independently connected successor');
assert.equal(gapReport.continuation.audit[0].scene.time,gapPerson.positions.at(-1).t,'last scene is an accepted observation');
console.log('PASS: disconnected automatic tail repaired without overwriting a human observation.');
