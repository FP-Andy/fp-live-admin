import type {Summary,Dominance,Shot} from '../components/futsal/graphics';
import type {Side} from './futsal-report';

export type MatchReportData={matchId:string;loadedAt:string;summary:Summary;dominance:Dominance;started:boolean;ended:boolean;sourceKind?:'video'|'dashboard'|'none';events?:Array<Shot&{clock_ms?:number}>;videoStartSeconds?:number};
export type TeamReportOptions={side:Side;homeColor:string;awayColor:string;homeComment:string;awayComment:string;homePlayers?:string[];awayPlayers?:string[]};
export const defaultTeamReport=():TeamReportOptions=>({side:'home',homeColor:'#FF7400',awayColor:'#2158E8',homeComment:'',awayComment:''});
export function teamReportView(data:MatchReportData,side:Side){
 const s=data.summary,p=s.possession,total=p.home_ms+p.away_ms,own=side==='home'?'home':'away',other=side==='home'?'away':'home';
 return {ownLanes:s.lanes[own],opponentLanes:s.lanes[other],ownMs:p[`${own}_ms`],opponentMs:p[`${other}_ms`],
  ownPct:total?p[`${own}_ms`]/total*100:null,opponentPct:total?p[`${other}_ms`]/total*100:null,
  bins:data.dominance.bins.map(b=>({...b,dominance:b.dominance*(side==='home'?1:-1),
   annotations:b.annotations?{goal_summary:side==='home'?b.annotations.goal_summary:{home:b.annotations.goal_summary?.away||0,away:b.annotations.goal_summary?.home||0}}:undefined}))};
}
export function matchComment(data:MatchReportData,side:Side){
 const v=teamReportView(data,side),lines:string[]=[];
 if(v.ownPct!==null)lines.push(Math.abs(v.ownPct-50)<5?'양 팀이 공을 소유하는 시간이 비슷하게 나타났습니다.':v.ownPct>50?'아군이 공을 소유하며 경기를 이어 간 시간이 상대적으로 길었습니다.':'상대가 공을 소유한 시간이 상대적으로 길게 나타났습니다. 공을 되찾은 뒤의 연결 장면을 함께 살펴볼 수 있습니다.');
 const l=v.ownLanes,counts=[l.left_count,l.center_count,l.right_count];
 if(l.total_count){const max=Math.max(...counts),zones=counts.map((n,i)=>n===max?['왼쪽 측면','중앙','오른쪽 측면'][i]:'').filter(Boolean);lines.push(`기록된 공격은 ${zones.join('과 ')}에서 상대적으로 자주 전개됐습니다.`);}
 const measured=v.bins.filter(b=>Number.isFinite(b.dominance)),positive=measured.some(b=>b.dominance>.1),negative=measured.some(b=>b.dominance<-.1);
 if(measured.length&&(positive||negative))lines.push(positive&&negative?'시간대에 따라 흐름이 양 팀 사이에서 오갔습니다. 흐름이 바뀐 구간을 영상과 함께 돌아보면 다음 플레이를 준비하는 데 도움이 됩니다.':positive?'아군 쪽으로 흐름이 기운 구간이 보였습니다. 해당 장면에서 동료와의 연결과 공간 활용을 함께 돌아보세요.':'상대 쪽으로 흐름이 기운 구간이 보였습니다. 그 구간의 공수 전환 장면을 함께 돌아보세요.');
 return lines.join('\n\n');
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
