// Court positions are editable estimates. A floor homography must never be
// applied directly to a visible shoulder or to the bottom of a clipped box.
export const POSITION_LIMITS={x:[-4,32],y:[-3,19]};
export function validCourtPosition(p){return p&&['x','y'].every(k=>Number.isFinite(p[k])&&p[k]>=POSITION_LIMITS[k][0]&&p[k]<=POSITION_LIMITS[k][1]);}
export function setCourtPosition(entity,p,evidence=null){
 if(!validCourtPosition(p))throw Error('코트 주변을 포함한 X -4~32m, Y -3~19m 범위로 지정하세요.');
 entity.x=p.x;entity.y=p.y;entity.positionSource='manual';
 entity.positionEvidence=evidence||{method:'operator-map',estimated:true};
 return entity;
}
function solve3(a,b){
 const m=a.map((r,i)=>[...r,b[i]]);
 for(let c=0;c<3;c++){
  let pivot=c;for(let r=c+1;r<3;r++)if(Math.abs(m[r][c])>Math.abs(m[pivot][c]))pivot=r;
  if(!Number.isFinite(m[pivot][c])||Math.abs(m[pivot][c])<1e-10)return null;
  [m[c],m[pivot]]=[m[pivot],m[c]];const d=m[c][c];for(let j=c;j<4;j++)m[c][j]/=d;
  for(let r=0;r<3;r++)if(r!==c){const f=m[r][c];for(let j=c;j<4;j++)m[r][j]-=f*m[c][j];}
 }
 return m.map(r=>r[3]);
}
export function heightPlanePosition(pixel,height,camera){
 const {K,worldToCamera:R,translation:t}=camera||{};
 if(!K||!R||!t||!pixel?.every(Number.isFinite)||!Number.isFinite(height))return null;
 // Pz = K [R_col0 R_col1 R_col2*z+t], with world Z vertical.
 const plane=R.map((row,i)=>[row[0],row[1],row[2]*height+t[i]]);
 const H=K.map(row=>[0,1,2].map(j=>row.reduce((v,a,k)=>v+a*plane[k][j],0)));
 const q=solve3(H,[...pixel,1]);if(!q||Math.abs(q[2])<1e-10)return null;
 const p={x:q[0]/q[2],y:q[1]/q[2]};return validCourtPosition(p)?p:null;
}
export function proposeGroundPosition(person,camera,assumedHeight=1.8){
 if(!person||!Number.isFinite(assumedHeight)||assumedHeight<1.3||assumedHeight>2.4)return null;
 for(const [anchor,indices,fraction] of [['shoulders',[5,6],.82],['hips',[11,12],.53]]){
  if(!indices.every(i=>(person.manualJoints?.[i]||person.scores?.[i]>=.5)&&person.keypoints?.[i]?.slice(0,2).every(Number.isFinite)))continue;
  const pixel=[0,1].map(k=>indices.reduce((s,i)=>s+person.keypoints[i][k],0)/indices.length);
  const p=heightPlanePosition(pixel,assumedHeight*fraction,camera);if(!p)continue;
  const alternatives=[-.12,.12].map(d=>heightPlanePosition(pixel,(assumedHeight+d)*fraction,camera));
  const spread=Math.max(...alternatives.filter(Boolean).map(v=>Math.hypot(v.x-p.x,v.y-p.y)),0);
  // Proposal only. The operator must compare the image/court and accept it.
  return {...p,evidence:{method:'height-plane-proposal',anchor,assumedHeight,estimated:true,pixel,heightSensitivityMetres:spread}};
 }
 return null;
}
