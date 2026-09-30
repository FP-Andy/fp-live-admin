import type {ReportDraft,Side,HeatSource,HeatPlayer} from './futsal-report';
import {courtProjection} from '../public/fpa-cv/court-projection.mjs';

type Point=[number,number];
export type AutomaticPosition={position:''|'GK'|'DF'|'MF'|'FW';seconds:number;forward:number|null;teamForward:number|null;reason:string;initial?:Point;hotspot?:Point;basis?:'initial'|'hotspot'|'combined'};
export const POSITION_MIN_SECONDS=30,INITIAL_FORMATION_WEIGHT=.7;
const cache=new WeakMap<HeatSource,{assignment:ReportDraft['assignment'];direction:ReportDraft['homeDirection'];start:number;value:Record<string,AutomaticPosition>}>();
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const distance=(a:Point,b:Point)=>Math.hypot((a[0]-b[0])*40,(a[1]-b[1])*20);

// The observed density uses the same 0.5 m cells and Gaussian neighbourhood as
// the heatmap. Select a local mode, never a mean between separate activity zones.
// An initial position only breaks near-equal peaks; estimated heat is not input.
export function observedHotspot(player:HeatPlayer,start:number,to:number,initial?:Point){
 const width=80,height=40,grid=new Float64Array(width*height);let seconds=0;
 for(const o of player.positions){const duration=Math.max(0,Math.min(to,o.t+o.seconds)-Math.max(start,o.t));if(!duration)continue;
  seconds+=duration;grid[Math.min(height-1,Math.floor(o.y*height))*width+Math.min(width-1,Math.floor(o.x*width))]+=duration;
 }
 if(seconds<POSITION_MIN_SECONDS)return {seconds,point:undefined};
 const smooth=new Float64Array(grid.length);
 for(let index=0;index<grid.length;index++){if(!grid[index])continue;const x=index%width,y=Math.floor(index/width);
  for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<width&&yy>=0&&yy<height)smooth[yy*width+xx]+=grid[index]*Math.exp(-(dx*dx+dy*dy)/8);}
 }
 const peak=Math.max(...smooth),candidates:number[]=[];
 for(let i=0;i<smooth.length;i++)if(smooth[i]>=peak*.99)candidates.push(i);
 const pointAt=(i:number):Point=>[(i%width+.5)/width,(Math.floor(i/width)+.5)/height];
 const selected=initial?candidates.reduce((best,i)=>distance(pointAt(i),initial)<distance(pointAt(best),initial)?i:best,candidates[0]):candidates.reduce((best,i)=>smooth[i]>smooth[best]?i:best,candidates[0]);
 return {seconds,point:pointAt(selected)};
}
function initialCourtPositions(d:ReportDraft){
 const points=new Map<string,Point>();if(!d.assignment?.court)return points;
 try{const project=courtProjection(d.assignment.court,d.heatmap?.turn??0);
  for(const p of d.assignment.players){if(!['home','away'].includes(p.group))continue;const xy=project([(p.box[0]+p.box[2])/2,d.heatmap?.point==='center'?(p.box[1]+p.box[3])/2:p.box[3]]);
   if(xy&&xy.every(v=>Number.isFinite(v)&&v>=-.03&&v<=1.03))points.set(p.id,[clamp(xy[0]),clamp(xy[1])]);
  }
 }catch{/* Legacy/missing calibration uses observed activity only. */}
 return points;
}
// Scale coordinates within each team's formation, not fixed thirds of the
// court. Minimum extents prevent sub-metre jitter from creating false lines.
function formation(points:Map<string,Point>){
 if(points.size<3)return new Map<string,Point>();
 const values=[...points.values()],xs=values.map(p=>p[0]),ys=values.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
 const cx=(minX+maxX)/2,cy=(minY+maxY)/2,depth=Math.max(.15,maxX-minX),width=Math.max(.3,maxY-minY);
 return new Map([...points].map(([id,p])=>[id,[clamp(.5+(p[0]-cx)/depth),clamp(.5+(p[1]-cy)/width)]] as [string,Point]));
}
export function automaticPositions(d:ReportDraft):Record<string,AutomaticPosition>{
 const result:Record<string,AutomaticPosition>={},keepers=new Set(d.assignment?.players.filter(p=>p.group.endsWith('_gk')).map(p=>p.id));
 const source=d.heatmap,start=source?Math.max(source.from,d.matchStartSeconds??d.fla?.videoStartSeconds??source.from):0;
 if(source){const previous=cache.get(source);if(previous?.assignment===d.assignment&&previous?.direction===d.homeDirection&&previous?.start===start)return previous.value;}
 for(const id of keepers)result[id]={position:'GK',seconds:0,forward:null,teamForward:null,reason:'초기 설정 골키퍼'};
 if(!source)return result;
 const initial=initialCourtPositions(d),candidates=new Map<string,{side:Side;initial?:Point;hotspot?:Point}>();
 for(const p of source.players){if(keepers.has(p.id))continue;const first=initial.get(p.id),hotspot=observedHotspot(p,start,source.to,first);
  result[p.id]={position:'',seconds:hotspot.seconds,forward:null,teamForward:null,reason:hotspot.seconds<POSITION_MIN_SECONDS?'초기 코트 좌표 또는 관측 30초 이상 필요':'같은 팀 위치 정보 3명 이상 필요',initial:first,hotspot:hotspot.point};
  candidates.set(p.id,{side:p.group,initial:first,hotspot:hotspot.point});
 }
 // Initial field players can provide formation anchors even with no heatmap observations.
 for(const p of d.assignment?.players||[]){if(!['home','away'].includes(p.group)||candidates.has(p.id))continue;
  candidates.set(p.id,{side:p.group as Side,initial:initial.get(p.id)});result[p.id]={position:'',seconds:0,forward:null,teamForward:null,initial:initial.get(p.id),reason:'초기 코트 좌표 필요'};
 }
 for(const side of ['home','away'] as Side[]){
  const right=side==='home'?d.homeDirection==='right':d.homeDirection!=='right',oriented=(p:Point):Point=>right?p:[1-p[0],1-p[1]],first=new Map<string,Point>(),hot=new Map<string,Point>();
  const peers=[...candidates].filter(([,p])=>p.side===side);
  for(const [id,p] of peers){if(p.initial)first.set(id,oriented(p.initial));if(p.hotspot)hot.set(id,oriented(p.hotspot));}
  const opening=formation(first),activity=formation(hot);
  for(const [id,p] of peers){const a=opening.get(id),b=activity.get(id);if(!a&&!b)continue;
   const mix=(x:number,y:number)=>x*INITIAL_FORMATION_WEIGHT+y*(1-INITIAL_FORMATION_WEIGHT),xy:Point=a&&b?[mix(a[0],b[0]),mix(a[1],b[1])]:a||b!;
   // A wide player needs a clearer advanced position to be suggested as a
   // forward. This keeps side support distinguishable from a central pivot.
   const advanced=xy[0]-.18*Math.abs(2*xy[1]-1),role=xy[0]<=.34?'DF':advanced>=.66?'FW':'MF';
   const item=result[id],basis=a&&b?'combined':a?'initial':'hotspot',point=a&&b?[mix(oriented(p.initial!)[0],oriented(p.hotspot!)[0]),mix(oriented(p.initial!)[1],oriented(p.hotspot!)[1])]:oriented(a?p.initial!:p.hotspot!);
   item.position=role;item.forward=point[0];item.teamForward=null;item.basis=basis;
   item.reason=`${basis==='combined'?'초기 대형 70% · 밀집 위치 30%':basis==='initial'?'초기 대형 기준':'밀집 위치 기준'} · ${role==='DF'?'뒤선':role==='FW'?'앞선':Math.abs(xy[1]-.5)>.25?'측면 연결':'중간 연결'}`;
  }
 }
 cache.set(source,{assignment:d.assignment,direction:d.homeDirection,start,value:result});return result;
}
export function applyAutomaticPositions(d:ReportDraft):ReportDraft{
 const roles=automaticPositions(d);let changed=false;
 const players=Object.fromEntries(Object.entries(d.players).map(([id,p])=>{const position=roles[id]?.position||'';if(position===p.position)return [id,p];changed=true;return [id,{...p,position}];}));
 return changed?{...d,players}:d;
}
