// Distances use video-height units (x is aspect-corrected), not court metres.
// The court polygon is the calibrated fixed-camera ROI saved with the run.
export function courtPosition(box, roi, aspect) {
  if(!Array.isArray(roi)||roi.length<3||!roi.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))return null;
  const point=[(box[0]+box[2])/2*aspect,(box[1]+box[3])/2];
  const polygon=roi.map(([x,y])=>[x*aspect,y]);
  let inside=false,nearest={distance:Infinity,edge:-1};
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[j],b=polygon[i],dx=b[0]-a[0],dy=b[1]-a[1];
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    const u=Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
    const distance=Math.hypot(point[0]-a[0]-u*dx,point[1]-a[1]-u*dy);
    if(distance<nearest.distance)nearest={distance,edge:j};
  }
  return {...nearest,inside:inside||nearest.distance<1e-8,point};
}

export const TOUCHLINE_MEMORY_SECONDS=20;
export const TOUCHLINE_NEAR=.065;

export function touchlineEvidence(last,box,roi,aspect,gap,consistentFrames) {
  if(!last.boundary||gap<.4||gap>TOUCHLINE_MEMORY_SECONDS||consistentFrames<3)return null;
  const next=courtPosition(box,roi,aspect),previous=last.boundary;
  if(!next||next.distance>.10)return null;
  const distance=Math.hypot(next.point[0]-previous.point[0],next.point[1]-previous.point[1]);
  // Nearby corners may change the nearest edge, but not the exit location.
  if((next.edge!==previous.edge&&distance>.055)||distance>.16)return null;
  return {distance,motion:Math.max(0,1-distance/.20),recency:Math.max(0,1-gap/TOUCHLINE_MEMORY_SECONDS),edge:previous.edge};
}
