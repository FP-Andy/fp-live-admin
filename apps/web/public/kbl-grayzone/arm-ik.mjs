// Shoulder-relative, body axes: forward X / left Y / up Z. Reviewer assumptions.
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const mul=(a,k)=>a.map(x=>x*k),add=(a,b)=>a.map((x,i)=>x+b[i]),sub=(a,b)=>a.map((x,i)=>x-b[i]);
const unit=a=>{const n=Math.hypot(...a);if(n<1e-8)throw Error('팔 관절이 겹칩니다. 팔꿈치와 손목을 분리하세요.');return mul(a,1/n);};
const angle=(a,b)=>Math.acos(Math.max(-1,Math.min(1,dot(a,b))));
const rotate=(v,axis,t)=>{axis=unit(axis);return add(add(mul(v,Math.cos(t)),mul(cross(axis,v),Math.sin(t))),mul(axis,dot(axis,v)*(1-Math.cos(t))));};
function swing(v,a,b){const t=angle(a,b);if(t<1e-5)return v;let axis=cross(a,b);if(dot(a,b)<-1+1e-10){const basis=[0,0,0];basis[a.map(Math.abs).indexOf(Math.min(...a.map(Math.abs)))]=1;axis=cross(a,basis);}return rotate(v,axis,t);}
export function solveArm(target,rig){
 const u=unit(target.elbow),elbow=mul(u,rig.upperLength),v=unit(sub(target.wrist,elbow)),a=unit(rig.neutralUpper),b=unit(rig.neutralLower),pole=unit(swing(unit(cross(a,b)),a,u));
 const rawBend=angle(u,v),bend=Math.min(rawBend,145*Math.PI/180),desired=rawBend>=8*Math.PI/180?unit(cross(u,v)):pole;
 const rawTwist=Math.atan2(dot(u,cross(pole,desired)),dot(pole,desired)),twist=Math.max(-110*Math.PI/180,Math.min(110*Math.PI/180,rawTwist)),hinge=rotate(pole,u,twist),lower=rotate(u,hinge,bend);
 return {elbow,wrist:add(elbow,mul(lower,rig.lowerLength)),upper:u,lower,limited:rawBend>145*Math.PI/180+1e-7||Math.abs(rawTwist)>110*Math.PI/180+1e-7,flexionDegrees:bend*180/Math.PI,twistDegrees:twist*180/Math.PI};
}
// Explicit reviewer preset only. It never replaces a detected/manual arm unless
// the operator chooses and saves it. The same constrained solver is used on save.
export function forwardNeutralArm(rig,side){
 const sign=side==='l'?1:-1,upper=unit([.18,sign*.18,-.96]),lower=unit([.5,sign*.08,-.86]);
 const elbow=mul(upper,rig.upperLength),wrist=add(elbow,mul(lower,rig.lowerLength));
 return solveArm({elbow,wrist},rig);
}
