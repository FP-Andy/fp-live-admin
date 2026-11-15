// Reuse the workspace's original visibility implementation for report presentation.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {coverageGrid} from '../../apps/web/public/kbl-grayzone/crew-analysis.mjs';
import {DEFAULTS,visibility} from '../../apps/web/public/kbl-grayzone/geometry.mjs';
import {registerHumanMeshes,appendHumanMeshes} from '../../apps/web/public/kbl-grayzone/mesh-human.mjs';
import {resolveBodyDirection} from '../../apps/web/public/kbl-grayzone/body-direction.mjs';
import {reviewTarget} from '../../apps/web/public/kbl-grayzone/review-point.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export function buildCoverage(snapshot){
registerHumanMeshes(read(path.join(root,'apps/web/public/kbl-grayzone/assets/humans/mpfb-court-v1.json')));
let pose=null;
if(snapshot.poseJobId){
 const variant=snapshot.poseVariantId;
 const dir=variant?path.join(root,'outputs/kbl-cases',snapshot.caseId,'reconstructions',snapshot.eventId,'pose-variants',variant):path.join(root,'outputs/kbl-pose-frames',snapshot.poseJobId);
 pose=read(path.join(dir,variant?'pose.json':'result.json'));appendHumanMeshes(read(path.join(dir,'meshes.json')));
}
const state=snapshot.state,counts={};
const bodies=state.entities.map(e=>{
 const p=pose?.people.find(p=>p.id===e.id&&p.role===e.role&&(e.positionSource==='manual'||Math.hypot(p.x-e.x,p.y-e.y)<.001));
 const direction=snapshot.poseVariantId&&Number.isFinite(e.bodyHeading)?{heading:e.bodyHeading,status:e.bodyDirectionSource==='manual'?'manual':'estimated',source:'saved-map'}:resolveBodyDirection(e,p);counts[e.role]=(counts[e.role]||0)+1;
 const color=e.role==='player'&&['home','away'].includes(e.team)?snapshot.uniforms?.[e.team]:({player:'#2797ba',referee:'#ed873f',staff:'#7c5e9b',unknown:'#969ba4'}[e.role]);
 return {...e,color:color||'#2797ba',label:(e.role==='referee'?'R':e.role==='player'?'P':'S')+counts[e.role],heading:direction.heading,viewHeading:Number.isFinite(e.viewHeading)?e.viewHeading:direction.heading,bodyHeading:direction.heading,bodyDirection:direction,height:e.role==='staff'?1.75:undefined,...(p?.accepted&&!(snapshot.poseVariantId&&e.role==='referee')?{meshKey:p.meshKey,eyeLocal:p.eyeLocal,poseBodyHeading:p.meshBodyHeading??p.bodyHeading}:{})};
});
const target=reviewTarget(state,bodies),config={...DEFAULTS,hfov:state.hfov,vfov:state.vfov};
const observers=snapshot.crewAnalysis.rows.map(row=>{const b=bodies.find(b=>b.id===row.id);if(!b)throw Error('심판 객체가 누락되었습니다.');return {...b,heading:row.heading,viewHeading:row.heading};});
const visibleBodies=bodies.filter(b=>!b.positionOnly);
for(const [i,o] of observers.entries()){
 const rays=visibility(o,target,visibleBodies,config).rays;const got={visible:0,blocked:0,outside:0};for(const ray of rays)got[ray.state]++;
 const expected=snapshot.crewAnalysis.rows[i].counts;
 if(Object.keys(got).some(k=>got[k]!==expected[k]))throw Error(`저장된 시야 계산이 일치하지 않습니다: ${o.label} ${JSON.stringify({got,expected})}`);
}
const observer=observers.find(o=>o.id===state.observerId)||observers[0];
 return {cells:coverageGrid({bodies,target,config},observers),bodies,target,observers,observer,config,result:observer?visibility(observer,target,visibleBodies,config):null};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildCoverage(read(process.argv[2]))));
