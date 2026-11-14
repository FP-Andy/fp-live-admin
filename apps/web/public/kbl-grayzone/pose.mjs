// Cached pose must never leak onto another timestamp, tracking version or calibration.
export function displayedVideoFrame(presentedFrame,currentTime,fps){
 return Number.isInteger(presentedFrame)&&presentedFrame>=0?presentedFrame:Math.floor(currentTime*fps+1e-6);
}
export function poseFrameMatches(frame,{clipId,datasetId,time,fps,anchors,manual=false}){
 return !!frame&&(!manual||frame.inputMode==='manual')&&(frame.inputMode!=='manual'||manual)&&frame.clipId===clipId&&frame.datasetId===datasetId&&Math.round(time*fps)===frame.frameIndex&&JSON.stringify(anchors)===JSON.stringify(frame.anchors);
}
export function applyFramePose(entities,frame,context){
 if(!poseFrameMatches(frame,context))return entities;
 const people=new Map(frame.people.map(p=>[p.id,p]));
 return entities.map(e=>{
  const p=people.get(e.id);
  if(!p||p.role!==e.role||Math.hypot(p.x-e.x,p.y-e.y)>.001)return e;
  const poseEvidence={status:p.status,model:frame.model,frameIndex:frame.frameIndex,confidenceThreshold:frame.threshold,fallbackBones:p.fallbackBones,armQuality:p.armQuality,pipelineVersion:frame.pipelineVersion,depthMeasured:false,jobId:frame.jobId,revision:frame.revision,manualJoints:p.manualJoints||{},manualArms3D:p.manualArms3D||{}};
  const common={...e,poseEvidence,manualBodyHeading:p.manualBodyHeading};
  return p.accepted?{...common,meshKey:p.meshKey,eyeLocal:p.eyeLocal,bodyHeading:p.meshBodyHeading??p.bodyHeading,poseBodyHeading:p.meshBodyHeading??p.bodyHeading}:common;
 });
}
export const attackingBasket=context=>({x:context.basket==='left'?1.575:26.425,y:7.5});
export function orientBodies(entities,context,target){
 const basket=attackingBasket(context),angle=(e,p)=>Math.atan2(p.y-e.y,p.x-e.x);
 return entities.map(e=>{
  let bodyHeading=e.bodyHeading??0,bodyDirectionSource=e.meshKey?'pose-inferred':'unknown';
  if(context.mode==='context'){
   if(e.role?.startsWith('ref')&&(context.refFacing==='basket'||target)){bodyHeading=angle(e,context.refFacing==='basket'?basket:target);bodyDirectionSource=context.refFacing==='basket'?'referee-basket-assumption':'contact-target-assumption';}
   else if(['home','away'].includes(context.attackTeam)&&['home','away'].includes(e.team)){
    const attack=e.team===context.attackTeam;bodyHeading=angle(e,basket)+(attack?0:Math.PI);bodyDirectionSource=attack?'attack-basket-assumption':'defense-away-from-basket-assumption';
   }
  }
  if(Number.isFinite(e.manualBodyHeading)){bodyHeading=e.manualBodyHeading;bodyDirectionSource='manual';}
  return {...e,bodyHeading,bodyDirectionSource}; // gaze (heading) remains independent
 });
}
export function resolveGaze(observer,choice={},context={}){
 const mode=choice.mode||'unknown';let heading=null,reason='direction-unreviewed';
 if(mode==='manual'&&Number.isFinite(choice.angle)){heading=choice.angle*Math.PI/180;reason='manual-scene-review';}
 else if(['target','ball','basket'].includes(mode)){
  const p=context[mode];
  if(p&&!p.missing&&Number.isFinite(p.x)&&Number.isFinite(p.y)){heading=Math.atan2(p.y-observer.y,p.x-observer.x);reason=mode+'-assumption';}
  else reason=mode+'-unavailable';
 }
 return {heading,gazeEvidence:{mode,reason,measured:false}};
}
export const POSE_LINKS=[[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
export function drawPose(ctx,frame){
 for(const p of frame.people){
  ctx.strokeStyle=p.accepted?'#18e293':'#ffb45e';ctx.lineWidth=3;
  for(const [a,b] of POSE_LINKS){if(!p.jointUsable[a]||!p.jointUsable[b])continue;ctx.beginPath();ctx.moveTo(...p.keypoints[a]);ctx.lineTo(...p.keypoints[b]);ctx.stroke();}
  p.keypoints.forEach((q,i)=>{if(!p.jointUsable[i])return;ctx.fillStyle=p.manualJoints?.[i]?'#ff8a3c':'#18e293';ctx.beginPath();ctx.arc(...q,p.manualJoints?.[i]?5:3.5,0,Math.PI*2);ctx.fill();});
 }
}
