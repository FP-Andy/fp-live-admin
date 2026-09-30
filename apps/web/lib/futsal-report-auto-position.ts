import type {ReportDraft,Side} from './futsal-report';

export type AutomaticPosition={position:''|'GK'|'DF'|'MF'|'FW';seconds:number;forward:number|null;teamForward:number|null;reason:string};
// A role describes this match's average line, not a fixed formation or a shirt number.
// Use real observations only. The 2 m central band prevents tiny centroid changes
// from forcing a defender/forward, and every player has equal weight in the team line.
export const POSITION_MIN_SECONDS=30,POSITION_CENTRAL_BAND=.05;
export function automaticPositions(d:ReportDraft):Record<string,AutomaticPosition>{
 const result:Record<string,AutomaticPosition>={},keepers=new Set(d.assignment?.players.filter(p=>p.group.endsWith('_gk')).map(p=>p.id));
 for(const id of keepers)result[id]={position:'GK',seconds:0,forward:null,teamForward:null,reason:'초기 설정 골키퍼'};
 const source=d.heatmap;if(!source)return result;
 const start=Math.max(source.from,d.matchStartSeconds??d.fla?.videoStartSeconds??source.from);
 for(const p of source.players){
  if(keepers.has(p.id))continue;
  let seconds=0,x=0;const right=p.group==='home'?d.homeDirection==='right':d.homeDirection!=='right';
  for(const o of p.positions){const duration=Math.max(0,Math.min(source.to,o.t+o.seconds)-Math.max(start,o.t));seconds+=duration;x+=(right?o.x:1-o.x)*duration;}
  result[p.id]={position:'',seconds,forward:seconds?x/seconds:null,teamForward:null,reason:seconds<POSITION_MIN_SECONDS?'관측 30초 이상 필요':'같은 팀 관측 선수 3명 이상 필요'};
 }
 for(const side of ['home','away'] as Side[]){
  const peers=source.players.filter(p=>p.group===side&&!keepers.has(p.id)&&result[p.id]?.seconds>=POSITION_MIN_SECONDS);
  if(peers.length<3)continue;
  const center=peers.reduce((sum,p)=>sum+result[p.id].forward!,0)/peers.length;
  for(const p of peers){const item=result[p.id],delta=item.forward!-center;
   item.teamForward=center;item.position=delta < -POSITION_CENTRAL_BAND-1e-9?'DF':delta > POSITION_CENTRAL_BAND+1e-9?'FW':'MF';
   item.reason=item.position==='MF'?'팀 평균선 부근':`팀 평균선보다 ${Math.abs(delta*40).toFixed(1)}m ${delta<0?'뒤':'앞'}`;
  }
 }
 return result;
}
export function applyAutomaticPositions(d:ReportDraft):ReportDraft{
 const roles=automaticPositions(d);let changed=false;
 const players=Object.fromEntries(Object.entries(d.players).map(([id,p])=>{const position=roles[id]?.position||'';if(position===p.position)return [id,p];changed=true;return [id,{...p,position}];}));
 return changed?{...d,players}:d;
}
