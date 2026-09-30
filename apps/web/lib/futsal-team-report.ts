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
type ReportScore=Pick<ReportDraft,'homeScore'|'awayScore'>;
export function matchResult(data:MatchReportData,side:Side,score?:ReportScore){
 if(!score||![score.homeScore,score.awayScore].every(n=>/^\d{1,2}$/.test(n)))return null;
 const own=Number(side==='home'?score.homeScore:score.awayScore),other=Number(side==='home'?score.awayScore:score.homeScore);
 return {own,other,final:data.ended,outcome:own>other?'win':own<other?'loss':'draw'} as const;
}
export function matchComment(data:MatchReportData,side:Side,score?:ReportScore){
 const v=teamReportView(data,side),result=matchResult(data,side,score),l=v.ownLanes,counts=[l.left_count,l.center_count,l.right_count],lanes=['왼쪽 측면','중앙','오른쪽 측면'];
 const top=counts.indexOf(Math.max(...counts)),tied=counts.filter(n=>n===Math.max(...counts)).length>1;
 const measured=v.bins.filter(b=>Number.isFinite(b.dominance)&&b.end_ms>b.start_ms),duration=measured.reduce((n,b)=>n+b.end_ms-b.start_ms,0);
 const mean=(bs:typeof measured)=>bs.reduce((n,b)=>n+b.dominance*(b.end_ms-b.start_ms),0)/bs.reduce((n,b)=>n+b.end_ms-b.start_ms,0);
 const flow=duration?mean(measured):0,flowReady=measured.length>=3&&duration>=180000;
 const shots=data.events?.filter(e=>e.type==='XG')||[],ours=shots.filter(e=>e.team.toLowerCase()===side),theirs=shots.filter(e=>e.team.toLowerCase()!==side);
 // Partial/one-team shot logs are not evidence of the opponent taking no shots.
 const shotReady=ours.length>0&&theirs.length>0&&shots.length>=6;
 const signals:number[]=[];
 if(v.ownPct!==null&&v.ownMs+v.opponentMs>=60000)signals.push(v.ownPct>=55?1:v.ownPct<=45?-1:0);
 if(flowReady)signals.push(flow>=.15?1:flow<=-.15?-1:0);
 if(shotReady)signals.push(ours.length>=theirs.length*1.25&&ours.length-theirs.length>=2?1:theirs.length>=ours.length*1.25&&theirs.length-ours.length>=2?-1:0);
 const positive=signals.filter(n=>n>0).length,negative=signals.filter(n=>n<0).length;
 const balance=positive>=2&&!negative?'ours':negative>=2&&!positive?'theirs':positive&&negative?'mixed':signals.length>=2&&!positive&&!negative?'even':'partial';
 const first:string[]=[],second:string[]=[],last:string[]=[];
 if(result){
  const scores=`${result.own}:${result.other}`;
  if(!result.final)first.push(`현재 스코어는 ${scores}로 ${result.outcome==='win'?'앞서 있어요':result.outcome==='loss'?'뒤져 있어요':'동점이에요'}. 아직 기록 중인 경기이므로, 지금까지의 흐름을 기준으로 평가했어요.`);
  else{
   first.push(`${scores}${result.outcome==='win'?' 승리로 경기를 마쳤어요':result.outcome==='loss'?'로 경기를 마쳤고, 결과는 패배였어요':' 무승부로 경기를 마쳤어요'}.`);
   const assessment={
    win:{ours:'승리라는 결과와 우리 쪽에 유리하게 남은 경기 지표가 함께 뒷받침된 경기예요. 이번 경기에서 만들어 낸 우위를 다음 경기에도 이어 갈 기반으로 평가할 수 있어요.',theirs:'상대 쪽에 유리한 지표가 더 많았는데도 승리를 가져왔어요. 결과를 만들어 낸 점은 분명한 성과이고, 다음 경기에는 부담이 컸던 과정까지 다듬어 볼 만해요.',mixed:'승리를 챙긴 결과는 분명한 성과예요. 다만 지표마다 우세한 팀이 달라, 모든 과정에서 앞섰다기보다 강점과 보완할 점이 함께 남은 경기로 평가돼요.',even:'주요 지표가 비슷하게 나온 경기에서 스코어로 차이를 만든 점이 긍정적이에요. 결과를 가져온 장면과 균형이 이어진 과정을 나눠 보면 다음 준비가 더 구체적이 될 거예요.',partial:'승리를 남긴 결과는 충분히 긍정적으로 평가할 만해요. 경기 내용은 확인된 지표를 하나씩 짚어 보며, 다음에도 이어 갈 강점과 더 편하게 풀어 갈 부분을 구분해 봐요.'},
    draw:{ours:'우리 쪽에 유리한 지표가 더 많았지만 결과는 무승부였어요. 우위를 만든 과정은 살릴 강점이고, 그 우위를 득점 차로 연결하는 단계가 다음 성장 과제예요.',theirs:'상대 쪽에 유리한 지표가 더 많은 경기에서 스코어의 균형을 맞췄어요. 결과에서 균형을 남긴 점을 긍정적으로 보면서, 주도권을 가져올 과정을 보완해 볼 만해요.',mixed:'결과는 같았지만 양 팀의 강점이 같았던 경기는 아니에요. 서로 다른 지표에서 앞선 만큼, 우리 강점을 더 자주 꺼내고 상대가 앞선 부분을 줄이는 준비가 필요해요.',even:'스코어와 주요 경기 지표 모두 균형에 가까웠어요. 큰 틀의 변화를 서두르기보다, 마지막 연결과 슈팅 전 선택에서 작은 차이를 만드는 것을 다음 목표로 삼아볼 만해요.',partial:'무승부라는 결과를 남겼어요. 승부를 가를 차이는 아직 스코어에 나타나지 않았지만, 기록에서 드러난 강점을 다음 경기의 출발점으로 삼을 수 있어요.'},
    loss:{ours:'승리로 이어지지는 않았지만 우리 쪽에 유리하게 남은 지표가 있어요. 그 과정을 모두 바꿀 필요는 없고, 좋은 흐름을 득점 차로 연결하지 못한 지점을 우선 돌아볼 경기예요.',theirs:'스코어와 주요 지표 모두 상대 쪽으로 기운 경기였어요. 결과를 바꾸기 위해서는 한 장면만 보기보다, 공을 확보하고 다음 플레이로 연결하는 과정부터 차근차근 다듬는 것이 우선이에요.',mixed:'결과는 아쉬웠지만 우리 쪽에 유리한 지표도 함께 남았어요. 잘 풀린 과정은 유지하고, 상대가 앞선 지표와 연결된 장면에 개선의 우선순위를 두는 것이 좋겠어요.',even:'주요 지표는 비슷했지만 스코어에서는 차이가 났어요. 경기 전체를 부족했다고 보기보다, 득실점 장면 전후의 선택을 돌아보며 결과를 바꿀 작은 차이를 찾을 만해요.',partial:'결과는 아쉬웠지만, 스코어만으로 모든 플레이를 낮게 평가할 경기는 아니에요. 기록에 남은 강점은 이어 가고, 다음 경기에서 바꿔 볼 행동을 구체적으로 정해 봐요.'},
   };
   let verdict=assessment[result.outcome][balance];
   if(balance==='partial'&&v.ownPct!==null&&v.ownMs+v.opponentMs>=60000){
    if(v.ownPct>=55)verdict={win:'공을 더 오래 소유한 과정과 승리라는 결과가 같은 방향으로 남았어요. 점유에서 앞선 부분은 이번 경기의 강점으로 평가할 수 있고, 슈팅과 경기 흐름까지 함께 보면 그 강점을 어떻게 이어 갈지 더 분명해져요.',draw:'공을 더 오래 소유했지만 스코어에서는 우위를 만들지 못했어요. 소유권을 확보한 과정은 살리고, 전진한 뒤의 마지막 연결을 더 구체적으로 준비할 경기예요.',loss:'점유에서 앞선 부분은 있었지만 승리로 이어지지는 않았어요. 공을 확보한 과정은 이어 갈 강점이고, 득실점 장면 전후의 선택을 보완하는 데 다음 준비의 초점을 두면 좋겠어요.'}[result.outcome];
    else if(v.ownPct<=45)verdict={win:'공을 가진 시간은 상대보다 짧았지만 승리라는 결과를 가져왔어요. 결과를 만든 점은 긍정적으로 평가하고, 다음에는 소유권을 확보한 뒤 공격을 이어 갈 시간을 늘리는 과제를 더해 볼 만해요.',draw:'공을 가진 시간이 상대보다 짧았던 경기에서 결과의 균형을 남겼어요. 스코어를 맞춘 결과는 긍정적으로 보고, 다음에는 공을 확보한 뒤 전개를 이어 갈 지원 위치를 보완해 봐요.',loss:'점유 시간에서는 상대가 앞섰고 스코어에서도 차이가 났어요. 공을 확보한 뒤 첫 연결과 지원 위치를 다듬는 것을 우선 과제로 삼되, 슈팅과 후반 흐름에서 이어 갈 장점도 함께 평가하는 것이 좋아요.'}[result.outcome];
   }
   first.push(verdict);
   if(result.outcome==='win'&&result.other===0)first.push('실점 없이 마쳤다는 결과도 팀이 함께 남긴 긍정적인 부분이에요.');
   else if(result.outcome==='loss'&&result.other-result.own===1)first.push('한 골 차였던 만큼, 다음에 바꿔 볼 선택을 구체적으로 좁혀 보면 좋아요.');
  }
 }
 if(v.ownPct!==null)second.push(Math.abs(v.ownPct-50)<5?'점유 시간은 양 팀이 비슷했어요.':v.ownPct>50?'우리 팀이 공을 소유한 시간은 더 길었어요.':'상대가 공을 소유한 시간은 더 길었어요.');
 if(l.total_count)second.push(tied?'공격 전개는 여러 통로로 나뉘었어요.':`공격은 ${lanes[top]}에서 가장 자주 전개됐어요.`);
 if(flowReady){
  second.push(flow>.15?'기록된 흐름 지표는 평균적으로 우리 팀 쪽에 더 가까웠어요.':flow<-.15?'기록된 흐름 지표는 평균적으로 상대 쪽에 더 가까웠어요.':'평균적인 흐름 지표는 어느 한쪽으로 크게 기울지 않았어요.');
  const early=measured.filter(b=>b.start_ms<300000),late=measured.filter(b=>b.start_ms>=600000);
  if(early.length>=2&&late.length>=2){const delta=mean(late)-mean(early);if(Math.abs(delta)>.15)second.push(delta>0?'후반에는 초반보다 흐름 지표가 우리 쪽으로 올라와, 경기 안에서 나타난 변화도 긍정적으로 볼 수 있어요.':'후반에는 초반보다 흐름 지표가 상대 쪽으로 옮겨 가, 마지막 구간의 연결과 수비 준비를 우선 돌아볼 만해요.');}
 }
 if(ours.length&&theirs.length)second.push(`기록된 슈팅은 우리 팀 ${ours.length}회, 상대 ${theirs.length}회였어요.`);
 else if(shots.length)second.push(`현재 슈팅 기록에는 ${ours.length?'우리 팀':'상대'}의 시도만 남아 있어, 양 팀의 마무리 횟수 비교는 보류했어요.`);
 if(!result&&second.length)first.push('이번 경기는 공을 가진 시간, 공격 전개와 마무리 기록을 함께 놓고 읽는 것이 좋아요. 결과 정보가 없는 상태에서는 승패를 단정하지 않고, 확인된 플레이 과정에 평가의 초점을 맞췄어요.');
 if(second.length){
  if(shotReady&&v.ownPct!==null&&v.ownPct>=55&&ours.length<theirs.length)last.push('가장 먼저 다듬을 부분은 소유를 슈팅 기회로 잇는 과정이에요. 공을 오래 가진 강점에, 마지막 연결 뒤 한 번 더 골문 쪽으로 지원하는 움직임을 더해 봐요.');
  else if(shotReady&&v.ownPct!==null&&v.ownPct<=45&&ours.length>theirs.length)last.push('공을 가진 시간에 비해 슈팅 시도가 많이 남은 점은 살려 갈 강점이에요. 다음에는 공을 되찾은 뒤 가까운 지원 위치를 확보해, 공격으로 나갈 기회를 더 자주 만들어 봐요.');
  else if(result?.final&&result.outcome==='loss'&&result.other>=3)last.push('다음 경기에는 상대가 득점한 장면 전후의 간격부터 돌아봐요. 공격이 끝난 뒤 골문 쪽 공간을 함께 확인하는 약속을 정하면, 팀이 같은 기준으로 수비를 준비할 수 있어요.');
  else if(result?.final&&result.outcome!=='win'&&shotReady&&ours.length>theirs.length)last.push('마무리 시도를 많이 남긴 과정은 이어 가 봐요. 다음에는 슈팅 직전의 위치와 몸 방향, 곁에서 지원한 동료를 함께 보며 한 번의 선택을 더 선명하게 만들어 보세요.');
  else last.push(l.total_count&&!tied?`${lanes[top]}의 익숙한 전개는 다음 경기에도 살려 갈 출발점이에요. 공을 연결한 뒤 다른 통로로 지원하는 움직임을 더하면, 상대에게 보여 줄 선택지를 넓힐 수 있어요.`:'다음에는 공을 연결한 뒤 다시 받을 위치를 팀이 함께 준비해 봐요. 가까운 지원과 전방으로 나가는 선택을 나눠 연습하면 공격을 이어 가기 한결 편해질 거예요.');
  last.push(result?.final&&result.outcome==='win'?'이번 승리를 바탕으로, 잘된 플레이를 다시 만들어 낼 팀의 약속을 하나 더 쌓아가 봐요.':'이번 경기에 남은 장면을 함께 돌아보며, 다음 경기에서 실천할 한 가지부터 팀의 약속으로 만들어 봐요.');
 }
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
