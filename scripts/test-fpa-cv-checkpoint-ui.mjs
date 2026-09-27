import assert from 'node:assert/strict';
import {checkpointUI} from '../apps/web/public/fpa-cv/checkpoint-ui.mjs';
class Element {
  children=[];hidden=false;disabled=false;value='';textContent='';
  classList={toggle(){}};
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(){}
  getContext(){return {clearRect(){}};}
}
const elements=new Map();
globalThis.document={getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:()=>new Element()};
const data={datasetId:'ui',video:{clipStart:0,clipEnd:60},detector:{sampleFps:10},frames:[]};
let review={batch:{round:4},checkpoints:[{time:30,assignments:[{personId:'p1',trackId:1}]}],checkpointBudget:5};
let pending=false,recovery={status:'complete',checkpointPlan:{recommendations:[{time:30,reason:'long gap'},{time:10,reason:'short gap'}]}};
const ui=checkpointUI({getData:()=>data,getReview:()=>review,getWorking:()=>review,getRecovery:()=>recovery,isPending:()=>pending,commit(){},seek(){},time:()=>0,video:{},message(){},apply(){},onChange(){}});
const list=()=>elements.get('checkpoint-recommendations').children;
ui.render();
assert.match(list()[0].children[0].textContent,/우선 1.*00:30/,'Impact order survives rendering instead of being sorted chronologically');
assert.match(list()[1].children[0].textContent,/우선 2.*00:10/);
assert.match(elements.get('checkpoint-note').textContent,/5차 결과/);
assert.equal(list().length,2,'A partial saved scene does not hide remaining player recommendations');
pending=true;ui.render();assert.equal(list().length,1);assert.match(list()[0].textContent,/반영하면 다음 장면/,'Staged edits cannot present stale recommendations');
pending=false;recovery.status='pending';ui.render();assert.match(list()[0].textContent,/계산이 끝나면/);
recovery.status='error';ui.render();assert.match(list()[0].textContent,/연결 계산을 완료/);
recovery={status:'complete',checkpointPlan:{recommendations:[{time:40,reason:'remaining gap'}]}};ui.render();assert.match(list()[0].children[0].textContent,/00:40/,'The completed next round displays its fresh plan');
console.log('PASS: impact ordering, applied-round label, partial scenes, hidden stale plans and refreshed recommendations.');
