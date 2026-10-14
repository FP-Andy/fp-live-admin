import assert from 'node:assert/strict';
import {buildContinuationGraph,continueSubstitutionReport} from '../apps/web/public/fpa-cv/substitution-continuity.mjs';
const snapshot={review:{uniforms:{home:[[255,0,0]],away:[[0,0,255]]}}};
function path(id,from,to,{shift=0,team='home',size=1,y=.5,v=.015}={}){const list=[];for(let t=from;t<=to+1e-5;t+=.2){const x=.2+t*v+shift;list.push({t,dt:.2,xy:[x,y],heatXY:[x,y],b:{id,confidence:.9,appearance:[{rgb:team==='home'?[255,0,0]:[0,0,255],weight:1}],box:[x-.01*size,y-.02,x+.01*size,y+.02]}});}return {id,ids:[id],list};}
const evidence=paths=>({step:.2,paths:new Map(paths.map(p=>[p.id,p])),pathOf:new Map(paths.map(p=>[p.id,p])),crossings:[]});
const a=path(1,0,2,{size:3}),b=path(2,2.4,12),ev=evidence([a,b]);assert.equal(buildContinuationGraph(ev,snapshot).next.get(1)?.b,2,'recover short merge/split despite changing bounding box');
assert(!buildContinuationGraph(evidence([a,b,path(3,2.4,12,{shift:.001})]),snapshot).next.has(1),'ambiguous fork must stay unresolved');
assert(!buildContinuationGraph(evidence([a,path(2,2.4,12,{team:'away'})]),snapshot).next.has(1),'opposite kit cannot be joined');
assert(!buildContinuationGraph(evidence([a,path(2,7,12)]),snapshot).next.has(1),'long unsupported gap must stay empty');
const make=(id,number,entry,from,to,observations)=>({id,group:'home',jersey:number,activeFrom:from,activeTo:to,substitutionStint:{kind:'substitute',entryTrackId:entry,from,to},positions:observations.map(o=>({t:o.t,x:o.xy[0],y:o.xy[1],seconds:o.dt,trackId:o.b.id,source:'automatic'})),observed:observations.length*.2,grid:[],blockedIntervals:[],inactiveIntervals:[]});
const p1=make('sub-1','7',1,0,2.2,a.list),p2=make('sub-2','8',2,8,12.2,b.list.filter(o=>o.t>=8-1e-6)),report={heatmap:{from:0,to:12.2,width:80,height:40,players:[p1,p2]},events:[{id:'e1',inPersonId:'sub-1',status:'automatic'},{id:'e2',inPersonId:'sub-2',status:'automatic'}]};
const untouched=JSON.stringify(ev);const {result}=continueSubstitutionReport(snapshot,ev,{log:{substitutions:[]}},report);
assert.equal(JSON.stringify(ev),untouched,'source detections are immutable');assert(result.heatmap.players[0].observed>7,'use pre-entry part of a future seed path');assert(result.heatmap.players[0].positions.every(q=>q.t+q.seconds<=8+1e-6),'do not cross next independent entry');assert.equal(result.heatmap.players[1].observed,p2.observed);
const seen=new Map;for(const p of result.heatmap.players)for(const q of p.positions){const k=q.t.toFixed(4)+':'+q.trackId;assert(!seen.has(k),'each detection allocated once');seen.set(k,p.id);}
console.log('PASS: morphology change, reciprocal uniqueness, opposite team, long gaps, independent entry boundary and single allocation.');
const switched=path(2,2.4,12);for(const q of switched.list)if(q.t>=6)q.b.appearance=[{rgb:[0,0,255],weight:.14}];
const original=make('sub-x','7',1,0,2.2,a.list),r2={heatmap:{from:0,to:12.2,width:80,height:40,players:[original]},events:[{id:'x',inPersonId:'sub-x',status:'automatic'}]};
continueSubstitutionReport(snapshot,evidence([a,switched]),{log:{substitutions:[]}},r2);assert(r2.heatmap.players[0].positions.every(q=>q.t<6),'sustained opposite kit terminates a tracker ID before later joins');assert(r2.continuation.audit[0].oppositeKitStop);
console.log('PASS: stable raw ID cannot silently switch to an opponent.');
