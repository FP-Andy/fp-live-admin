import test from 'node:test';
import assert from 'node:assert/strict';
import {CSV_HEADERS,parseCommentCsv,planCommentImport} from '../../apps/web/public/kbl-grayzone/comment-csv.mjs';

const fields={focus:'기존 지점',observation:'기존 관찰',difficultyFactors:'',viewComment:'기존 시야',initialCall:'',decisionBasis:'',takeaway:'',assessment:'기존 총평',callerNumber:37,callerBasis:'확인',refereeAssignments:{r1:37}};
const editorial={caseId:'game-test',revision:1,recordsVersion:'rec1',version:'v1',limits:{focus:130,observation:160,difficultyFactors:160,viewComment:180,initialCall:100,decisionBasis:140,takeaway:120,assessment:520},events:[
 {id:'review-1',number:1,ready:true,captureId:'capture-1',fields},
 {id:'review-2',number:2,ready:true,captureId:'capture-2',fields:{...fields}}
]};
const csv=(records,headers=CSV_HEADERS)=>'\uFEFF'+[headers,...records.map(row=>headers.map(key=>row[key]??''))].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
const row=(extra={})=>({case_id:'game-test',event_id:'review-1',capture_id:'capture-1',case_revision:'1',records_version:'rec1',editorial_version:'v1',...extra});

test('UTF-8 CSV preserves quoted commas, quotes and newlines and plans only changed text',()=>{
 const value='접촉, "팔"\n두 번째 줄';const plan=planCommentImport(csv([row({assessment:value,focus:'새 지점'})]),editorial);
 assert.equal(plan.changes.length,1);assert.deepEqual(plan.changes[0].fields,{focus:'새 지점',assessment:value});
 assert.equal(plan.stale,false);assert.equal(fields.callerNumber,37);assert.deepEqual(fields.refereeAssignments,{r1:37});
});
test('empty cells preserve existing fields and stale editorial versions require review',()=>{
 const plan=planCommentImport(csv([row({viewComment:'새 시야',editorial_version:'v0'})]),editorial);
 assert.deepEqual(plan.changes[0].fields,{viewComment:'새 시야'});assert.equal(plan.stale,true);
 assert.throws(()=>planCommentImport(csv([row()]),editorial),/새로 반영할/);
});
test('rejects wrong game, changed capture, duplicates, malformed rows and overlong text',()=>{
 assert.throws(()=>planCommentImport(csv([row({case_id:'game-other',focus:'새 문안'})]),editorial),/다른 경기/);
 assert.throws(()=>planCommentImport(csv([row({capture_id:'old',focus:'새 문안'})]),editorial),/공간 장면이 바뀌/);
 assert.throws(()=>planCommentImport(csv([row({records_version:'old',focus:'새 문안'})]),editorial),/경기 기록/);
 assert.throws(()=>planCommentImport(csv([row({focus:'하나'}),row({focus:'둘'})]),editorial),/중복/);
 assert.throws(()=>planCommentImport(csv([row({assessment:'가'.repeat(521)})]),editorial),/520자/);
 assert.throws(()=>parseCommentCsv('case_id,event_id\n"미완성'),/따옴표/);
 assert.throws(()=>parseCommentCsv('case_id,event_id\nfoo,bar'),/CSV 열/);
 assert.throws(()=>parseCommentCsv(CSV_HEADERS.join(',')+'\nwrong,count'),/열 개수/);
});
