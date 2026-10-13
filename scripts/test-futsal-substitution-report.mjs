import assert from 'node:assert/strict';
import fs from 'node:fs';import zlib from 'node:zlib';
import {deriveSubstitutionReport} from '../apps/web/public/fpa-cv/substitution-report.mjs';
import {substitutionEvidence} from '../apps/web/public/fpa-cv/substitution-evidence.mjs';
function fixture({two=false,kick=false,early=false}={}){
 const roi=[[0,0],[1,0],[1,1],[0,1]],uniforms={home:[[255,0,0]],away:[[0,0,255]]},frames=[],people=Array.from({length:two?2:1},(_,i)=>({id:'home-'+i,group:'home',jersey:String(i+2),positions:[],grid:Array(3200).fill(0)}));
 const box=(id,x,y)=>({id,box:[x-.01,y-.02,x+.01,y+.02],confidence:.9,appearance:[{rgb:[255,0,0],weight:1}]});
 for(let i=0;i<150;i++){const t=i/5,boxes=[];for(let p=0;p<people.length;p++){
  const old=100+p,newTrack=kick?old:200+p,x=.35+p*.3;
  const y=t<9?.6:t<10? .6+(t-9)*.5:1.1;
  if(t<=10.8)boxes.push(box(old,x,y));
  const entry=early?10:12,ny=t<entry-1?1.1:t<entry?1.1-(t-(entry-1))*.2:.8;
  if(t>=entry-1&&(!kick||t>10.8))boxes.push(box(newTrack,x,ny));
  const observed=boxes.find(b=>b.id===old&&t<10)||boxes.find(b=>b.id===newTrack&&t>=entry);
  if(observed){const q={t,x,y:(observed.box[1]+observed.box[3])/2,seconds:.2,trackId:observed.id,source:'automatic'};if(q.y<=1){people[p].positions.push(q);people[p].grid[Math.floor(q.y*40)*80+Math.floor(x*80)]+=.2;}}
 }frames.push({t,boxes});}
 const video={name:'sample.mp4',duration:30,clipStart:0,clipEnd:30},data={datasetId:'fixture',video,detector:{sampleFps:5,roi},frames};
 const heatmap={schema:'fpa-heatmaps/v1',datasetId:'fixture',video:video.name,from:0,to:30,width:80,height:40,scale:1,point:'center',players:people};
 const snapshot={id:'a'.repeat(32),jobId:'b'.repeat(32),matchId:'match',heatmap,review:{uniforms,roster:[...people,{id:'home_gk-1',group:'home_gk',jersey:'1'}]}};
 const saved={revision:1,log:{schema:'fpa-substitution-log/v2',video:{name:video.name,duration:30,from:0,to:30},players:[],initialPlayers:[],substitutions:[{id:'event',time:11,team:'home',note:''},...(two?[{id:'event2',time:11.1,team:'home',note:''}]:[])]}};
 return {snapshot,data,saved};
}
const run=f=>deriveSubstitutionReport(f.snapshot,f.data,f.saved);
const f=fixture(),before=JSON.stringify(f),r=run(f);assert.equal(r.status,'ready');assert.equal(r.heatmap.players.length,2);assert.equal(r.events[0].outTrackId,100);assert.equal(r.events[0].inTrackId,200);assert.equal(JSON.stringify(f),before,'immutable input');
for(const p of r.heatmap.players)for(const q of p.positions)assert(q.t>=p.activeFrom&&q.t+q.seconds<=p.activeTo+.002);
assert.equal(run(fixture({kick:true})).status,'review','kick-in must not become substitution');
const ambiguous=fixture({two:true});assert.equal(run(ambiguous).status,'ready','simultaneous swaps with unique existing ownership resolve together');assert.deepEqual(run(ambiguous).events.map(e=>[e.outTrackId,e.inTrackId]),[[100,200],[101,201]]);
for(const [i,e]of ambiguous.saved.log.substitutions.entries())e.tracking={snapshotId:ambiguous.snapshot.id,outPersonId:'home-'+i,outTrackId:100+i,inTrackId:200+i};
assert.equal(run(ambiguous).status,'ready','manual decisions resolve ambiguity');
ambiguous.saved.log.substitutions[0].tracking.snapshotId='c'.repeat(32);assert.equal(run(ambiguous).status,'review','old snapshot decisions expire');
f.saved.log.substitutions=[];assert.equal(run(f).heatmap.players.length,1,'deleting logs restores baseline instead of retaining old splits');
f.saved.log.substitutions=[{id:'event',time:11,team:'home',note:''}];f.saved.log.video.name='other.mp4';assert.throws(()=>run(f),/영상이 다릅니다/);
if(process.argv[2]){const b=JSON.parse(zlib.gunzipSync(fs.readFileSync(process.argv[2]))),out=deriveSubstitutionReport(b.snapshot,b.tracks,b.log);assert.equal(out.status,'ready');assert.deepEqual(out.events.map(e=>[e.outTrackId,e.inTrackId]),[[8282,8991],[14702,15650]]);assert.deepEqual(out.heatmap.players.filter(p=>p.id.startsWith('sub-')).map(p=>Math.round(p.observed)),[438,11]);console.log('PASS real Ulsan–Jeonbuk: both reviewed pairs and observed durations reproduced.');}
console.log('PASS: immutable source, distinct stints, ambiguous batch review, manual resolution, stale decision rejection, deletion reset and kick-in exclusion.');

const withoutEntryOwnership=f=>{for(const p of f.snapshot.heatmap.players)p.positions=p.positions.filter(q=>q.t<10);return f;};
const chain=withoutEntryOwnership(fixture());
for(const frame of chain.data.frames)for(const b of frame.boxes)if(b.id===200&&frame.t>=20)b.id=300;
const joined=run(chain);assert.equal(joined.status,'ready','unique short-gap continuation survives an ID reset');assert(joined.heatmap.players.at(-1).positions.some(q=>q.trackId===300));assert(joined.heatmap.players.at(-1).positions.every(q=>q.source==='automatic'),'derived observations are not labelled human annotations');
const fork=structuredClone(chain);
for(const frame of fork.data.frames)for(const b of [...frame.boxes])if(b.id===300)frame.boxes.push({...b,id:301,box:[...b.box]});
assert.equal(run(fork).status,'review','two equivalent continuations require review');
const batch=run(withoutEntryOwnership(fixture({two:true})));
assert.equal(batch.status,'ready');assert(batch.events.every(e=>e.pairing==='batch'));assert.deepEqual(batch.events[0].batchOutNumbers,['2','3'],'simultaneous departures are a set, not inferred replacement pairs');
const conflict=withoutEntryOwnership(fixture());
conflict.snapshot.heatmap.players.push({id:'home-other',group:'home',jersey:'3',grid:Array(3200).fill(0),positions:conflict.data.frames.filter(f=>f.t>=25).map(f=>({t:f.t,x:.35,y:.8,seconds:.2,trackId:200,source:'manual'}))});
const protectedResult=run(conflict);assert.equal(protectedResult.status,'review');assert(protectedResult.events[0].reason,'ownership conflicts stay explicit review cases');
assert.equal(protectedResult.heatmap.players.find(p=>p.id==='home-other').positions.length,25,'existing observations survive an entrant ownership conflict');
const seen=new Set();for(const p of protectedResult.heatmap.players)for(const q of p.positions){const k=q.t.toFixed(5)+':'+q.trackId;assert(!seen.has(k),'no observation counted twice');seen.add(k);}
const wrongTeam=withoutEntryOwnership(fixture());for(const f of wrongTeam.data.frames)for(const b of f.boxes)if(b.id===200)b.appearance=[{rgb:[0,0,255],weight:1}];assert.equal(run(wrongTeam).status,'review','opponent arrival cannot satisfy a home substitution');
const extra=withoutEntryOwnership(fixture());for(const f of extra.data.frames)for(const b of [...f.boxes])if(b.id===200)f.boxes.push({...b,id:201,box:b.box.map((x,i)=>i%2?x:x+.3)});assert.equal(run(extra).status,'review','an extra unowned entry prevents a forced singleton pairing');
console.log('PASS v2: simultaneous sets, mutual short-gap joins, fork rejection, protected ownership, wrong-team exclusion and honest observation provenance.');

const spatial=fixture();for(const p of spatial.snapshot.heatmap.players)for(const q of p.positions)q.trackId+=1000;assert.equal(run(spatial).status,'ready','time-aligned positions can bridge a different detector ID');
const crowded=structuredClone(spatial);crowded.snapshot.heatmap.players.push({...structuredClone(crowded.snapshot.heatmap.players[0]),id:'home-crowded',jersey:'3',positions:crowded.snapshot.heatmap.players[0].positions.map(q=>({...q,trackId:q.trackId+2000,x:q.x+.005}))});assert.equal(run(crowded).status,'review','nearby teammates with comparable spatial support are ambiguous');

const waiting=fixture();
for(const frame of waiting.data.frames){frame.boxes=frame.boxes.filter(b=>b.id!==200);const y=frame.t<11?1.005:frame.t<12?1.005-(frame.t-11)*.205:.8;frame.boxes.push({id:200,box:[.34,y-.02,.36,y+.02],confidence:.9,appearance:[{rgb:[255,0,0],weight:1}]});}
const wr=run(waiting);assert(wr.events[0].ins.some(c=>c.evidence==='boundary-wait'));assert.equal(wr.status,'review','new waiting evidence needs scene review');
const walking=structuredClone(waiting);for(const frame of walking.data.frames){const b=frame.boxes.find(b=>b.id===200),dx=Math.min(0,(frame.t-11)*.02);b.box[0]+=dx;b.box[2]+=dx;}assert(run(walking).events[0].ins.some(c=>c.evidence==='boundary-wait'),'walking along the boundary before entering is not discarded');
const still=structuredClone(waiting);for(const frame of still.data.frames){const b=frame.boxes.find(b=>b.id===200);b.box=[.34,.985,.36,1.025];}assert(!run(still).events[0].ins.some(c=>c.trackId===200),'waiting alone is not entry');
const returning=structuredClone(waiting);returning.saved.log.substitutions[0].time=22;for(const frame of returning.data.frames){const b=frame.boxes.find(b=>b.id===200),y=frame.t<5?.8:frame.t<22?1.005:.8;b.box=[.34,y-.02,.36,y+.02];}assert(!run(returning).events[0].ins.some(c=>c.evidence==='boundary-wait'),'prior field activity rejects a waiting kick-in return');
const held=fixture();held.saved.log.substitutions[0].note='[보류] 출입 장면 재확인';const hr=run(held);assert(hr.events[0].held);assert.equal(hr.status,'review');assert.equal(hr.heatmap.players.length,1,'held event never splits observations');
const mixed=run(wrongTeam);assert(mixed.events[0].ins.some(c=>c.teamConflict),'opposing colour evidence remains visible but cannot auto-pair');
const late=fixture();late.saved.log.substitutions[0].time=0.1;for(const frame of late.data.frames){frame.boxes=frame.boxes.filter(b=>b.id!==100);if(frame.t<14){const y=frame.t<12?.6:frame.t<13?.6+(frame.t-12)*.5:1.1;frame.boxes.push({id:100,box:[.34,y-.02,.36,y+.02],confidence:.9,appearance:[{rgb:[255,0,0],weight:1}]});}}assert(run(late).events[0].outs.some(c=>c.extendedWindow),'departure just beyond 12 seconds remains reviewable');
const bridge=fixture();for(const frame of bridge.data.frames){frame.boxes=[{id:1,box:[.19,.6,.21,.64],confidence:.9},{id:2,box:[.79,.6,.81,.64],confidence:.9},{id:900,box:[.19,.6,.21,.64],confidence:.9,recovery:true}];}
bridge.data.recoveryAliases=[{trackId:900,originalId:1,from:0,to:8},{trackId:900,originalId:2,from:12,to:20}];const be=substitutionEvidence(bridge.snapshot,bridge.data,bridge.saved.log.substitutions);assert.notEqual(be.pathOf.get(1).id,be.pathOf.get(2).id,'non-overlapping alias edges cannot unite coexisting original players');
console.log('PASS v6: boundary waiting, stationary/kick-in negatives, explicit hold, colour conflict visibility, delayed exit and transitive alias rejection.');
