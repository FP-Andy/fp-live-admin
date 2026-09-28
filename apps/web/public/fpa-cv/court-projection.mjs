// Four-point planar calibration. Corner order may start anywhere, but must
// follow the boundary. The nearest image top-left corner becomes pitch (0,0).
export function courtProjection(roi, turn=0) {
  if(!Array.isArray(roi)||roi.length!==4||!roi.every(p=>p.length===2&&p.every(Number.isFinite)))throw Error('히트맵에는 코트 네 꼭짓점 지정이 필요합니다.');
  let points=roi.map(p=>p.slice());
  const crosses=points.map((a,i)=>{const b=points[(i+1)%4],c=points[(i+2)%4];return (b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);});
  if(crosses.some(v=>Math.abs(v)<1e-8)||!crosses.every(v=>Math.sign(v)===Math.sign(crosses[0])))throw Error('코트 꼭짓점이 교차하거나 너무 가깝습니다.');
  if(crosses[0]<0)points.reverse();
  const first=points.reduce((best,p,i)=>p[0]+p[1]<points[best][0]+points[best][1]?i:best,0);
  points=points.map((_,i)=>points[(first+turn+i)%4]);
  const target=[[0,0],[1,0],[1,1],[0,1]],matrix=[];
  points.forEach(([x,y],i)=>{const [u,v]=target[i];matrix.push([x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]);});
  for(let c=0;c<8;c++){
    let pivot=c;for(let r=c+1;r<8;r++)if(Math.abs(matrix[r][c])>Math.abs(matrix[pivot][c]))pivot=r;
    [matrix[c],matrix[pivot]]=[matrix[pivot],matrix[c]];
    if(Math.abs(matrix[c][c])<1e-10)throw Error('코트 원근 보정을 계산할 수 없습니다.');
    const divisor=matrix[c][c];for(let j=c;j<9;j++)matrix[c][j]/=divisor;
    for(let r=0;r<8;r++)if(r!==c){const scale=matrix[r][c];for(let j=c;j<9;j++)matrix[r][j]-=scale*matrix[c][j];}
  }
  const h=matrix.map(row=>row[8]);
  return ([x,y])=>{const w=h[6]*x+h[7]*y+1;return Math.abs(w)<1e-9?null:[(h[0]*x+h[1]*y+h[2])/w,(h[3]*x+h[4]*y+h[5])/w];};
}

