import type {Summary,Dominance,Shot} from '../components/futsal/graphics';
import type {Side,ReportDraft} from './futsal-report';
import {futsalClub} from './futsal-clubs';

export type MatchReportData={matchId:string;loadedAt:string;summary:Summary;dominance:Dominance;started:boolean;ended:boolean;sourceKind?:'video'|'dashboard'|'none';events?:Array<Shot&{clock_ms?:number}>;videoStartSeconds?:number};
export type TeamReportOptions={side:Side;homeColor:string;awayColor:string;homeComment:string;awayComment:string;homePlayers?:string[];awayPlayers?:string[];homeColorCustom?:boolean;awayColorCustom?:boolean};
export const defaultTeamReport=():TeamReportOptions=>({side:'home',homeColor:'#FF7400',awayColor:'#2158E8',homeComment:'',awayComment:''});
export function teamReportView(data:MatchReportData,side:Side){
 const s=data.summary,p=s.possession,total=p.home_ms+p.away_ms,own=side==='home'?'home':'away',other=side==='home'?'away':'home';
 return {ownLanes:s.lanes[own],opponentLanes:s.lanes[other],ownMs:p[`${own}_ms`],opponentMs:p[`${other}_ms`],
  ownPct:total?p[`${own}_ms`]/total*100:null,opponentPct:total?p[`${other}_ms`]/total*100:null,
  bins:data.dominance.bins.map(b=>({...b,dominance:b.dominance*(side==='home'?1:-1),
   annotations:b.annotations?{goal_summary:side==='home'?b.annotations.goal_summary:{home:b.annotations.goal_summary?.away||0,away:b.annotations.goal_summary?.home||0}}:undefined}))};
}
// Upgrade legacy orange/blue defaults, but keep explicit user color choices.
export function reportTeamOptions(d:Pick<ReportDraft,'homeName'|'awayName'|'teamReport'>):TeamReportOptions {
 const base=defaultTeamReport(),o={...base,...d.teamReport};
 for(const side of ['home','away'] as const){const color=`${side}Color` as const;
  if(!o[`${side}ColorCustom`]&&(!d.teamReport||o[color].toUpperCase()===base[color]))o[color]=futsalClub(d[`${side}Name`])?.colors[0]||o[color];
 }
 return o;
}
export function matchComment(data:MatchReportData,side:Side){
 const v=teamReportView(data,side),l=v.ownLanes,counts=[l.left_count,l.center_count,l.right_count],lanes=['왼쪽 측면','중앙','오른쪽 측면'];
 const top=counts.indexOf(Math.max(...counts)),tied=counts.filter(n=>n===Math.max(...counts)).length>1;
 const first:string[]=[],second:string[]=[],last:string[]=[];
 if(v.ownPct!==null){
  first.push(Math.abs(v.ownPct-50)<5?'공을 소유한 시간은 양 팀이 비슷했어요. 한쪽이 오래 공을 지키기보다, 소유권이 바뀐 뒤 어떤 선택을 했는지가 경기를 읽는 포인트예요.':v.ownPct>50?'우리 팀이 공을 소유하며 플레이를 이어 간 시간이 더 길었어요. 공을 지킨 시간에 어느 공간까지 전진하고 마무리했는지를 함께 살펴볼 만해요.':'상대가 공을 가진 시간이 더 길었어요. 이런 경기에서는 공을 되찾은 직후의 첫 선택과, 공격으로 나설 동료의 위치가 특히 중요해져요.');
 }
 if(l.total_count){
  first.push(tied?'공격 방향은 여러 통로로 나뉘었어요. 한 공간에만 의존하지 않고 활용한 방향들을 함께 살펴볼 만해요.':`공격은 ${lanes[top]}에서 가장 자주 전개됐어요. ${top===1?'가운데로 향한 공격을 바탕으로 양옆 공간까지 활용할 여지가 보여요.':'익숙한 측면을 바탕으로 중앙과 반대쪽을 잇는 선택까지 살펴보면 좋아요.'}`);
 }
 const measured=v.bins.filter(b=>Number.isFinite(b.dominance)),positive=measured.filter(b=>b.dominance>.1),negative=measured.filter(b=>b.dominance<-.1);
 if(measured.length&&(positive.length||negative.length)){
  second.push(positive.length&&negative.length?'경기 흐름은 한 팀에만 머물지 않고 양쪽으로 오갔어요. 우리 쪽으로 기운 구간과 상대에게 넘어간 구간을 비교하면, 다음 경기에 가져갈 힌트가 더 선명해져요.':positive.length?'기록된 경기 흐름에서는 우리 팀 쪽으로 기운 구간이 보였어요. 그때의 공격 전개를 되짚어 보면, 계속 살려 갈 플레이를 찾는 데 도움이 돼요.':'기록된 경기 흐름에서는 상대 쪽으로 기운 구간이 보였어요. 수비에서 공격으로 바뀌는 순간에 어떤 공간을 활용할 수 있었는지 차분히 돌아보면 좋아요.');
  const early=measured.filter(b=>b.start_ms<300000),late=measured.filter(b=>b.start_ms>=600000);
  if(early.length>=2&&late.length>=2){const mean=(bs:typeof measured)=>bs.reduce((n,b)=>n+b.dominance*(b.end_ms-b.start_ms),0)/bs.reduce((n,b)=>n+b.end_ms-b.start_ms,0),delta=mean(late)-mean(early);
   second.push(delta>.15?'후반의 흐름 지표는 초반보다 우리 팀 쪽으로 올라왔어요. 경기 안에서 달라진 선택들을 긍정적으로 돌아볼 만해요.':delta<-.15?'후반의 흐름 지표는 초반보다 상대 쪽으로 옮겨 갔어요. 해당 시간대에 공을 되찾고 다시 연결하는 장면을 다음 준비의 출발점으로 삼아 봐요.':'초반과 후반의 평균 흐름은 크게 다르지 않았어요. 그 사이 흐름이 바뀐 장면에서 작은 차이를 찾아보면 좋아요.');}
 }
 const shots=data.events?.filter(e=>e.type==='XG')||[],ours=shots.filter(e=>e.team.toLowerCase()===side),theirs=shots.filter(e=>e.team.toLowerCase()!==side);
 if(shots.length)last.push(ours.length&&theirs.length?`슈팅은 우리 팀 ${ours.length}회, 상대 ${theirs.length}회가 기록됐어요. ${v.ownPct!==null&&v.ownPct>55&&ours.length<theirs.length?'공을 가진 시간은 더 길었지만 슈팅은 상대가 더 많았어요. 소유를 마무리 기회로 잇는 과정을 다음 과제로 살펴봐요.':v.ownPct!==null&&v.ownPct<45&&ours.length>theirs.length?'공을 가진 시간은 짧았지만 마무리 시도는 더 많이 남겼어요. 공을 잡았을 때 슈팅까지 이어 간 장면을 살려 갈 만해요.':'공을 가진 시간과 마무리 기회를 함께 보면 공격이 어디까지 이어졌는지 살펴볼 수 있어요.'}`:ours.length?'우리 팀이 슈팅으로 공격을 마친 장면들이 남아 있어요. 슈팅 전의 공간 선택을 함께 돌아보면 좋은 시도를 한 번 더 이어 갈 수 있어요.':'현재 슈팅 기록에는 상대의 시도만 남아 있어요. 상대가 마무리한 공간과 우리 팀의 활동 구역을 함께 보며 다음 수비 위치를 준비해 봐요.');
 if(first.length||second.length||last.length)last.push(l.total_count&&!tied?`다음 경기에는 ${lanes[top]}의 익숙한 전개를 살리면서, 공을 연결한 뒤 한 번 더 지원하는 움직임을 더해 보세요. 이번 경기에 남긴 선택들이 다음 플레이의 좋은 재료가 될 거예요.`:'다음 경기에는 공을 연결한 뒤 한 번 더 지원할 공간을 찾아보세요. 이번 경기를 함께 돌아보는 시간이 다음 플레이를 준비하는 좋은 재료가 될 거예요.');
 return [first.join(' '),second.join(' '),last.join(' ')].filter(Boolean).join('\n\n');
}
export function validateTeamReport(value:unknown):TeamReportOptions {
 const o=value as TeamReportOptions;
 if(!o||!['home','away'].includes(o.side)||![o.homeColor,o.awayColor].every(c=>typeof c==='string'&&/^#[a-f\d]{6}$/i.test(c))||![o.homeComment,o.awayComment].every(c=>typeof c==='string'&&c.length<=2400)||![o.homePlayers,o.awayPlayers].every(ids=>ids===undefined||(Array.isArray(ids)&&ids.length<=5&&new Set(ids).size===ids.length&&ids.every(id=>typeof id==='string'))))throw Error('팀 리포트 설정을 확인하세요.');
 return o;
}
export function validateMatchReportData(value:unknown):MatchReportData {
 const d=value as MatchReportData,nonnegative=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
 if(!d||typeof d.matchId!=='string'||typeof d.loadedAt!=='string'||typeof d.started!=='boolean'||typeof d.ended!=='boolean'||!d.summary?.possession||!d.summary.lanes||!Array.isArray(d.dominance?.bins)||d.dominance.bins.length>10000)throw Error('FLA 경기 기록을 확인하세요.');
 if(d.sourceKind&&!['video','dashboard','none'].includes(d.sourceKind))throw Error('FLA 기록 출처를 확인하세요.');
 if(d.videoStartSeconds!==undefined&&!nonnegative(d.videoStartSeconds))throw Error('영상 시작 시점을 확인하세요.');
 if(d.events&&(!Array.isArray(d.events)||d.events.length>200000||d.events.some(e=>typeof e.id!=='string'||!['HOME','AWAY'].includes(e.team)||e.type!=='XG'||[e.shot_x,e.shot_y,e.xg].some(n=>n!==null&&!Number.isFinite(n)))))throw Error('FLA 슈팅 기록을 확인하세요.');
 if(![d.summary.possession.home_ms,d.summary.possession.away_ms].every(nonnegative))throw Error('점유 시간을 확인하세요.');
 for(const side of ['home','away'] as const){const l=d.summary.lanes[side];if(!l||![l.left_count,l.center_count,l.right_count,l.total_count].every(n=>Number.isInteger(n)&&n>=0)||l.total_count!==l.left_count+l.center_count+l.right_count)throw Error('공격 방향 기록을 확인하세요.');}
 for(const b of d.dominance.bins)if(!nonnegative(b.start_ms)||!nonnegative(b.end_ms)||b.end_ms<=b.start_ms||!Number.isFinite(b.dominance)||Math.abs(b.dominance)>1||[b.chart_start_ms,b.chart_end_ms,b.display_end_ms].some(v=>v!==undefined&&!nonnegative(v)))throw Error('경기 흐름 기록을 확인하세요.');
 return d;
}
