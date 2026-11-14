// A conditional scene comparison, never a measurement of a referee's actual gaze.
import {visibility,bearing,inFov,cylinderHit} from './geometry.mjs';
import {eyePosition,meshHumanHit} from './mesh-human.mjs';
export function crewObservers(model,state){
 return model.bodies.filter(b=>b.role==='referee'&&!b.positionOnly).slice(0,3).map(b=>{
  const source=state.entities.find(e=>e.id===b.id);
  const selected=b.id===state.observerId;
  const manual=selected?state.headingMode==='manual-assumption':Number.isFinite(source?.viewHeading);
  const heading=manual?(selected?state.heading:source.viewHeading):bearing(b,model.target);
  return {...b,heading,viewHeading:heading,headingSource:manual?'manual-assumption':'target-assumption'};
 });
}
export function analyzeCrew(model,state,frame){
 const observers=crewObservers(model,state),placed=new Set(model.bodies.map(b=>b.id));
 const omitted=(frame.boxes||[]).filter(b=>!placed.has(b.id)).map(b=>b.id);
 const refCount=model.bodies.filter(b=>b.role==='referee').length;
 const rows=observers.map(o=>{
  const result=visibility(o,model.target,model.bodies.filter(b=>!b.positionOnly),model.config),counts={visible:0,blocked:0,outside:0};
  for(const r of result.rays)counts[r.state]++;
  return {id:o.id,label:o.label,heading:o.heading,headingSource:o.headingSource,distance:Math.hypot(o.x-model.target.x,o.y-model.target.y),fraction:result.fraction,counts,blockers:result.blockers};
 });
 const best=rows.length?Math.max(...rows.map(r=>r.fraction)):null;
 const qualityWarnings=frame.sceneEvidence?.qualityWarnings||[];
 const positionOnlyReferees=model.bodies.filter(b=>b.role==='referee'&&b.positionOnly).length;
 const crewComplete=refCount===3&&observers.length===3,sceneComplete=omitted.length===0&&positionOnlyReferees===0;
 return {schema:'kbl-crew-visibility/v1',hfov:state.hfov,vfov:state.vfov,targetId:state.targetId,targetHeight:state.targetHeight,...(state.reviewPoint?{reviewPoint:{...state.reviewPoint}}:{}),
  rayCount:9,patchSizeMetres:.3,targetSamplingVersion:2,rows,positionOnlyReferees,missingReferees:Math.max(0,3-refCount),crewComplete,sceneComplete,omittedTrackIds:omitted,
  leaders:rows.filter(r=>r.fraction===best).map(r=>r.id),
  qualityWarnings,conclusion:!crewComplete||!sceneComplete||qualityWarnings.length?'unresolved':best>=.5?'conditional-coverage':'conditional-gray',
  measuredGaze:false,grid:{stepMetres:.75,method:'one mesh ray per cell at target height',height:state.targetHeight}};
}
export function coverageGrid(model,observers,step=.75){
 const cells=[];
 const eyes=observers.map(o=>model.config.bodyModel==='mpfb'?eyePosition(o,model.config):{x:o.x,y:o.y,z:model.config.eyeHeight});
 for(let x=0;x<28;x+=step)for(let y=0;y<15;y+=step){
  const w=Math.min(step,28-x),h=Math.min(step,15-y),p={x:x+w/2,y:y+h/2,z:model.target.z};
  const occupied=model.bodies.some(b=>!b.positionOnly&&Math.hypot(b.x-p.x,b.y-p.y)<model.config.radius);
  let visible=0,blocked=0,outside=0;
  if(!occupied)observers.forEach((o,i)=>{
   if(!inFov(eyes[i],p,o.heading,model.config)){outside++;return;}
   const hit=model.bodies.some(b=>!b.positionOnly&&b.id!==o.id&&(model.config.bodyModel==='mpfb'?meshHumanHit(eyes[i],p,b,model.config):cylinderHit(eyes[i],p,b,model.config.radius,model.config.bodyHeight))!==null);
   if(hit)blocked++;else visible++;
  });
  cells.push({x,y,w,h,visible,blocked,outside,occupied});
 }
 return cells;
}
