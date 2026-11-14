export const wrapAngle=a=>Math.atan2(Math.sin(a),Math.cos(a));
export function resolveBodyDirection(entity,pose){
  if(entity.bodyDirectionSource==='manual'&&Number.isFinite(entity.bodyHeading))return {heading:entity.bodyHeading,status:'manual',source:'manual'};
  if(Number.isFinite(pose?.manualBodyHeading))return {heading:pose.manualBodyHeading,status:'manual',source:'pose-manual'};
  if(pose?.bodyDirection)return {...pose.bodyDirection,heading:pose.bodyDirection.heading};
  // Old shoulder-only outputs remain explicitly uncertain until recalculated.
  if(Number.isFinite(pose?.bodyHeading))return {heading:pose.bodyHeading,status:'uncertain',source:'legacy-shoulders',reasons:['legacy-shoulders']};
  return {heading:0,status:'unresolved',source:'neutral-placeholder',reasons:['no-pose']};
}
export function cameraPosition(camera){
  const r=camera?.worldToCamera,t=camera?.translation;
  if(!r||!t)return null;
  return {x:-r.reduce((v,row,i)=>v+row[0]*t[i],0),y:-r.reduce((v,row,i)=>v+row[1]*t[i],0)};
}
export function facingRelation(entity,target,heading){
  if(!target)return 'unknown';
  const dx=target.x-entity.x,dy=target.y-entity.y,length=Math.hypot(dx,dy);
  if(length<.01)return 'unknown';
  const dot=(Math.cos(heading)*dx+Math.sin(heading)*dy)/length;
  return dot>.5?'front':dot<-.5?'back':'side';
}
const reasonNames={'torso-keypoints-unreliable':'몸통 관절 신뢰도 부족','torso-axis-foreshortened':'어깨·골반 축이 짧거나 불안정','shoulder-hip-disagreement':'어깨·골반 방향 불일치','legacy-shoulders':'어깨만 사용한 이전 추정','no-pose':'자세 근거 없음'};
export function describeDirection(e,p,camera){
  const d=resolveBodyDirection(e,p),angle=Math.round(d.heading*180/Math.PI);
  if(['uncertain','unresolved'].includes(d.status))return `방향 확인 필요 · ${(d.reasons||[]).map(r=>reasonNames[r]||r).join(', ')} · 표시 각도 ${angle}°는 임시값입니다.`;
  const names={front:'정면',back:'등',side:'측면',unknown:'판별 보류'};
  const basket={front:'골대 쪽',back:'골대를 등짐',side:'옆 방향',unknown:'판별 보류'};
  return `${d.status==='manual'?'수동 설정':'어깨·골반 기반 추정'} ${angle}° · 카메라에 ${names[facingRelation(e,cameraPosition(camera),d.heading)]} · 왼쪽: ${basket[facingRelation(e,{x:1.575,y:7.5},d.heading)]} / 오른쪽: ${basket[facingRelation(e,{x:26.425,y:7.5},d.heading)]} · 몸 방향이며 실제 시선은 아닙니다.`;
}
