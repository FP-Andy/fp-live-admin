// Object review owns membership and roles; spatial review owns direction,
// team overrides and explicitly edited court positions.
export function reconcileScene(frame,previous,defaults){
 const old=new Map((previous?.entities||[]).map(e=>[e.id,e]));
 const boxes=new Map(frame.boxes.map(b=>[b.id,b]));
 const entities=frame.floorPositions.map(p=>{
  const e=structuredClone(old.get(p.id)||{}),b=boxes.get(p.id);
  if(e.role!==p.role){delete e.team;delete e.teamSource;}
  if(e.positionSource!=='manual'||![e.x,e.y].every(Number.isFinite)){
   e.x=p.xy[0];e.y=p.xy[1];e.positionSource=p.source==='wide-manual-evidence'?'wide-manual-estimate':p.status?.startsWith('manual-floor')?'manual-footpoint-proxy':'bbox-footpoint-proxy';
  }
  return {bodyHeading:0,...e,id:p.id,role:p.role,positionOnly:p.positionOnly===true,roleSource:p.source==='wide-manual-evidence'?'wide-manual-evidence':b?.roleSource||'model'};
 });
 // A cropped person may have no measured footpoint. Keep an operator's court
 // placement while the same reviewed image object is still present.
 const placed=new Set(entities.map(e=>e.id));
 for(const b of frame.boxes){
  const e=old.get(b.id);
  if(!placed.has(b.id)&&(!b.spatialExcluded||e?.spatialOverride===true)&&e?.positionSource==='manual'&&[e.x,e.y].every(Number.isFinite)){
   const copy=structuredClone(e);if(copy.role!==b.roleHint){delete copy.team;delete copy.teamSource;}
   entities.push({...copy,id:b.id,role:b.roleHint,roleSource:b.roleSource||'model'});
  }
 }
 return {...structuredClone(defaults),...structuredClone(previous||{}),entities};
}
