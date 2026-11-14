import {imageToCourt} from "./geometry.mjs";
export const ballSource={manual:"수동 기준점",detected:"자동 검출 · 미검토",flow:"움직임 추적 · 미검토",interpolated:"짧은 구간 보간"};
export function sampleBall(samples,t,fps=30){
  if(!samples?.length)return null;
  let lo=0,hi=samples.length-1;
  while(lo<hi){const m=Math.floor((lo+hi)/2);if(samples[m].t<t)lo=m+1;else hi=m;}
  const near=[samples[lo-1],samples[lo]].filter(Boolean).sort((a,b)=>Math.abs(a.t-t)-Math.abs(b.t-t))[0];
  // Samples describe individual video frames. No last-position hold.
  return near&&!near.missing&&Math.abs(near.t-t)<=.51/fps?near:null;
}
export function projectBall(sample,anchors,people,height=1.2){
  if(!sample?.point)return null;
  const near=people.filter(e=>e.box).map(e=>({e,d:Math.hypot(e.foot[0]-sample.point[0],e.foot[1]-sample.point[1])})).sort((a,b)=>a.d-b.d)[0];
  // Single-view height is not observable. Approximate local vertical pixel scale
  // from nearby detected people; the operator can change the explicit height.
  const scale=near&&near.d<300?(near.e.box[3]-near.e.box[1])*1080/1.9:30;
  const p=imageToCourt(sample.point[0],sample.point[1]+height*scale,anchors);
  return p?{...p,z:height,t:sample.t,source:sample.source,point:sample.point,kind:"ball",radius:.12,heightMeasured:false}:null;
}
export function ballSegments(samples,fps=30){
  const out=[];
  for(const s of samples||[]){
    if(s.missing)continue;
    const kind=s.source==="manual"||s.source==="detected"?"observed":s.source,previous=out.at(-1);
    if(previous&&previous.kind===kind&&s.t-previous.end<1.1/fps)previous.end=s.t;
    else out.push({start:s.t,end:s.t,kind});
  }return out;
}
