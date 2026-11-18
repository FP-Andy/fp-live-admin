import assert from 'node:assert/strict';
import {workProgress} from '../../apps/web/public/kbl-grayzone/match-progress.mjs';
const stages={objects:{completed:3,total:3},joints:{completed:3,total:3},spatial:{completed:1,total:3}};
const flow={caseId:'game-test',activeStage:'spatial',nextEventId:'review-2',stages};
assert.deepEqual(workProgress(flow,{state:'running',stage:'영상 제작 2/3'}),{
 title:'2D·3D 단계 · 1/3장면 확인',stages:'객체 3/3 · 관절 3/3 · 2D·3D 1/3',video:'영상 제작 2/3',path:'reconstruction.html?id=game-test#review-2'});
assert.equal(workProgress({...flow,activeStage:'report'},null).path,'report-review.html?id=game-test#review-2');
assert.equal(workProgress({...flow,activeStage:'joints',nextEventId:'bad'},null).path,'pose-review.html?id=game-test&stage=joints#review-1');
console.log('Match progress follows saved checkpoints and the next scene.');
