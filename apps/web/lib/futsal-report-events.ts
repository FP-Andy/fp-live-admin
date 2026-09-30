import {parseFpa,isShot,isDefense,type FpaEvent} from '../components/futsal/fpaGraphics';
import {attackDirection,eventPoint,eventKind,commentDraft,blankPlayer,type ReportDraft,type PlayerText,type Side} from './futsal-report';
import type {Shot} from '../components/futsal/graphics';
export type ReportMarker={id:string;side:Side;kind:'shot'|'recovery'|'defense';x:number|null;y:number|null;personal:boolean;source:'fpa'|'fla';event:FpaEvent};
const number=(v:string)=>/^\d+$/.test(v.trim())?String(Number(v)):v.trim();
const name=(v:string)=>v.normalize('NFC').replace(/\s/g,'');
function sideOf(team:string,d:ReportDraft):Side|null {const t=team.trim().toLowerCase();if(['home','h',d.homeName.toLowerCase()].filter(Boolean).includes(t))return 'home';if(['away','a',d.awayName.toLowerCase()].filter(Boolean).includes(t))return 'away';return null;}
export function flaPlayerMatch(shot:Shot,p:PlayerText){
 if(shot.team.toLowerCase()!==p.side)return false;
 // CV's initial 1–6 labels are not shirt numbers. FLA needs its own explicit
 // binding, or a matching player name. Never attach team-only shots to a player.
 if(p.flaNumber?.trim()&&shot.player_number?.trim())return number(p.flaNumber)===number(shot.player_number);
 return !!p.name.trim()&&!!shot.player_name?.trim()&&name(p.name)===name(shot.player_name);
}
const seconds=(text:string)=>{const m=text.match(/^(\d+):(\d+(?:\.\d+)?)$/);return m?Number(m[1])*60+Number(m[2]):null;};
export function eventMapData(d:ReportDraft,person:PlayerText){
 const markers:ReportMarker[]=[],fpa=d.fpa?parseFpa(d.fpa):[];
 const identityPerson={...person,name:Object.values(d.players).filter(p=>p.side===person.side&&name(p.name)===name(person.name)).length===1?person.name:''};
 for(const e of fpa){const side=sideOf(e.team,d),kind=eventKind(e);if(!side||!kind||(!isShot(e)&&!isDefense(e)))continue;
  const pos=eventPoint(e,attackDirection(d,{...person,side}));
  markers.push({id:`fpa-${e.index}`,side,kind,x:pos?.x??null,y:pos?.y??null,personal:side===person.side&&!!person.eventNumber.trim()&&number(e.player)===number(person.eventNumber),source:'fpa',event:e});
 }
 for(const shot of d.fla?.matchId===d.matchId?d.fla.events||[]:[]){
  if(shot.type!=='XG')continue;const side=shot.team.toLowerCase() as Side,direction=attackDirection(d,{...person,side}),valid=shot.shot_x!==null&&shot.shot_y!==null&&Number.isFinite(shot.shot_x)&&Number.isFinite(shot.shot_y)&&shot.shot_x>=20&&shot.shot_x<=40&&shot.shot_y>=0&&shot.shot_y<=20;
  const x=valid?(direction==='right'?shot.shot_x!:40-shot.shot_x!):null,y=valid?(direction==='right'?20-shot.shot_y!:shot.shot_y!):null,t=shot.clock_ms===undefined?null:shot.clock_ms/1000;
  const duplicate=markers.find(m=>m.side===side&&m.kind==='shot'&&m.x!==null&&x!==null&&Math.hypot(m.x-x,m.y!-y!)<1.5&&t!==null&&seconds(m.event.time)!==null&&Math.abs(seconds(m.event.time)!-t)<=2);
  if(duplicate){duplicate.personal ||= flaPlayerMatch(shot,identityPerson);continue;}
  const e:FpaEvent={index:-1,team:side,player:shot.player_number||'',receiver:'',action:'Shot',tags:[],time:t===null?'':`${Math.floor(t/60)}:${(t%60).toFixed(2)}`,half:'',direction,points:valid?[{x:x!,y:20-y!}]:[],goal:shot.is_goal,outcome:'unknown'};
  markers.push({id:`fla-${shot.id}`,side,kind:'shot',x,y,personal:flaPlayerMatch(shot,identityPerson),source:'fla',event:e});
 }
 return {markers,personal:markers.filter(m=>m.personal).map(m=>m.event),missing:markers.filter(m=>m.x===null).length};
}
export function reportPlayer(d:ReportDraft,id=d.selected){
 const raw=d.players[id]||blankPlayer(),player=d.heatmap?.players.find(p=>p.id===id),map=eventMapData(d,raw),direction=attackDirection(d,raw);
 const generated=commentDraft(d.heatmap,player,raw,map.personal,direction,d.matchStartSeconds??d.fla?.videoStartSeconds??d.heatmap?.from??0);
 if(!map.personal.length&&d.fla?.matchId===d.matchId&&d.fla.started){const lanes=d.fla.summary.lanes[raw.side],counts=[lanes.left_count,lanes.center_count,lanes.right_count],top=counts.indexOf(Math.max(...counts));generated.eventComment=(lanes.total_count?`우리 팀은 ${['왼쪽 측면','중앙','오른쪽 측면'][top]}으로 공격한 장면이 많았어요. `:'')+'팀의 슈팅 위치와 내 활동 구역을 함께 살펴봐요. 다음에 찾아갈 공간을 생각해 볼 수 있어요.';}
 return {raw,player,map,direction,generated,person:{...raw,heatComment:raw.heatComment||generated.heatComment,eventComment:raw.eventComment||generated.eventComment,strengths:raw.strengths.map((v,i)=>v||generated.strengths[i]),improvements:raw.improvements.map((v,i)=>v||generated.improvements[i])}};
}
