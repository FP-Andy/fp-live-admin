// One immutable mesh per role/pose: both Three.js and CPU rays use these Float32 vertices.
let library=null;
const trees=new Map();
export function registerHumanMeshes(data){
  if(data?.schema!=="kbl-mpfb-mesh/v1")throw Error("지원하지 않는 인체 모델입니다.");
  library=data;trees.clear();
  appendHumanMeshes(data);
}
export function appendHumanMeshes(data){
  if(!library||data?.schema!=="kbl-mpfb-mesh/v1")throw Error("인체 메시 라이브러리가 필요합니다.");
  for(const [key,a] of Object.entries(data.assets)){
    if(trees.has(key))continue;
    library.assets[key]=a;
    a.positions=new Float32Array(a.positions);
    // A bald mannequin uses the underlying head surface. Remove decorative
    // hair and eyes from BOTH drawing and the occlusion BVH.
    a.parts=a.parts.filter(p=>!['hair','eyes','iris'].includes(p.material)).map(p=>({...p,indices:new Uint32Array(p.indices)}));
    a.indices=new Uint32Array(a.parts.flatMap(p=>Array.from(p.indices)));
    trees.set(key,buildBVH(a,Array.from({length:a.indices.length/3},(_,i)=>i)));
  }
}
export async function loadHumanMeshes(){
  const response=await fetch(new URL('./assets/humans/mpfb-court-v1.json',import.meta.url));
  if(!response.ok)throw Error(`인체 에셋 HTTP ${response.status}`);
  registerHumanMeshes(await response.json());
}
export function humanModelInfo(){return library?{id:library.id,generator:library.generator,sourceCommit:library.sourceCommit,license:library.license,geometrySha256:library.geometrySha256,collision:'rendered-triangles-bvh',poseMeasured:false}:null;}
export function humanSpec(body,config){
  const referee=body.role?.startsWith('ref'),pose=body.pose||config.pose||'neutral';
  const height=body.height??(referee?(config.refereeHeight??1.82):config.bodyHeight);
  const width=body.width??config.radius;
  return {key:body.meshKey||`${referee?'referee':'player'}-${pose}`,pose,height,width,
    heightScale:height/1.9,widthScale:width/.28,heading:body.meshKey?(Number.isFinite(body.poseBodyHeading)?(body.bodyHeading??body.poseBodyHeading)-body.poseBodyHeading:0):(body.bodyHeading??body.heading??0)};
}
export function humanMesh(body,config){
  const spec=humanSpec(body,config),mesh=library?.assets[spec.key];
  if(!mesh)throw Error('MPFB 인체 메시가 준비되지 않았습니다.');
  return mesh;
}
export function eyeHeight(body,config){return eyePosition(body,config).z;}
export function eyePosition(body,config){
  if(body.meshKey&&body.eyeLocal)return localToCourt(body.eyeLocal,body,config);
  return {x:body.x,y:body.y,z:config.eyeHeight*humanSpec(body,config).height/(body.role?.startsWith('ref')?1.82:1.9)};
}
export function localToCourt(p,body,config){
  const s=humanSpec(body,config),c=Math.cos(s.heading),n=Math.sin(s.heading);
  return {x:body.x+(p[0]*c-p[1]*n)*s.widthScale,y:body.y+(p[0]*n+p[1]*c)*s.widthScale,z:p[2]*s.heightScale};
}
function inverse(p,body,s){
  const x=p.x-body.x,y=p.y-body.y,c=Math.cos(s.heading),n=Math.sin(s.heading);
  return [(x*c+y*n)/s.widthScale,(-x*n+y*c)/s.widthScale,p.z/s.heightScale];
}
function triangleBounds(mesh,id){
  const p=mesh.positions,t=mesh.indices;
  return [0,1,2].map(k=>{const a=p[t[id*3]*3+k],b=p[t[id*3+1]*3+k],c=p[t[id*3+2]*3+k];return [Math.min(a,b,c),Math.max(a,b,c)];});
}
function buildBVH(mesh,ids){
  const bound=[[Infinity,-Infinity],[Infinity,-Infinity],[Infinity,-Infinity]],centers=new Map();
  for(const id of ids){const b=triangleBounds(mesh,id);centers.set(id,b.map(a=>(a[0]+a[1])/2));for(let k=0;k<3;k++){bound[k][0]=Math.min(bound[k][0],b[k][0]);bound[k][1]=Math.max(bound[k][1],b[k][1]);}}
  if(ids.length<=12)return {bound,ids};
  const axis=[0,1,2].sort((a,b)=>(bound[b][1]-bound[b][0])-(bound[a][1]-bound[a][0]))[0];
  ids.sort((a,b)=>centers.get(a)[axis]-centers.get(b)[axis]);const mid=ids.length>>1;
  return {bound,left:buildBVH(mesh,ids.slice(0,mid)),right:buildBVH(mesh,ids.slice(mid))};
}
function boxHit(a,d,b,max){
  let low=0,high=max;
  for(let k=0;k<3;k++){
    if(Math.abs(d[k])<1e-12){if(a[k]<b[k][0]||a[k]>b[k][1])return false;continue;}
    let t0=(b[k][0]-a[k])/d[k],t1=(b[k][1]-a[k])/d[k];if(t0>t1)[t0,t1]=[t1,t0];
    low=Math.max(low,t0);high=Math.min(high,t1);if(low>high)return false;
  }return true;
}
// Double sided Möller–Trumbore. Decorative labels/rings are deliberately not occluders.
export function triangleHit(a,d,p,index,id){
  const i0=index[id*3]*3,i1=index[id*3+1]*3,i2=index[id*3+2]*3;
  const ex=p[i1]-p[i0],ey=p[i1+1]-p[i0+1],ez=p[i1+2]-p[i0+2];
  const fx=p[i2]-p[i0],fy=p[i2+1]-p[i0+1],fz=p[i2+2]-p[i0+2];
  const hx=d[1]*fz-d[2]*fy,hy=d[2]*fx-d[0]*fz,hz=d[0]*fy-d[1]*fx;
  const det=ex*hx+ey*hy+ez*hz;if(Math.abs(det)<1e-10)return null;
  const sx=a[0]-p[i0],sy=a[1]-p[i0+1],sz=a[2]-p[i0+2],inv=1/det;
  const u=(sx*hx+sy*hy+sz*hz)*inv;if(u<0||u>1)return null;
  const qx=sy*ez-sz*ey,qy=sz*ex-sx*ez,qz=sx*ey-sy*ex;
  const v=(d[0]*qx+d[1]*qy+d[2]*qz)*inv;if(v<0||u+v>1)return null;
  const t=(fx*qx+fy*qy+fz*qz)*inv;return t>1e-5&&t<1-1e-5?t:null;
}
export function meshHumanHit(a,b,body,config){
  const s=humanSpec(body,config),mesh=humanMesh(body,config),start=inverse(a,body,s),end=inverse(b,body,s),d=end.map((x,i)=>x-start[i]);
  let nearest=1;const stack=[trees.get(s.key)];
  while(stack.length){const n=stack.pop();if(!boxHit(start,d,n.bound,nearest))continue;
    if(n.ids){for(const id of n.ids){const t=triangleHit(start,d,mesh.positions,mesh.indices,id);if(t!==null&&t<nearest)nearest=t;}}
    else stack.push(n.left,n.right);
  }return nearest<1?nearest:null;
}
