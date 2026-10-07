import {appearanceSource} from './futsal-report-substitutions';
import {rolePlay} from './futsal-report-positions';
import {automaticPositions} from './futsal-report-auto-position';
import {sameClub} from './futsal-clubs';
import {parseFpa,isShot,isDefense,type FpaEvent} from '../components/futsal/fpaGraphics';
import {attackDirection,eventPoint,eventKind,commentDraft,spatialSummary,blankPlayer,type ReportDraft,type PlayerText,type Side} from './futsal-report';
import type {Shot} from '../components/futsal/graphics';
export type ReportMarker={id:string;side:Side;kind:'shot'|'recovery'|'defense';x:number|null;y:number|null;personal:boolean;source:'fpa'|'fla';event:FpaEvent};
const number=(v:string)=>/^\d+$/.test(v.trim())?String(Number(v)):v.trim();
const name=(v:string)=>v.normalize('NFC').replace(/\s/g,'');
function sideOf(team:string,d:ReportDraft):Side|null {const t=team.trim().toLowerCase();if(['home','h'].includes(t)||sameClub(team,d.homeName))return 'home';if(['away','a'].includes(t)||sameClub(team,d.awayName))return 'away';return null;}
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
 const inAppearance=(t:number|null)=>person.appearanceFrom===undefined||(t!==null&&t+(d.matchStartSeconds??d.fla?.videoStartSeconds??d.heatmap?.from??0)>=person.appearanceFrom&&t+(d.matchStartSeconds??d.fla?.videoStartSeconds??d.heatmap?.from??0)<person.appearanceTo!);
 const identityPerson={...person,name:Object.values(d.players).filter(p=>p.side===person.side&&name(p.name)===name(person.name)).length===1?person.name:''};
 for(const e of fpa){const side=sideOf(e.team,d),kind=eventKind(e);if(!side||!kind||(!isShot(e)&&!isDefense(e)))continue;
  const pos=eventPoint(e,attackDirection(d,{...person,side}));
  markers.push({id:`fpa-${e.index}`,side,kind,x:pos?.x??null,y:pos?.y??null,personal:inAppearance(seconds(e.time))&&side===person.side&&!!person.eventNumber.trim()&&number(e.player)===number(person.eventNumber),source:'fpa',event:e});
 }
 for(const shot of d.fla?.matchId===d.matchId?d.fla.events||[]:[]){
  if(shot.type!=='XG')continue;const side=shot.team.toLowerCase() as Side,direction=attackDirection(d,{...person,side}),valid=shot.shot_x!==null&&shot.shot_y!==null&&Number.isFinite(shot.shot_x)&&Number.isFinite(shot.shot_y)&&shot.shot_x>=20&&shot.shot_x<=40&&shot.shot_y>=0&&shot.shot_y<=20;
  const x=valid?(direction==='right'?shot.shot_x!:40-shot.shot_x!):null,y=valid?(direction==='right'?20-shot.shot_y!:shot.shot_y!):null,t=shot.clock_ms===undefined?null:shot.clock_ms/1000;
  const duplicate=markers.find(m=>m.source==='fpa'&&m.side===side&&m.kind==='shot'&&m.x!==null&&x!==null&&Math.hypot(m.x-x,m.y!-y!)<1.5&&t!==null&&seconds(m.event.time)!==null&&Math.abs(seconds(m.event.time)!-t)<=2);
  if(duplicate){duplicate.personal ||= inAppearance(t)&&flaPlayerMatch(shot,identityPerson);continue;}
  const e:FpaEvent={index:-1,team:side,player:shot.player_number||'',receiver:'',action:'Shot',tags:[],time:t===null?'':`${Math.floor(t/60)}:${(t%60).toFixed(2)}`,half:'',direction,points:valid?[{x:x!,y:20-y!}]:[],goal:shot.is_goal,outcome:'unknown'};
  markers.push({id:`fla-${shot.id}`,side,kind:'shot',x,y,personal:inAppearance(t)&&flaPlayerMatch(shot,identityPerson),source:'fla',event:e});
 }
 return {markers,personal:markers.filter(m=>m.personal).map(m=>m.event),missing:markers.filter(m=>m.x===null).length};
}
export function playStory(d:ReportDraft,id:string,map:ReturnType<typeof eventMapData>,personalStory:string){
 const person={...d.players[id],position:automaticPositions(d)[id]?.position||''},player=d.heatmap?.players.find(p=>p.id===id),direction=attackDirection(d,person),spatial=spatialSummary(d.heatmap,player,direction),hasPersonal=map.personal.length>0;
 const ours=map.markers.filter(m=>m.side===person.side&&m.kind==='shot'),theirs=map.markers.filter(m=>m.side!==person.side&&m.kind==='shot');
 const positioned=(ms:ReportMarker[])=>ms.filter(m=>m.x!==null&&m.y!==null);
 const zones=['우리 진영','중앙 지역','상대 진영'],lanes=['왼쪽 측면','중앙 통로','오른쪽 측면'];
 const zone=(m:ReportMarker)=>Math.min(2,Math.floor((direction==='right'?m.x!/40:1-m.x!/40)*3));
 const lane=(m:ReportMarker)=>Math.min(2,Math.floor((direction==='right'?m.y!/20:1-m.y!/20)*3));
 const dominant=(ms:ReportMarker[],pick:(m:ReportMarker)=>number)=>{const counts=[0,0,0];positioned(ms).forEach(m=>counts[pick(m)]++);const best=Math.max(...counts);return best>0&&counts.filter(n=>n===best).length===1?counts.indexOf(best):null;};
 const roleStory=rolePlay(person.position,map.personal.filter(e=>eventKind(e)==='shot').length,map.personal.filter(e=>eventKind(e)==='shot'&&e.goal).length,map.personal.filter(e=>eventKind(e)==='recovery').length,map.personal.filter(e=>eventKind(e)==='defense').length);
 const paragraphs:string[]=[];
 if(hasPersonal)paragraphs.push(personalStory);
 else if(ours.length||theirs.length){const l=d.fla?.matchId===d.matchId?d.fla.summary?.lanes[person.side]:null,counts=l?[l.left_count,l.center_count,l.right_count]:[],max=Math.max(...counts),top=counts.indexOf(max);
  const opening=l?.total_count&&counts.filter(n=>n===max).length===1?`우리 팀 공격은 ${lanes[top]}에서 가장 자주 전개됐어요. `:'';
  paragraphs.push(opening+(ours.length&&theirs.length?'양 팀의 슈팅 위치를 보면 각자 어떤 공간에서 공격을 마무리했는지 살펴볼 수 있어요.':ours.length?'우리 팀이 슈팅으로 마무리한 위치가 남아 있어요. 공을 가진 시간에 어떤 공간까지 나아갔는지 함께 살펴봐요.':'현재 샷맵에는 상대의 슈팅이 남아 있어요. 상대가 마무리한 위치는 우리 팀이 다음 수비를 준비할 때 돌아볼 만한 공간이에요.'));
 }else return personalStory+(roleStory?'\n\n'+roleStory:'');
 if(spatial){
  const personal=positioned(map.markers.filter(m=>m.personal)),ps=dominant(personal,zone),ownLane=dominant(ours,lane),otherZone=dominant(theirs,zone);
  const main=spatial.longitudinal.indexOf(Math.max(...spatial.longitudinal)),ranked=[...spatial.longitudinal].sort((a,b)=>b-a),hasMain=ranked[0]-ranked[1]>=.08;
  if(hasPersonal&&ps!==null){paragraphs.push(`개인 기록은 ${zones[ps]}에서 가장 많이 나왔어요. `+(spatial.longitudinal[ps]>=.4?'히트맵에서 자주 활동한 구역과 실제 플레이가 나온 위치가 겹쳐요. 그 공간을 찾은 움직임이 어떤 플레이로 이어졌는지 함께 돌아볼 수 있어요.':hasMain?`주로 활동한 ${zones[main]}과 이벤트가 나온 위치를 함께 보면, 플레이에 참여하기 위해 찾아간 공간의 차이가 보여요.`:'활동 구역 전체와 이벤트가 나온 위치를 비교하면, 어떤 공간에서 직접 플레이에 참여했는지 더 선명하게 읽을 수 있어요.'));}
  else if(ownLane!==null&&spatial.lateral[ownLane]>=.4)paragraphs.push(`히트맵의 주요 활동 통로는 우리 팀 슈팅이 많이 나온 ${lanes[ownLane]}과 겹쳐요. 이 위치에서 마무리 전 연결을 도왔는지, 슈팅 뒤 흘러나온 공을 준비했는지 영상을 통해 살펴볼 만해요.`);
  else if(otherZone!==null&&spatial.longitudinal[otherZone]>=.4)paragraphs.push(`주로 활동한 ${zones[otherZone]}에 상대 슈팅도 모였어요. 이 공간에서 골문 쪽을 지키거나 공을 되찾은 뒤 연결을 준비하는 역할을 함께 살펴볼 수 있어요.`);
  else paragraphs.push(`${hasMain?`주요 활동 구역인 ${zones[main]}`:'코트 곳곳에 남긴 활동 구역'}과 슈팅이 나온 공간을 함께 보면, 마무리 전후에 지원할 위치를 생각해 볼 수 있어요. 공이 없는 순간에도 다음 연결을 준비할 공간이 있다는 점을 눈여겨봐요.`);
 }else paragraphs.push('이벤트가 나온 위치를 영상 장면과 함께 돌아보면, 공을 받기 전과 플레이를 마친 뒤에 선택할 공간을 더 구체적으로 찾을 수 있어요.');
 paragraphs.push(roleStory|| (hasPersonal?'확인된 플레이를 바탕으로, 다음에는 공을 다룬 뒤 동료에게 한 번 더 연결될 자리를 찾아보세요. 좋은 시도를 이어 갈 준비가 될 거예요.':'팀 기록만으로 개인의 기여를 단정할 수는 없지만, 내 활동 위치에서 시작할 다음 움직임은 찾을 수 있어요. 동료와 연결될 자리를 한 번 더 준비해 봐요.'));
 return paragraphs[0]+'\n\n'+paragraphs.slice(1).join(' ');
}
export function reportPlayer(d:ReportDraft,id=d.selected){
 const matchStart=d.matchStartSeconds??d.fla?.videoStartSeconds??d.heatmap?.from??0,original=d.heatmap?.players.find(p=>p.id===id),source=appearanceSource(d.heatmap,original);d={...d,matchStartSeconds:matchStart,heatmap:source};
 const raw={...(d.players[id]||blankPlayer()),appearanceFrom:original?.activeFrom,appearanceTo:original?.activeTo,position:automaticPositions(d)[id]?.position||''},player=d.heatmap?.players.find(p=>p.id===id),map=eventMapData(d,raw),direction=attackDirection(d,raw);
 const generated=commentDraft(d.heatmap,player,raw,map.personal,direction,d.matchStartSeconds??d.fla?.videoStartSeconds??d.heatmap?.from??0);
 generated.eventComment=playStory(d,id,map,generated.eventComment);
 if(original?.activeFrom!==undefined&&original.activeTo!-original.activeFrom<30){
  raw.position='';const duration=Math.round(original.activeTo!-original.activeFrom);
  generated.heatComment=`교체 투입 뒤 약 ${duration}초의 출전 구간이 남아 있어요. 히트맵은 이 구간에서 확인된 움직임만 담았어요. 투입 전 시간이나 앞선 선수의 활동은 합치지 않았어요.\n\n짧은 기록이므로 경기 전체의 포지션이나 활동 성향을 평가하기보다, 투입 직후 어떤 위치를 찾았는지 함께 돌아봐 주세요.`;
  generated.eventComment='이벤트맵은 양 팀의 경기 전체 흐름을 보여줘요. 해당 선수의 출전 시간 밖에서 나온 플레이는 개인 기록으로 연결하지 않았어요. 짧게 남은 출전 장면과 팀의 흐름을 구분해서 살펴봐 주세요.';
  generated.strengths=['투입 직후 코트 안에서 찾은 위치를 확인할 수 있어요.','짧게 남은 움직임도 다음 플레이를 돌아볼 출발점이 될 수 있어요.','개인 평가는 더 긴 출전 장면과 함께 살펴보면 좋아요.'];
  generated.improvements=['입장 직후 동료와 어떤 간격을 만들었는지 돌아보세요.','공이 움직이는 방향에 맞춰 다음에 설 자리를 확인해 보세요.','다음 경기의 충분한 출전 기록과 함께 특징을 이어서 살펴봐요.'];
 }
 return {raw,player,source,map,direction,generated,person:{...raw,heatComment:raw.heatComment||generated.heatComment,eventComment:raw.eventComment||generated.eventComment,strengths:raw.strengths.map((v,i)=>v||generated.strengths[i]),improvements:raw.improvements.map((v,i)=>v||generated.improvements[i])}};
}
