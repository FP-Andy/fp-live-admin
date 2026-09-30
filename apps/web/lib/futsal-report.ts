import { parseFpa, isShot, isDefense, type FpaEvent, type SavedFpa } from '../components/futsal/fpaGraphics';
import { validateHeatmapAugmentation, type ActivityPolicy, type ActivityDensity } from '../public/fpa-cv/heatmap-augmentation-schema.mjs';
import type { AnalysisSnapshot } from '../public/fpa-cv/analysis-snapshots.mjs';
import type { MatchReportData, TeamReportOptions } from './futsal-team-report';
import {validateTeamReport,validateMatchReportData} from './futsal-team-report';

export type Side='home'|'away';
export type Direction='right'|'left';
export type HeatPlayer={id:string;group:Side;jersey:string;name?:string;grid:number[];coverage:number;observed:number;positions:Array<{x:number;y:number;t:number;seconds:number}>;augmentation?:ActivityDensity};
export type HeatSource={schema:'fpa-heatmaps/v1';datasetId:string;video:string;resultVersion?:number;from:number;to:number;width:number;height:number;scale:number;players:HeatPlayer[];augmentation?:ActivityPolicy};
export type PlayerText={name:string;jersey:string;position:string;context:string;heatComment:string;eventComment:string;strengths:string[];improvements:string[];eventNumber:string;flaNumber?:string;side:Side};
export type ReportDraft={schema:'fpc-futsal-report/v1';id:string;title:string;updatedAt:string;heatmap:HeatSource|null;fpa:SavedFpa|null;fpaLabel:string;matchId:string;matchName:string;homeName:string;awayName:string;homeScore:string;awayScore:string;homeDirection:Direction;selected:string;players:Record<string,PlayerText>;sourceSnapshot?:{id:string;version:number;createdAt:string;jobId:string};teamReport?:TeamReportOptions;fla?:MatchReportData;matchStartSeconds?:number};
export const POSITIONS=['','DF','MF','FW','GK','FIXO','ALA','PIVO','GOLEIRO'];
export const POSITION_LABEL:Record<string,string>={'':'미지정',DF:'DF',MF:'MF',FW:'FW',GK:'GK',FIXO:'FIXO · 픽소',ALA:'ALA · 알라',PIVO:'PIVO · 피보',GOLEIRO:'GOLEIRO · 골레이로'};
export const blankPlayer=(p?:HeatPlayer):PlayerText=>({name:p?.name||'',jersey:p?.jersey||'',position:'',context:'',heatComment:'',eventComment:'',strengths:['','',''],improvements:['','',''],eventNumber:p?.jersey||'',side:p?.group||'home'});
export const emptyDraft=():ReportDraft=>({schema:'fpc-futsal-report/v1',id:crypto.randomUUID(),title:'새 매치 리포트',updatedAt:new Date().toISOString(),heatmap:null,fpa:null,fpaLabel:'',matchId:'',matchName:'',homeName:'',awayName:'',homeScore:'',awayScore:'',homeDirection:'right',selected:'manual',players:{manual:blankPlayer()}});
export function validateHeatmap(raw:unknown):HeatSource {
 const h=raw as HeatSource;
 if(!h||h.schema!=='fpa-heatmaps/v1'||typeof h.datasetId!=='string'||typeof h.video!=='string'||!Number.isFinite(h.from)||!Number.isFinite(h.to)||!(h.to>h.from)||!Number.isInteger(h.width)||!Number.isInteger(h.height)||h.width<1||h.height<1||h.width*h.height>20000||!Number.isFinite(h.scale)||h.scale<=0||!Array.isArray(h.players)||!h.players.length||h.players.length>100)throw Error('FPA의 좌표·품질 JSON 파일을 선택하세요.');
 const ids=new Set();
 for(const p of h.players){
  if(!p||typeof p.id!=='string'||ids.has(p.id)||!['home','away'].includes(p.group)||!['string','number'].includes(typeof p.jersey)||!Array.isArray(p.grid)||p.grid.length!==h.width*h.height||!p.grid.every(n=>Number.isFinite(n)&&n>=0)||!Array.isArray(p.positions))throw Error('히트맵 선수 정보가 올바르지 않습니다.');
  ids.add(p.id);let end=h.from;
  for(const o of p.positions){if(!o||![o.x,o.y,o.t,o.seconds].every(Number.isFinite)||o.x<0||o.x>1||o.y<0||o.y>1||o.seconds<=0||o.t<end-.002||o.t+o.seconds>h.to+.002)throw Error('히트맵 관측 좌표가 올바르지 않습니다.');end=o.t+o.seconds;}
 }
 validateHeatmapAugmentation(h);
 return h;
}
export function parseFpaSource(raw:unknown):SavedFpa {
 const data=raw as {schema?:string;rows?:unknown;logs?:unknown;events?:Array<{row:unknown;log:unknown}>};
 const source=data?.schema==='fpa-review/v1'?{rows:data.events?.map(e=>e.row),logs:data.events?.map(e=>e.log)}:data;
 if(!source||!Array.isArray(source.rows)||source.rows.length>200000)throw Error('FPA 로그 JSON 또는 검수 JSON을 선택하세요.');
 const rows=source.rows.map((r:unknown)=>{if(!r||typeof r!=='object'||Array.isArray(r))throw Error('FPA 데이터 행을 확인하세요.');return Object.fromEntries(Object.entries(r).map(([k,v])=>{if(v!=null&&typeof v!=='string'&&typeof v!=='number')throw Error('FPA 값이 올바르지 않습니다.');return [k,String(v??'')];}));});
 return {rows,logs:Array.isArray(source.logs)?source.logs.map(v=>String(v??'')):[]};
}
export function restoreDraft(raw:unknown):ReportDraft {
 const d=raw as ReportDraft;
 if(!d||d.schema!=='fpc-futsal-report/v1'||typeof d.id!=='string'||!d.players||typeof d.players!=='object'||Array.isArray(d.players)||!d.players[d.selected]||!['right','left'].includes(d.homeDirection))throw Error('지원하지 않는 리포트 파일입니다.');
 if(d.heatmap)validateHeatmap(d.heatmap);
 if(d.fpa)d.fpa=parseFpaSource(d.fpa);
 if(d.matchStartSeconds!==undefined&&(!Number.isFinite(d.matchStartSeconds)||d.matchStartSeconds<0))throw Error('경기 시작 시점을 확인하세요.');
 if(d.teamReport)validateTeamReport(d.teamReport);
 if(d.fla){validateMatchReportData(d.fla);if(d.fla.matchId!==d.matchId)throw Error('FLA와 리포트의 경기가 다릅니다.');}
 if(d.sourceSnapshot&&(!/^[a-f0-9]{32}$/.test(d.sourceSnapshot.id)||!Number.isInteger(d.sourceSnapshot.version)||d.sourceSnapshot.version<1||typeof d.sourceSnapshot.createdAt!=='string'||typeof d.sourceSnapshot.jobId!=='string'))throw Error('분석 스냅샷 참조를 확인하세요.');
 for(const field of ['title','updatedAt','fpaLabel','matchId','matchName','homeName','awayName','homeScore','awayScore','selected'] as const)if(typeof d[field]!=='string'||d[field].length>2000)throw Error('리포트 경기 정보를 확인하세요.');
 for(const p of Object.values(d.players)){
  if(p.flaNumber!==undefined&&(typeof p.flaNumber!=='string'||p.flaNumber.length>12))throw Error('FLA 등번호를 확인하세요.');
  if(!p||!['home','away'].includes(p.side)||!POSITIONS.includes(p.position)||!['name','jersey','context','heatComment','eventComment','eventNumber'].every(k=>typeof p[k as keyof PlayerText]==='string')||!Array.isArray(p.strengths)||!Array.isArray(p.improvements)||p.strengths.length!==3||p.improvements.length!==3||![...p.strengths,...p.improvements].every(v=>typeof v==='string'&&v.length<=2000))throw Error('리포트 선수 정보를 확인하세요.');
 }
 return d;
}
export function attachHeatmap(d:ReportDraft,h:HeatSource):ReportDraft {const base=d.heatmap&&d.heatmap.datasetId!==h.datasetId?{...emptyDraft(),id:d.id}:d;return {...base,heatmap:h,title:h.video,selected:h.players[0].id,players:Object.fromEntries(h.players.map(p=>[p.id,blankPlayer(p)]))};}
export const attackDirection=(d:ReportDraft,p:PlayerText):Direction=>p.side==='home'?d.homeDirection:d.homeDirection==='right'?'left':'right';
export const eventKind=(e:FpaEvent):'shot'|'recovery'|'defense'|null=>isShot(e)?'shot':e.outcome!=='fail'&&(/^(Acquisition|Gain|Intercept)$/i.test(e.action)||(/^(Tackle|Cutout)$/i.test(e.action)&&e.outcome==='success'))?'recovery':e.outcome!=='fail'&&isDefense(e)&&e.action!=='Foul'?'defense':null;
export function reportEvents(fpa:SavedFpa|null,p:PlayerText,homeName='',awayName=''):FpaEvent[]{
 if(!fpa||!p.eventNumber.trim())return [];
 const aliases=new Set([p.side,p.side==='home'?'h':'a',(p.side==='home'?homeName:awayName).trim().toLowerCase()].filter(Boolean));
 return parseFpa(fpa).filter(e=>aliases.has(e.team.trim().toLowerCase())&&e.player.trim()===p.eventNumber.trim()&&eventKind(e));
}
export function eventPoint(e:FpaEvent,direction:Direction){const p=e.points[0];if(!p)return null;const flip=['left','right'].includes(e.direction.toLowerCase())&&e.direction.toLowerCase()!==direction;return {x:flip?40-p.x:p.x,y:flip?p.y:20-p.y};}
export function spatialSummary(source:HeatSource|null,p:HeatPlayer|undefined,direction:Direction){
 if(!source||!p?.positions.length)return null;
 const longitudinal=[0,0,0],lateral=[0,0,0];let seconds=0;
 for(const o of p.positions){const f=direction==='right'?o.x:1-o.x,l=direction==='right'?o.y:1-o.y;seconds+=o.seconds;longitudinal[Math.min(2,Math.floor(f*3))]+=o.seconds;lateral[Math.min(2,Math.floor(l*3))]+=o.seconds;}
 return {coverage:Math.min(1,seconds/(source.to-source.from)),longitudinal:longitudinal.map(n=>n/seconds),lateral:lateral.map(n=>n/seconds)};
}
export function heatmapDisplayCoverage(source:HeatSource,p:HeatPlayer){
 const observed=p.positions.reduce((s,o)=>s+o.seconds,0),density=source.augmentation?.enabled?p.augmentation?.inferredSeconds||0:0;
 return Math.min(1,(observed+density)/(source.to-source.from));
}
export function updateSnapshotSource(d:ReportDraft,s:AnalysisSnapshot):ReportDraft {
 if(d.sourceSnapshot?.jobId!==s.jobId||s.version<=d.sourceSnapshot.version)return d;
 const h=validateHeatmap(s.heatmap);
 return {...d,heatmap:h,fpa:parseFpaSource(s.fpa),fpaLabel:`분석 완료 스냅샷 v${s.version}`,
  matchId:d.matchId||s.matchId||'',matchName:d.matchName||s.matchName,homeName:d.homeName||s.homeName,awayName:d.awayName||s.awayName,
  selected:h.players.some(p=>p.id===d.selected)?d.selected:h.players[0].id,
  players:Object.fromEntries(h.players.map(p=>[p.id,d.players[p.id]||blankPlayer(p)])),
  sourceSnapshot:{id:s.id,jobId:s.jobId,version:s.version,createdAt:s.createdAt}};
}
// Stories use actual observations. Estimated density is never used to infer
// chronology, individual events, successful play, or physical performance.
export function phaseSummary(source:HeatSource|null,p:HeatPlayer|undefined,direction:Direction,startSeconds=source?.from??0){
 if(!source||!p)return [];
 return [0,1,2].map(i=>{
  const from=startSeconds+i*300,to=i===2?source.to:Math.min(source.to,from+300);
  let seconds=0,forward=0,lateral=0;const longitudinal=[0,0,0],sides=[0,0,0];
  for(const o of p.positions){const overlap=Math.max(0,Math.min(to,o.t+o.seconds)-Math.max(from,o.t));if(!overlap)continue;
   const f=direction==='right'?o.x:1-o.x,l=direction==='right'?o.y:1-o.y;seconds+=overlap;forward+=f*overlap;lateral+=l*overlap;longitudinal[Math.min(2,Math.floor(f*3))]+=overlap;sides[Math.min(2,Math.floor(l*3))]+=overlap;
  }
  const duration=Math.max(0,to-from),coverage=duration?seconds/duration:0;
  return {label:['초반','중반','후반'][i],range:['0–5분','5–10분','10분 이후'][i],from,to,seconds,coverage,reliable:seconds>=30&&coverage>=.2,forward:seconds?forward/seconds:0,lateral:seconds?lateral/seconds:0,zone:longitudinal.indexOf(Math.max(...longitudinal)),side:sides.indexOf(Math.max(...sides))};
 });
}
export function commentDraft(source:HeatSource|null,p:HeatPlayer|undefined,person:PlayerText,events:FpaEvent[],direction:Direction,startSeconds=source?.from??0){
 const spatial=spatialSummary(source,p,direction),shots=events.filter(e=>eventKind(e)==='shot'),recoveries=events.filter(e=>eventKind(e)==='recovery'),defense=events.filter(e=>eventKind(e)==='defense');
 const texts={heatComment:'',eventComment:'',strengths:['','',''],improvements:['','','']};
 const phases=phaseSummary(source,p,direction,startSeconds),usable=phases.filter(v=>v.reliable),zoneNames=['우리 진영 가까운 공간','코트 가운데','상대 진영 가까운 공간'],sideNames=['왼쪽 측면','중앙 통로','오른쪽 측면'];
 if(spatial){
  const zone=spatial.longitudinal.indexOf(Math.max(...spatial.longitudinal)),side=spatial.lateral.indexOf(Math.max(...spatial.lateral));
  const zoneValues=[...spatial.longitudinal].sort((a,b)=>b-a),sideValues=[...spatial.lateral].sort((a,b)=>b-a),mainZone=zoneValues[0]-zoneValues[1]>=.08?zoneNames[zone]:'코트의 여러 공간',mainSide=sideValues[0]-sideValues[1]>=.08?sideNames[side]:'여러 통로';
  texts.heatComment=`${mainZone}에서 발자취를 남겼어요. ${mainSide}에서 움직인 모습도 눈에 띄어요. 코트에 남긴 나만의 활동 구역, 함께 살펴볼까요?`;
  if(usable.length>=2){const first=usable[0],last=usable.at(-1)!,delta=last.forward-first.forward;
   texts.heatComment+=Math.abs(delta)>=.1?` ${first.label}보다 ${last.label}에는 ${delta>0?'상대 골문 쪽':'우리 진영 쪽'}에서 더 자주 모습을 보였어요.`:first.side!==last.side?` ${first.label}의 ${sideNames[first.side]}에서 ${last.label}에는 ${sideNames[last.side]}으로 자주 찾는 공간이 달라졌어요.`:` ${first.label}과 ${last.label}에는 비슷한 공간을 중심으로 움직였어요.`;
   texts.strengths[0]=Math.abs(delta)>=.1?'시간에 따라 활동하는 공간이 달라졌어요. 움직임의 변화를 돌아볼 만해요.':`${mainZone}에서 이어 간 움직임이 나만의 발자취로 남았어요.`;
  }else if(spatial.coverage>=.2)texts.strengths[0]=`${mainSide}에서의 움직임이 눈에 띄어요. 자주 찾은 공간을 다음 경기에도 활용해 보세요.`;
  else texts.heatComment+=' 아직 관측되지 않은 구간이 많아, 확인된 장면을 중심으로 읽어 주세요.';
  if(spatial.coverage>=.2){texts.strengths[1]=`${mainSide}에서 남긴 발자취가 있어요. 익숙한 공간의 플레이를 돌아봐요.`;texts.improvements[1]=`${sideNames[side]}에서 움직인 뒤에는 반대편 동료도 살펴보세요. 다음 선택이 넓어질 거예요.`;}
  if(usable.length>=2){texts.strengths[2]=`${usable[0].label}과 ${usable.at(-1)!.label}의 발자취가 남았어요. 시간에 따른 움직임을 돌아볼 수 있어요.`;texts.improvements[2]='시간대별로 자주 찾은 공간을 비교해 보세요. 다음 경기에서 해 볼 움직임을 골라 봐요.';}
  if(usable.length===1)texts.heatComment+=` ${usable[0].label}의 움직임이 가장 잘 남아 있어요. 다른 시간대는 장면을 조금 더 확인해 볼게요.`;
  texts.improvements[0]=zone===2?'전방에서 움직인 뒤 동료와의 간격을 살펴보세요. 다음 움직임도 준비해 봐요.':zone===0?'우리 진영에서 공을 연결한 다음, 한 걸음 앞으로 지원하는 움직임도 시도해 볼까요?':'가운데서 공을 연결한 뒤 옆 공간으로 한 번 더 움직여 보세요. 새로운 연결을 만들어 볼 수 있어요.';
 }
 if(events.length){
  texts.eventComment=[recoveries.length?'공을 되찾은 장면이 남아 있어요. 다시 우리 공격을 시작할 수 있는 반가운 순간이에요.':'',shots.length?'슈팅으로 공격을 마무리해 봤어요. 골문을 향해 도전한 장면, 한 번 더 돌아보면 좋겠어요.':'',defense.length?'수비에 참여한 장면도 확인돼요. 공을 향해 움직인 순간을 함께 살펴봐요.':''].filter(Boolean).join(' ');
  if(recoveries.length)texts.strengths[1]='공을 되찾는 플레이가 있었어요. 우리 팀이 다시 시작할 수 있는 순간을 만들었네요.';
  else if(defense.length)texts.strengths[1]='수비에 참여한 장면이 남았어요. 공을 향해 움직인 발걸음에 응원을 보내요.';
  if(shots.length)texts.strengths[2]='공격을 슈팅까지 이어 갔어요. 골문을 향한 도전을 계속 응원해요.';
  if(recoveries.length||defense.length)texts.improvements[1]='공을 되찾거나 수비한 뒤 가까운 동료를 찾아보세요. 다음 연결도 준비해 봐요.';
  if(shots.length)texts.improvements[2]='슈팅 전 주변을 살펴보세요. 직접 마무리할 때와 연결할 때를 비교해 볼까요?';
 }
 if(!events.length)texts.eventComment='아직 이 선수에게 연결된 이벤트가 없어요. 팀 샷맵으로 경기 흐름을 살펴보고, 내 플레이를 연결하면 이야기를 더 풍성하게 채울 수 있어요.';
 if(person.position&&spatial)texts.improvements[0]=['DF','FIXO'].includes(person.position)?'전진 뒤에는 동료와의 간격을 살펴보세요. 다음 수비도 차분히 준비해 봐요.':['FW','PIVO'].includes(person.position)?'공을 받기 전 주변을 보고, 연결한 뒤에는 새 공간을 찾아보세요. 다음 기회를 함께 만들어 볼까요?':['GK','GOLEIRO'].includes(person.position)?'공이 움직일 때 골문과 동료의 위치를 함께 살펴보세요. 다음 플레이를 차분하게 준비해 봐요.':texts.improvements[0];
 return texts;
}
