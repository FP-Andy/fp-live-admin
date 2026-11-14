// The renderer and visibility solver consume these same articulated primitives.
// This is a generic mannequin; no body dimensions or poses are measured.
export function humanParts(body,config){
  const h=config.bodyHeight/1.9,w=config.radius/.28,heading=body.heading??body.bodyHeading??0;
  const phase=body.posePhase||0,swing=Math.sin(phase)*Math.min(body.speed||0,3)/3*.19;
  const parts=[],referee=body.role?.startsWith("ref");
  const ell=(name,c,r,material)=>parts.push({kind:"ellipsoid",name,c:c.map(v=>v*h),r:[r[0]*w,r[1]*w,r[2]*h],heading,material});
  const cap=(name,a,b,r,material)=>parts.push({kind:"capsule",name,a:a.map(v=>v*h),b:b.map(v=>v*h),r:r*w,heading,material});
  // Local x faces forward; local y is the shoulder axis.
  ell("torso",[0,0,1.26],[.15,.245,.34],"jersey");
  ell("hips",[0,0,.91],[.155,.215,.16],"shorts");
  ell("neck",[0,0,1.61],[.073,.075,.08],"skin");
  ell("head",[0,0,1.755],[.12,.125,.145],"skin");
  ell("hair",[-.005,0,1.825],[.121,.126,.075],"hair");
  for(const side of [-1,1]){
    const s=side===1?"r":"l",step=side*swing;
    cap(`thigh-${s}`,[0,side*.115,.88],[step,side*.12,.52],.092,"shorts");
    cap(`shin-${s}`,[step,side*.12,.52],[-step*.75,side*.12,.15],.065,referee?"shorts":"skin");
    ell(`shoe-${s}`,[.045-step*.75,side*.12,.075],[.16,.09,.075],"shoes");
    cap(`upper-arm-${s}`,[0,side*.235,1.47],[-step*.5,side*.31,1.18],.065,referee?"jersey":"skin");
    cap(`forearm-${s}`,[-step*.5,side*.31,1.18],[.055-step,side*.32,.94],.052,"skin");
    ell(`hand-${s}`,[.055-step,side*.32,.92],[.055,.047,.075],"skin");
  }
  return parts;
}
export function toLocal(p,body,heading){
  const x=p.x-body.x,y=p.y-body.y,c=Math.cos(heading),s=Math.sin(heading);
  return [x*c+y*s,-x*s+y*c,p.z];
}
function sphereHit(a,d,c,r){
  const o=a.map((v,i)=>v-c[i]),aa=d.reduce((n,v)=>n+v*v,0),bb=2*o.reduce((n,v,i)=>n+v*d[i],0),cc=o.reduce((n,v)=>n+v*v,0)-r*r;
  if(aa<1e-12)return null;
  const disc=bb*bb-4*aa*cc;if(disc<0)return null;
  return [(-bb-Math.sqrt(disc))/(2*aa),(-bb+Math.sqrt(disc))/(2*aa)].find(t=>t>1e-5&&t<1-1e-5)??null;
}
export function primitiveHit(a,b,part){
  const d=b.map((v,i)=>v-a[i]);
  if(part.kind==="ellipsoid")return sphereHit(a.map((v,i)=>(v-part.c[i])/part.r[i]),d.map((v,i)=>v/part.r[i]),[0,0,0],1);
  const axis=part.b.map((v,i)=>v-part.a[i]),len=Math.hypot(...axis),u=axis.map(v=>v/len),o=a.map((v,i)=>v-part.a[i]);
  const dot=(x,y)=>x.reduce((n,v,i)=>n+v*y[i],0),du=dot(d,u),ou=dot(o,u);
  const dp=d.map((v,i)=>v-du*u[i]),op=o.map((v,i)=>v-ou*u[i]);
  const aa=dot(dp,dp),bb=2*dot(dp,op),cc=dot(op,op)-part.r**2,candidates=[];
  const disc=bb*bb-4*aa*cc;
  if(aa>1e-12&&disc>=0)for(const sign of [-1,1]){
    const t=(-bb+sign*Math.sqrt(disc))/(2*aa),along=ou+t*du;
    if(t>1e-5&&t<1-1e-5&&along>=0&&along<=len)candidates.push(t);
  }
  for(const center of [part.a,part.b]){const t=sphereHit(a,d,center,part.r);if(t!==null)candidates.push(t);}
  return candidates.length?Math.min(...candidates):null;
}
export function humanHit(a,b,body,config){
  const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
  const u=den?Math.max(0,Math.min(1,((body.x-a.x)*dx+(body.y-a.y)*dy)/den)):0;
  if(Math.hypot(a.x+u*dx-body.x,a.y+u*dy-body.y)>.55*Math.max(config.radius/.28,config.bodyHeight/1.9))return null;
  const parts=body.parts||humanParts(body,config),heading=parts[0].heading;
  const aa=toLocal(a,body,heading),bb=toLocal(b,body,heading);let best=null;
  for(const p of parts){const t=primitiveHit(aa,bb,p);if(t!==null&&(best===null||t<best))best=t;}
  return best;
}
