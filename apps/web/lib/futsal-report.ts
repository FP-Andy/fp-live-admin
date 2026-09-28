import { parseFpa, isShot, type FpaEvent, type SavedFpa } from '../components/futsal/fpaGraphics';

export type Side='home'|'away';
export type Direction='right'|'left';
export type HeatPlayer={id:string;group:Side;jersey:string;name?:string;grid:number[];coverage:number;observed:number;positions:Array<{x:number;y:number;t:number;seconds:number}>};
export type HeatSource={schema:'fpa-heatmaps/v1';datasetId:string;video:string;resultVersion?:number;from:number;to:number;width:number;height:number;scale:number;players:HeatPlayer[]};
export type PlayerText={name:string;jersey:string;position:string;context:string;heatComment:string;eventComment:string;strengths:string[];improvements:string[];eventNumber:string;side:Side};
export type ReportDraft={schema:'fpc-futsal-report/v1';id:string;title:string;updatedAt:string;heatmap:HeatSource|null;fpa:SavedFpa|null;fpaLabel:string;matchId:string;matchName:string;homeName:string;awayName:string;homeScore:string;awayScore:string;homeDirection:Direction;selected:string;players:Record<string,PlayerText>};
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
 for(const field of ['title','updatedAt','fpaLabel','matchId','matchName','homeName','awayName','homeScore','awayScore','selected'] as const)if(typeof d[field]!=='string'||d[field].length>2000)throw Error('리포트 경기 정보를 확인하세요.');
 for(const p of Object.values(d.players)){
  if(!p||!['home','away'].includes(p.side)||!POSITIONS.includes(p.position)||!['name','jersey','context','heatComment','eventComment','eventNumber'].every(k=>typeof p[k as keyof PlayerText]==='string')||!Array.isArray(p.strengths)||!Array.isArray(p.improvements)||p.strengths.length!==3||p.improvements.length!==3||![...p.strengths,...p.improvements].every(v=>typeof v==='string'&&v.length<=2000))throw Error('리포트 선수 정보를 확인하세요.');
 }
 return d;
}
export function attachHeatmap(d:ReportDraft,h:HeatSource):ReportDraft {const base=d.heatmap&&d.heatmap.datasetId!==h.datasetId?{...emptyDraft(),id:d.id}:d;return {...base,heatmap:h,title:h.video,selected:h.players[0].id,players:Object.fromEntries(h.players.map(p=>[p.id,blankPlayer(p)]))};}
export const attackDirection=(d:ReportDraft,p:PlayerText):Direction=>p.side==='home'?d.homeDirection:d.homeDirection==='right'?'left':'right';
export const eventKind=(e:FpaEvent):'shot'|'recovery'|null=>isShot(e)?'shot':e.outcome!=='fail'&&(/^(Acquisition|Gain|Intercept)$/i.test(e.action)||(/^(Tackle|Cutout)$/i.test(e.action)&&e.outcome==='success'))?'recovery':null;
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
// Grounded starter text, editable by the operator. No performance ratings or LLM claims.
export function commentDraft(source:HeatSource|null,p:HeatPlayer|undefined,person:PlayerText,events:FpaEvent[],direction:Direction){
 const spatial=spatialSummary(source,p,direction),shots=events.filter(e=>eventKind(e)==='shot'),recoveries=events.filter(e=>eventKind(e)==='recovery');
 const texts:{heatComment:string;eventComment:string;strengths:string[];improvements:string[]}={heatComment:'',eventComment:'',strengths:['','',''],improvements:['','','']};
 if(spatial){const zone=spatial.longitudinal.indexOf(Math.max(...spatial.longitudinal)),side=spatial.lateral.indexOf(Math.max(...spatial.lateral));texts.heatComment=`관측된 장면에서는 ${['자기 진영에 가까운 구역','코트 중앙 구역','상대 진영에 가까운 구역'][zone]}을 중심으로 활동했습니다. ${['왼쪽 측면','중앙 통로','오른쪽 측면'][side]}에서의 움직임이 상대적으로 자주 나타났습니다.${spatial.coverage<.6?' 관측되지 않은 구간이 있어 경기 전체의 움직임과는 차이가 있을 수 있습니다.':''}`;
  if(spatial.coverage>=.6)texts.strengths[0]=`${['후방','중앙','전방'][zone]}을 중심으로 활동한 장면을 확인할 수 있습니다.`;
 }
 if(events.length){texts.eventComment=[recoveries.length?'상대의 공격 흐름에서 공을 되찾는 장면이 기록되었습니다.':'',shots.length?'슈팅으로 공격을 마무리하는 장면이 기록되었습니다.':'','표시된 위치의 영상을 함께 보면 플레이 전후의 선택을 더 자세히 살펴볼 수 있습니다.'].filter(Boolean).join(' ');if(recoveries.length)texts.strengths[1]='공을 되찾는 플레이가 기록되어 있습니다.';if(shots.length)texts.strengths[2]='공격을 슈팅으로 마무리한 장면이 있습니다.';}
 if(person.position){texts.improvements[0]=['DF','FIXO'].includes(person.position)?'전진한 뒤에는 동료와의 간격을 살피며 다음 수비 위치를 잡아 보세요.':['FW','PIVO'].includes(person.position)?'공을 받기 전에 주변을 살피고, 연결한 뒤에는 새로운 공간으로 이동해 보세요.':['GK','GOLEIRO'].includes(person.position)?'공의 위치가 바뀔 때 골문과 동료의 위치를 함께 확인해 보세요.':'공을 연결한 뒤 패스 선택지를 다시 만들어 주는 움직임을 시도해 보세요.';}
 return texts;
}
