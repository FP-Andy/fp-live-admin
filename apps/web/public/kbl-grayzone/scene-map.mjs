import {courtLines} from './court-asset.mjs';
import {coverageGrid,crewObservers} from './crew-analysis.mjs';
export const MAP={width:1280,height:800,scale:28.5,x:(1280-28*28.5)/2,y:103};
export const mapPoint=e=>[MAP.x+e.x*MAP.scale,MAP.y+e.y*MAP.scale];
export const mapCourt=([x,y])=>({x:(x-MAP.x)/MAP.scale,y:(y-MAP.y)/MAP.scale});
export function targetMarker(target){return mapPoint(target);}
export function directionHandle(e){const [x,y]=mapPoint(e),a=e.viewHeading??e.bodyHeading;return [x+Math.cos(a)*64,y+Math.sin(a)*64];}
export function pickMap(bodies,p,scale=1,currentId=null){
 const hits=bodies.map(e=>({e,d:Math.hypot(...mapPoint(e).map((v,i)=>(v-p[i])*scale))})).filter(h=>h.d<14).sort((a,b)=>a.d-b.d);
 if(!hits.length)return null;
 const cluster=hits.filter(h=>h.d<hits[0].d+7),index=cluster.findIndex(h=>h.e.id===currentId);
 return cluster[(index+1)%cluster.length].e;
}
export function drawSceneMap(canvas,{bodies,observer,target,result,config},selectedId,caseData,coverage=null){
 const ctx=canvas.getContext('2d');ctx.clearRect(0,0,1280,800);ctx.fillStyle='#f3f4f6';ctx.fillRect(0,0,1280,800);
 ctx.fillStyle='#ba8254';ctx.fillRect(MAP.x-4*MAP.scale,MAP.y-3*MAP.scale,36*MAP.scale,22*MAP.scale);
 ctx.fillStyle='#dba46e';ctx.fillRect(MAP.x,MAP.y,28*MAP.scale,15*MAP.scale);ctx.save();ctx.translate(MAP.x,MAP.y);courtLines(ctx,28*MAP.scale,15*MAP.scale);ctx.restore();
 ctx.fillStyle='#343b4a';ctx.font='18px "KBL Jump",sans-serif';ctx.fillText('왼쪽 골대',MAP.x,23);ctx.fillText('오른쪽 골대',MAP.x+28*MAP.scale-100,23);
 if(coverage){
  for(const cell of coverage.cells){if(cell.occupied)continue;ctx.fillStyle=cell.visible?['','#c4eadb','#77c5a7','#32866c'][cell.visible]:coverage.complete?'#9399a5':'#e9e9ef';ctx.globalAlpha=.79;ctx.fillRect(MAP.x+cell.x*MAP.scale,MAP.y+cell.y*MAP.scale,cell.w*MAP.scale+.3,cell.h*MAP.scale+.3);}
  ctx.globalAlpha=1;ctx.save();ctx.translate(MAP.x,MAP.y);courtLines(ctx,28*MAP.scale,15*MAP.scale,0,true);ctx.restore();
 }
 const [ox,oy]=observer?mapPoint(observer):[0,0];
 for(const viewer of coverage?.observers||(observer?[observer]:[])){const [vx,vy]=mapPoint(viewer);ctx.save();ctx.beginPath();ctx.rect(MAP.x-4*MAP.scale,MAP.y-3*MAP.scale,36*MAP.scale,22*MAP.scale);ctx.clip();ctx.fillStyle='#fff0ba22';ctx.strokeStyle='#e76925';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(vx,vy);for(let a=viewer.heading-config.hfov*Math.PI/360;a<=viewer.heading+config.hfov*Math.PI/360+.01;a+=.02)ctx.lineTo(vx+Math.cos(a)*1200,vy+Math.sin(a)*1200);ctx.closePath();if(!coverage)ctx.fill();ctx.stroke();ctx.restore();}
 for(const ray of result?.rays||[]){ctx.strokeStyle=ray.state==='blocked'?'#b23e36':ray.state==='visible'?'#2c8067':'#78808f';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(ox,oy);ctx.lineTo(...mapPoint(ray.hit||ray.end));ctx.stroke();}
 // Hollow marker beneath people: no opaque disc or fill can hide the target.
 if(target){const [tx,ty]=targetMarker(target);ctx.save();ctx.beginPath();for(let i=0;i<10;i++){const a=i*Math.PI/5,r=i%2===0?19:8,x=tx+Math.sin(a)*r,y=ty-Math.cos(a)*r;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.closePath();ctx.strokeStyle='#5e3707';ctx.lineWidth=4;ctx.stroke();ctx.strokeStyle='#ffbf35';ctx.lineWidth=2;ctx.stroke();ctx.restore();}
 for(const e of bodies){
  const [x,y]=mapPoint(e),selected=e.id===selectedId,a=e.bodyHeading,uncertain=['uncertain','unresolved'].includes(e.bodyDirection.status);
  if(!e.positionOnly){ctx.save();ctx.strokeStyle=e.color;ctx.lineWidth=4;ctx.setLineDash(uncertain?[4,4]:[]);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.cos(a)*34,y+Math.sin(a)*34);ctx.stroke();ctx.restore();}
  ctx.fillStyle=e.color;ctx.strokeStyle=selected?'#15203c':e.role==='referee'?'#b24512':'#566074';ctx.lineWidth=selected?5:2;ctx.beginPath();ctx.arc(x,y,e.role==='referee'?12:10,0,Math.PI*2);ctx.fill();ctx.stroke();
  ctx.font='bold 18px "KBL Jump",sans-serif';ctx.lineWidth=4;ctx.strokeStyle='#ffffffdd';ctx.strokeText(e.label,x+13,y-10);ctx.fillStyle='#17213a';ctx.fillText(e.label,x+13,y-10);
 }

 const selected=bodies.find(e=>e.id===selectedId);
 if(selected&&!selected.positionOnly){const [x,y]=mapPoint(selected),[hx,hy]=directionHandle(selected);ctx.strokeStyle='#18315b';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(hx,hy);ctx.stroke();ctx.fillStyle='#18315b';ctx.beginPath();ctx.arc(hx,hy,10,0,Math.PI*2);ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(hx-4,hy);ctx.lineTo(hx+4,hy);ctx.moveTo(hx,hy-4);ctx.lineTo(hx,hy+4);ctx.stroke();}
 ctx.font='19px "KBL Jump",sans-serif';ctx.fillStyle='#17213a';ctx.fillText(`홈 ${caseData.home} · 어웨이 ${caseData.away}`,70,690);
 ctx.font='17px "KBL Jump",sans-serif';ctx.fillStyle='#626b7b';ctx.fillText(coverage?`녹색 농도: 1 / 2 / 3명 가시 · ${coverage.complete?'회색: 세 명 모두 미가시 후보':'옅은 회색: 미확인 (심판·가림 인물 누락)'}`:'인물 표식을 끌어 위치 이동 · 남색 손잡이를 끌어 방향 수정 · ⌘Z 되돌리기',70,727);
 ctx.fillText(coverage?`대상 높이 ${target.z.toFixed(1)}m 평면 · 0.75m 격자 · 방향 ${config.hfov}° 가정 · 실제 시선 아님`:'28×15m 기준 코트 · 코너 직선 + 6.75m 원호 · 방향/시야는 검토용 추정',70,760);
}
export function drawCrewMap(canvas,model,state,caseData,analysis){
 const observers=crewObservers(model,state),cells=coverageGrid(model,observers);
 drawSceneMap(canvas,model,null,caseData,{observers,cells,complete:analysis.crewComplete&&analysis.sceneComplete&&!(analysis.qualityWarnings?.length)});
}
