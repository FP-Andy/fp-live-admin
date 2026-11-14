// Model coordinates: x = court length, y = court width, z = height (metres).
import {humanHit} from "./human.mjs";
import {meshHumanHit,eyePosition} from "./mesh-human.mjs";
export const DEFAULTS = Object.freeze({radius: .28, bodyHeight: 1.9, eyeHeight: 1.65, hfov: 120, vfov: 90, threshold: .5,bodyModel:"mpfb",refereeHeight:1.82,pose:"neutral"});
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const rad = d => d * Math.PI / 180;
export const bearing = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
export function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

// Exact finite upright cylinder intersection, including its caps.
export function cylinderHit(a, b, body, radius = DEFAULTS.radius, height = DEFAULTS.bodyHeight) {
  const dx = b.x-a.x, dy = b.y-a.y, dz = b.z-a.z;
  const ox = a.x-body.x, oy = a.y-body.y;
  const aa = dx*dx + dy*dy, bb = 2*(ox*dx+oy*dy), cc = ox*ox+oy*oy-radius*radius;
  const candidates = [];
  if (aa > 1e-12) {
    const disc = bb*bb - 4*aa*cc;
    if (disc >= 0) for (const sign of [-1,1]) {
      const t = (-bb+sign*Math.sqrt(disc))/(2*aa), z = a.z+t*dz;
      if (z >= 0 && z <= height) candidates.push(t);
    }
  }
  if (Math.abs(dz) > 1e-12) for (const z of [0,height]) {
    const t = (z-a.z)/dz;
    if ((ox+t*dx)**2+(oy+t*dy)**2 <= radius*radius) candidates.push(t);
  }
  return candidates.filter(t => t > 1e-5 && t < 1-1e-5).sort((a,b)=>a-b)[0] ?? null;
}

export function inFov(eye, target, heading, config = DEFAULTS) {
  if (!Number.isFinite(heading)) return false;
  const horizontal = Math.hypot(target.x-eye.x, target.y-eye.y);
  return Math.abs(wrapAngle(bearing(eye,target)-heading)) <= rad(config.hfov/2) + 1e-9
    && Math.abs(Math.atan2(target.z-eye.z,horizontal)) <= rad(config.vfov/2) + 1e-9;
}

// A 30 cm wide × 30 cm high contact patch, facing the observer.
// For a selected person, place the patch on the near cylinder surface.
export function targetSamples(eye, target, config = DEFAULTS) {
  const angle = bearing(target,eye), ux = Math.cos(angle), uy = Math.sin(angle);
  const ball=target.kind==="ball",offset=ball ? .12 :target.entityId?config.radius:0,size=ball ? .085 :.15;
  const x = target.x + offset*ux;
  const y = target.y + offset*uy;
  return [-size,0,size].flatMap(u => [-size,0,size].map(v => ({
    x:x-u*uy,y:y+u*ux,z:Math.max(.02,target.z+v)
  })));
}

export function visibility(observer, target, bodies, config = DEFAULTS) {
  if (!observer || !target || !Number.isFinite(observer.heading)) return null;
  const eye = config.bodyModel==="mpfb"?eyePosition(observer,config):{x:observer.x,y:observer.y,z:config.eyeHeight};
  const rays = targetSamples(eye,target,config).map(end => {
    if (!inFov(eye,end,observer.heading,config)) return {eye,end,state:"outside",blocker:null};
    let nearest = null, hit = Infinity;
    for (const body of bodies) {
      if (body.id === observer.id || body.id === target.entityId) continue;
      const t = config.bodyModel==="cylinder"?cylinderHit(eye,end,body,config.radius,config.bodyHeight):config.bodyModel==="mpfb"?meshHumanHit(eye,end,body,config):humanHit(eye,end,body,config);
      if (t !== null && t < hit) {hit=t; nearest=body.id;}
    }
    return {eye,end,state:nearest===null?"visible":"blocked",blocker:nearest,
      hit:nearest===null?null:{x:eye.x+(end.x-eye.x)*hit,y:eye.y+(end.y-eye.y)*hit,z:eye.z+(end.z-eye.z)*hit}};
  });
  return {fraction:rays.filter(r=>r.state==="visible").length/rays.length,rays,
    blockers:[...new Set(rays.map(r=>r.blocker).filter(x=>x!==null))]};
}

export function crewVisibility(results, complete, threshold = .5) {
  const valid = results.filter(Boolean), best = valid.length ? Math.max(...valid.map(v=>v.fraction)) : null;
  // Detection completeness must be reviewed; an omitted body can change every ray.
  if (!complete) return {state:"unknown",best};
  if (best !== null && best >= threshold) return {state:"covered",best};
  return {state:valid.length===3?"gray":"unknown",best};
}

// Nine manually placed image anchors model curved court lines. This is a
// provisional quadratic warp, NOT a calibrated lens or a measured 3D camera.
const basis = t => [2*(t-.5)*(t-1),4*t*(1-t),2*t*(t-.5)];
export function courtToImage(x,y,anchors) {
  const u=basis(x/28),v=basis(y/15), p=[0,0];
  for(let j=0;j<3;j++) for(let i=0;i<3;i++) {
    p[0]+=anchors[j*3+i][0]*u[i]*v[j]; p[1]+=anchors[j*3+i][1]*u[i]*v[j];
  }
  return p;
}
export function imageToCourt(px,py,anchors) {
  let x=14,y=7.5;
  for(let n=0;n<18;n++){
    const p=courtToImage(x,y,anchors),a=courtToImage(x+.01,y,anchors),b=courtToImage(x,y+.01,anchors);
    const ax=(a[0]-p[0])/.01, ay=(a[1]-p[1])/.01,bx=(b[0]-p[0])/.01,by=(b[1]-p[1])/.01;
    const det=ax*by-ay*bx;if(Math.abs(det)<1e-9)return null;
    const ex=px-p[0],ey=py-p[1];
    const dx=(ex*by-ey*bx)/det,dy=(ax*ey-ay*ex)/det;
    x+=clamp(dx,-15,15);y+=clamp(dy,-10,10);
    if(Math.hypot(ex,ey)<.05) return {x,y};
  }
  return null;
}
export function validCalibration(anchors) {
  if(!Array.isArray(anchors)||anchors.length!==9||anchors.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<0||p[0]>1920||p[1]<0||p[1]>1080))return false;
  // A fold or collapsed patch reverses/destroys the image-to-court mapping.
  for(let x=0;x<=28;x+=3.5)for(let y=0;y<=15;y+=1.875){
    const p=courtToImage(x,y,anchors),a=courtToImage(x+.01,y,anchors),b=courtToImage(x,y+.01,anchors);
    const determinant=((a[0]-p[0])*(b[1]-p[1])-(a[1]-p[1])*(b[0]-p[0]))/.0001;
    if(!Number.isFinite(determinant)||determinant<1)return false;
  }
  return true;
}

// Interpolate matching IDs only across adjacent 5 Hz samples. No gap filling.
export function sampleTracks(frames,t,maxGap=.25) {
  if(!frames?.length)return [];
  let lo=0,hi=frames.length-1;
  while(lo<hi){const m=Math.ceil((lo+hi)/2);if(frames[m].t<=t)lo=m;else hi=m-1;}
  const a=frames[lo],b=frames[lo+1];
  if(t<a.t-.001 || t-a.t>maxGap)return [];
  if(Math.abs(t-a.t)<.001)return a.boxes.map(q=>({...q,source:"detected"}));
  if(!b || b.t-a.t>maxGap)return []; // Never hold an unseen body at the end of a gap.
  const next=new Map(b.boxes.map(q=>[q.id,q])),u=(t-a.t)/(b.t-a.t);
  return a.boxes.filter(q=>next.has(q.id)).map(q=>{
    const r=next.get(q.id);
    return {...q,roleHint:q.roleHint===r.roleHint?q.roleHint:'unknown',box:q.box.map((n,i)=>n+(r.box[i]-n)*u),
      maskPolygon:null,
      confidence:Number.isFinite(q.confidence)&&Number.isFinite(r.confidence)?Math.min(q.confidence,r.confidence):null,
      source:"interpolated"};
  });
}

export function accumulateHeat(samples, cellCount) {
  const gray=new Float64Array(cellCount), valid=new Float64Array(cellCount);
  for(let i=0;i<samples.length-1;i++){
    const s=samples[i],dt=samples[i+1].t-s.t;
    if(!(dt>0 && dt<=.25))continue;
    s.cells.forEach((v,j)=>{if(v===null)return;valid[j]+=dt;if(v)gray[j]+=dt;});
  }
  return Array.from(valid,(seconds,i)=>({seconds,ratio:seconds?gray[i]/seconds:null}));
}
