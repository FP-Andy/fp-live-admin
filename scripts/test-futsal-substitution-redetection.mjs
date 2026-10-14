import assert from 'node:assert/strict';
import {deriveSubstitutionReport} from '../apps/web/public/fpa-cv/substitution-report.mjs';
import {planSubstitutionRedetection,mergeSubstitutionRedetection} from '../apps/web/public/fpa-cv/substitution-redetection.mjs';
import {substitutionEvidence} from '../apps/web/public/fpa-cv/substitution-evidence.mjs';
import {refineEvidence} from '../apps/web/public/fpa-cv/substitution-refinement.mjs';
const box=(id,y,x=.4)=>({id,box:[x-.02,y*.8-.02,x+.02,Math.min(1,y*.8+.02)],confidence:.9,appearance:[{rgb:[255,0,0],weight:1}]}),frames=[],positions=[],reFrames=[];
for(let i=0;i<150;i++){const t=i/5,boxes=[];
 if(t<11){const y=t<9?.6:.6+(t-9)*.35;boxes.push(box(100,y));if(y<1)positions.push({t,x:.4,y,seconds:.2,trackId:100,source:'manual'});}
 if(t>=11){const y=t<12?1.1-(t-11)*.3:.8;if(t<20||t>=23)boxes.push(box(t<20?200:300,y));if(t<26)reFrames.push({t,boxes:[box(1001000001,y)]});}
 frames.push({t,boxes});
}
const data={datasetId:'one',video:{name:'one.mp4',duration:30},detector:{sampleFps:5,roi:[[0,0],[1,0],[1,.8],[0,.8]]},frames};
const snapshot={id:'a'.repeat(32),jobId:'job',matchId:'match',review:{uniforms:{home:[[255,0,0]],away:[[0,0,255]]}},heatmap:{schema:'fpa-heatmaps/v1',datasetId:'one',video:'one.mp4',from:0,to:30,point:'center',width:80,height:40,scale:1,players:[{id:'home-2',group:'home',jersey:'2',positions,grid:Array(3200).fill(0)}]}};
const saved={revision:1,log:{schema:'fpa-substitution-log/v2',video:{name:'one.mp4',duration:30,from:0,to:30},players:[],initialPlayers:[],substitutions:[{id:'e',time:11,team:'home',note:''}]}};
const baseline=deriveSubstitutionReport(snapshot,data,saved);assert.equal(baseline.status,'ready');assert.equal(baseline.events[0].trackingStatus,'partial');
const plan=planSubstitutionRedetection(snapshot,data,saved,baseline);assert.equal(plan.windows.length,1);assert.equal(plan.totalSeconds,30);
const recovery={...plan,id:'d'.repeat(32),windows:[{...plan.windows[0],frames:reFrames}]},before=JSON.stringify({snapshot,data,saved,recovery});
const merged=mergeSubstitutionRedetection(snapshot,data,saved,recovery);assert.deepEqual(merged.recoveryAliases.map(a=>a.originalId),[200,300]);
const result=deriveSubstitutionReport(snapshot,data,saved,undefined,recovery);assert.equal(result.status,'ready');assert.equal(result.events[0].outNumber,'2');
assert.equal(result.events[0].outs.find(c=>c.trackId===100).resolvedPersonId,'home-2','exit history supplies the old analysis number');
assert.equal(result.events[0].outs.find(c=>c.trackId===100).resolvedNumber,'2');
assert.equal(JSON.stringify({snapshot,data,saved,recovery}),before,'original snapshot, data, log and sidecar stay immutable');
assert(result.heatmap.players.at(-1).positions.some(q=>q.trackId===300));
assert.doesNotThrow(()=>mergeSubstitutionRedetection(snapshot,data,{...saved,revision:2},recovery),'confirmation/note revisions keep immutable evidence');
const moved=structuredClone(saved);moved.log.substitutions[0].time+=1;assert.throws(()=>mergeSubstitutionRedetection(snapshot,data,moved,recovery),/오래된/);
assert.throws(()=>mergeSubstitutionRedetection(snapshot,data,{...saved,revision:2},{...recovery,logContext:undefined}),/오래된/);
assert.throws(()=>mergeSubstitutionRedetection(snapshot,data,saved,{...recovery,datasetId:'other'}),/원본/);
assert.throws(()=>mergeSubstitutionRedetection(snapshot,data,saved,{...recovery,roi:[[0,0],[1,0],[1,1],[0,1]]}),/코트/);
assert.throws(()=>mergeSubstitutionRedetection(snapshot,data,saved,{...recovery,model:'different.pt'}),/모델/);
assert.throws(()=>mergeSubstitutionRedetection(snapshot,data,saved,{...recovery,windows:[{...recovery.windows[0],frames:[{t:32,boxes:[]}]}]}),/구간 밖/);
assert.throws(()=>mergeSubstitutionRedetection(snapshot,data,saved,{...recovery,windows:[{...recovery.windows[0],frames:[{t:12,boxes:[box(100,.8)]}]}]}),/ID/);
const oneFrame={...recovery,windows:[{...recovery.windows[0],frames:reFrames.slice(5,6)}]};assert.equal(mergeSubstitutionRedetection(snapshot,data,saved,oneFrame).recoveryAliases.length,0,'one nearby detection cannot bridge identity');
const opponent=structuredClone(recovery);for(const f of opponent.windows[0].frames)for(const b of f.boxes)b.appearance=[{rgb:[0,0,255],weight:1}];assert.equal(mergeSubstitutionRedetection(snapshot,data,saved,opponent).recoveryAliases.length,0,'opponent colours cannot bridge to home');
const duplicate=structuredClone(recovery);for(const f of duplicate.windows[0].frames)f.boxes.push({...f.boxes[0],id:1001000002});assert.equal(mergeSubstitutionRedetection(snapshot,data,saved,duplicate).recoveryAliases.length,0,'two comparable tracks cannot claim one original');
assert.equal(planSubstitutionRedetection(snapshot,data,saved,result).windows.length,0,'resolved logs do not incur inference');
console.log('PASS: bounded unresolved windows, sustained ID bridge, immutable inputs, stale/video/range/collision rejection, crowded/one-frame/wrong-team safeguards, recovered entrant to end of stint.');

const reviewOnly={...recovery,reviewOnly:true};
const reviewed=structuredClone(saved);reviewed.revision++;
reviewed.log.substitutions[0].tracking={snapshotId:snapshot.id,outPersonId:'home-2',outTrackId:result.events[0].outTrackId,inTrackId:result.events[0].inTrackId,redetectionId:recovery.id};
const confirmed=deriveSubstitutionReport(snapshot,data,reviewed,undefined,reviewOnly);
assert.equal(confirmed.events[0].connectionConfirmed,true);assert.equal(confirmed.status,'ready');
reviewed.log.substitutions[0].tracking.redetectionId='e'.repeat(32);
assert.equal(deriveSubstitutionReport(snapshot,data,reviewed,undefined,reviewOnly).events[0].status,'review');
console.log('PASS: human confirmation survives revision, uses pinned evidence and rejects a different recovery.');

reviewed.log.substitutions[0].tracking.redetectionId=recovery.id;
const cumulative={...reviewOnly,id:'f'.repeat(32),ancestorIds:[recovery.id]};
assert.equal(deriveSubstitutionReport(snapshot,data,reviewed,undefined,cumulative).events[0].connectionConfirmed,true,'cumulative evidence preserves an earlier human pin');

assert.doesNotThrow(()=>mergeSubstitutionRedetection(snapshot,data,saved,{...recovery,roi:recovery.roi.map(p=>p.map(v=>Math.fround(v)))}),'float32 metadata and float64 setup describe the same court');
assert.throws(()=>mergeSubstitutionRedetection(snapshot,data,saved,{...recovery,roi:recovery.roi.map(p=>p.map(v=>v+0.0001))}),/코트/,'real court changes are still rejected');

const shifted=structuredClone(recovery);for(const w of shifted.windows)for(const f of w.frames)f.t+=.1;
const phase=mergeSubstitutionRedetection(snapshot,data,saved,shifted);
assert(phase.recoveryAliases.some(a=>a.originalId===200),'half-sample phase offset still supplies sustained body matches');
assert(phase.frames.some(f=>Math.abs(f.t-11.1)<1e-8),'measured RF timestamps are retained');
const originalEvidence=substitutionEvidence(snapshot,data,saved.log.substitutions),phaseEvidence=substitutionEvidence(snapshot,phase,saved.log.substitutions);
const seconds=(ev,id)=>ev.tracks.get(id).reduce((n,o)=>n+o.dt,0);
assert(Math.abs(seconds(originalEvidence,200)-seconds(phaseEvidence,200))<1e-8,'inserting RF frames cannot halve original-track time');
const switching=structuredClone(data);switching.frames=Array.from({length:80},(_,i)=>({t:i*.2,boxes:[{...box(900,.5),appearance:[{rgb:i<30?[255,0,0]:[0,0,255],weight:1}]}]}));
const interleaved={...switching,frames:[...switching.frames,...switching.frames.map(f=>({t:f.t+.1,boxes:[box(901,.2,.9)]}))].sort((a,b)=>a.t-b.t)};
const switches=d=>refineEvidence(substitutionEvidence(snapshot,d,[]),snapshot).splits.filter(s=>s.pathId===900);
assert.deepEqual(switches(interleaved),switches(switching),'unrelated observations cannot delay opposite-kit cutoff');
console.log('PASS: half-frame alignment, source timestamps and cadence-invariant identity cutoff.');
