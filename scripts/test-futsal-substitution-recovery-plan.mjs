import assert from 'node:assert/strict';
import {planContinuationRecovery} from '../apps/web/public/fpa-cv/substitution-recovery-plan.mjs';
const snapshot={id:'s',heatmap:{datasetId:'d',from:0,to:900}},data={datasetId:'d',video:{name:'v',duration:900},detector:{model:'yolo26s.pt',roi:[]}},saved={revision:1,log:null};
const result={provenance:{snapshotId:'s',logRevision:1},heatmap:{from:0,to:900,players:[{id:'a',activeFrom:50},{id:'b',activeFrom:80},{id:'c',activeFrom:100}]},events:[{id:'1',time:50,inPersonId:'a'},{id:'2',time:80,inPersonId:'b'},{id:'3',time:100,inPersonId:'c'}],continuation:{audit:[{personId:'a',after:2,stoppedAt:60,until:900},{personId:'b',after:20,stoppedAt:300,until:900},{personId:'c',after:1,stoppedAt:400,until:900,manualConflicts:1}]}};
const plan=planContinuationRecovery(snapshot,data,saved,result,{maxVideoSeconds:15});
assert.equal(plan.windows.length,1);assert.equal(plan.windows[0].from,58);assert.equal(plan.windows[0].to,72);assert.equal(plan.deferred.length,1);assert.equal(plan.scope,'court');assert.equal(plan.preferredDetector,'rfdetr');
assert(!plan.windows.some(w=>w.eventIds.includes('3')),'manual conflict needs review, not more blind inference');
assert.throws(()=>planContinuationRecovery(snapshot,data,{...saved,revision:2},result),/버전/);
assert.equal(planContinuationRecovery(snapshot,data,saved,result,{maxVideoSeconds:0}).windows.length,0);
assert.equal(JSON.stringify(result).includes('preferredDetector'),false);
console.log('PASS: loss-time planning, smallest observations first, bounded budget, manual conflicts, stale versions and immutable inputs.');

const tail=structuredClone(result);tail.continuation.audit[0].stoppedAt=800;tail.heatmap.players[0].positions=[{t:60,seconds:1}];
const actual=planContinuationRecovery(snapshot,data,saved,tail,{maxVideoSeconds:15});
assert.equal(actual.windows[0].from,59,'excluded wrong-person tail must not move the recovery window');
assert.equal(actual.windows[0].to,73);
console.log('PASS: recovery starts at the last accepted observation, not the raw tracker tail.');

const source=structuredClone(snapshot);source.heatmap={...source.heatmap,point:'bottom'};
const measured=structuredClone(data);measured.detector.roi=[[0,0],[1,0],[1,1],[0,1]];measured.frames=Array.from({length:15},(_,i)=>({t:61+i/15,boxes:[{id:33,box:[.48,.46,.52,.5],confidence:.9}]}));
const existing=structuredClone(result);existing.heatmap.players[0]={id:'a',group:'home',activeFrom:50,positions:[{t:60,x:.5,y:.5,seconds:1}]};existing.continuation.audit=existing.continuation.audit.slice(0,1);
const skip=planContinuationRecovery(source,measured,saved,existing,{maxVideoSeconds:15});
assert.equal(skip.windows.length,0,'do not spend a GPU pass where measured nearby boxes already exist');
assert.equal(skip.associationReview.length,1);
assert.deepEqual(skip.associationReview[0].trackIds,[33]);
console.log('PASS: existing observations route to identity review before additional detection.');
