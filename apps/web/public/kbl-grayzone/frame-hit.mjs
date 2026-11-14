// Hit tolerance is expressed in rendered pixels so small review frames stay usable.
export function hitBoxes(objects, [x,y]) {
  return objects.filter(o=>!o.excluded && x>=o.pixelBox[0] && x<=o.pixelBox[2] && y>=o.pixelBox[1] && y<=o.pixelBox[3])
    .sort((a,b)=>(a.pixelBox[2]-a.pixelBox[0])*(a.pixelBox[3]-a.pixelBox[1])-(b.pixelBox[2]-b.pixelBox[0])*(b.pixelBox[3]-b.pixelBox[1]));
}
export function hitJoint(people, [x,y], scaleX, scaleY, selectedId, radius=11) {
  const hits=[];
  for(const p of people)for(let i=5;i<17;i++){
    const q=p.keypoints[i],distance=Math.hypot((q[0]-x)*scaleX,(q[1]-y)*scaleY);
    if(distance<=radius)hits.push({personId:p.id,joint:i,distance});
  }
  // A selected person's coincident joint wins; a genuinely closer point still wins.
  return hits.sort((a,b)=>Math.abs(a.distance-b.distance)<1?Number(b.personId===selectedId)-Number(a.personId===selectedId):a.distance-b.distance)[0]||null;
}
