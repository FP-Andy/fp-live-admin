import {useId} from 'react';
import {continuousPath,arrowSize,type Lanes,type Dominance} from './graphics';
import {teamLogo} from '../../lib/futsal-team-logos';
import {teamReportView,matchComment,defaultTeamReport} from '../../lib/futsal-team-report';
import type {ReportDraft} from '../../lib/futsal-report';
import ReportBrand from './ReportBrand';

const clock=(ms:number)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
function Logo({name}:{name:string}){const src=teamLogo(name);return src?<img className="mr-team-logo" src={src} alt={`${name} 로고`}/>:null;}
function LanesChart({lanes,color,label}:{lanes:Lanes;color:string;label:string}){
 const counts=[lanes.left_count,lanes.center_count,lanes.right_count];
 return <div className="tr-lanes"><strong style={{color}}>{label}</strong><svg viewBox="0 0 240 175" role="img" aria-label={`${label} 공격 방향`}>
  <rect x="20" y="9" width="200" height="134" rx="3" fill="#FFF9FC" stroke="#EFCADE"/>
  <g transform="translate(20 9) scale(10 6.7)" fill="none" stroke="#E162A7" strokeWidth=".08"><path d="M8.5 0V-1H11.5V0M2.5 0A6 6 0 0 0 8.5 6H11.5A6 6 0 0 0 17.5 0M7 20A3 3 0 0 1 13 20"/><circle cx="10" cy="6" r=".12"/></g>
  {counts.map((count,i)=>{const pct=lanes.total_count?count/lanes.total_count*100:0,size=arrowSize(pct),x=20+(i+.5)*200/3,top=size?119-size.length*6:119,w=size?size.shaft*7:0,head=size?size.head*8:0;return <g key={i}>{size&&<path d={`M${x} ${top}L${x+head/2} ${top+head*.7}H${x+w/2}V119H${x-w/2}V${top+head*.7}H${x-head/2}Z`} fill={color}/>}<text x={x} y="139" textAnchor="middle" fontSize="12" fontWeight="700" fill="#48283D">{lanes.total_count?`${pct.toFixed(1)}%`:'—'}</text><text x={x} y="160" textAnchor="middle" fontSize="10" fill="#94637F">{['왼쪽','중앙','오른쪽'][i]} · {count}회</text></g>;})}
 </svg><small>{lanes.total_count?`공격 ${lanes.total_count}회 · 상대 골문 ↑`:'공격 방향 기록 없음'}</small></div>;
}
function Flow({bins,own,other}:{bins:Dominance['bins'];own:string;other:string}){
 const id=useId().replace(/:/g,''),start=(b:Dominance['bins'][number])=>b.chart_start_ms??b.start_ms,end=(b:Dominance['bins'][number])=>b.chart_end_ms??b.end_ms;
 const max=Math.max(60000,...bins.map(end)),x=(ms:number)=>48+ms/max*700,y=(v:number)=>98-v*65;
 const groups:Dominance['bins'][]=[];
 bins.forEach((b,i)=>{const prev=bins[i-1];if(!prev||prev.period!==b.period||start(b)>end(prev))groups.push([]);groups.at(-1)!.push(b);});
 return <svg viewBox="0 0 790 205" role="img" aria-label="아군 상대 매치 도미넌스">
  <defs><clipPath id={id+'up'}><rect x="48" y="30" width="700" height="68"/></clipPath><clipPath id={id+'down'}><rect x="48" y="98" width="700" height="68"/></clipPath></defs>
  {[-1,-.5,0,.5,1].map(v=><g key={v}><line x1="48" x2="748" y1={y(v)} y2={y(v)} stroke={v===0?'#C692AE':'#EFCADE'} strokeDasharray={v===0?undefined:'3 5'}/><text x="36" y={y(v)+4} textAnchor="end" fontSize="9" fill="#94637F">{v}</text></g>)}
  {groups.map((g,i)=>{const points=g.map(b=>({x:x((start(b)+end(b))/2),y:y(b.dominance)}));points.unshift({x:x(start(g[0])),y:points[0].y});points.push({x:x(end(g.at(-1)!)),y:points.at(-1)!.y});const line=continuousPath(points),area=`${line}L${points.at(-1)!.x} 98L${points[0].x} 98Z`;return <g key={i}><path d={area} fill={own} opacity=".45" clipPath={`url(#${id}up)`}/><path d={area} fill={other} opacity=".45" clipPath={`url(#${id}down)`}/><path d={line} fill="none" stroke="#48283D" strokeWidth="1.8"/></g>;})}
  {bins.filter((_,i)=>i%Math.max(1,Math.ceil(bins.length/10))===0||i===bins.length-1).map((b,i)=><text key={i} x={x((start(b)+end(b))/2)} y="187" fontSize="9" fill="#94637F" textAnchor="middle">{clock(b.display_end_ms??b.end_ms)}</text>)}
  {bins.map((b,i)=><g key={i}>{!!b.annotations?.goal_summary?.home&&<circle cx={x((start(b)+end(b))/2)} cy="24" r="3.5" fill={own}/>} {!!b.annotations?.goal_summary?.away&&<circle cx={x((start(b)+end(b))/2)} cy="172" r="3.5" fill={other}/>}</g>)}
  <text x="48" y="14" fontSize="10" fontWeight="700" fill={own}>아군 ↑</text><text x="748" y="14" fontSize="10" fontWeight="700" fill={other} textAnchor="end">상대 ↓</text>
  {!bins.length&&<text x="398" y="90" textAnchor="middle" fontSize="13" fill="#94637F">경기 흐름 기록 없음</text>}
 </svg>;
}
export default function TeamReportSheet({draft}:{draft:ReportDraft}){
 const o=draft.teamReport||defaultTeamReport(),side=o.side,ours=side==='home',ownName=ours?draft.homeName:draft.awayName,otherName=ours?draft.awayName:draft.homeName;
 const own=ours?o.homeColor:o.awayColor,other=ours?o.awayColor:o.homeColor,ownScore=ours?draft.homeScore:draft.awayScore,otherScore=ours?draft.awayScore:draft.homeScore;
 const data=draft.fla?.matchId===draft.matchId?draft.fla:null,v=data?teamReportView(data,side):null;
 const blank={left_count:0,center_count:0,right_count:0,total_count:0};
 const comment=(ours?o.homeComment:o.awayComment)||(data?matchComment(data,side):'');
 return <div className="mr-sheet tr-sheet">
  <header className="mr-sheet-top"><span>FINE PLAY · QUEEN CUP</span><span>TEAM MATCH REPORT</span></header>
  <div className="tr-heading"><small>MATCH SUMMARY</small><h1 data-report-text="경기 요약 제목">{ownName||'아군'} 경기 리포트</h1><p data-report-text="경기 이름">{draft.matchName||'경기를 선택하세요'}</p></div>
  <div className="mr-match-band"><div className="mr-club mr-own-team"><Logo name={ownName}/><div><small>아군</small><strong data-report-text="아군 팀명">{ownName||'아군'}</strong></div></div><div className="mr-score"><strong>{ownScore||'—'} <i>:</i> {otherScore||'—'}</strong><span>MATCH RESULT</span></div><div className="mr-club mr-opponent-team"><div><small>상대</small><strong data-report-text="상대 팀명">{otherName||'상대'}</strong></div><Logo name={otherName}/></div></div>
  <section className="tr-panel tr-attacks"><h2><small>01</small> 공격 방향 <span>ATTACK DIRECTION</span></h2><div className="tr-lane-pair"><LanesChart lanes={v?.ownLanes||blank} color={own} label="아군"/><LanesChart lanes={v?.opponentLanes||blank} color={other} label="상대"/></div></section>
  <section className="tr-panel tr-possession"><h2><small>02</small> 점유율 <span>POSSESSION</span></h2><div className="tr-possession-numbers"><strong style={{color:own}}>아군 {v?.ownPct==null?'—':`${v.ownPct.toFixed(1)}%`}</strong><strong style={{color:other}}>상대 {v?.opponentPct==null?'—':`${v.opponentPct.toFixed(1)}%`}</strong></div><div className="tr-possession-bar" role="img" aria-label="아군 상대 점유율">{v?.ownPct!=null&&<><span style={{width:v.ownPct+'%',background:own}}/><span style={{width:v.opponentPct+'%',background:other}}/></>}</div><small>{v?.ownPct==null?'점유 기록 없음':`아군 ${clock(v.ownMs)} · 상대 ${clock(v.opponentMs)} · 기록된 점유 시간 기준`}</small></section>
  <section className="tr-panel tr-flow"><h2><small>03</small> 매치 도미넌스 <span>MATCH DOMINANCE</span></h2><Flow bins={v?.bins||[]} own={own} other={other}/><small>1분 단위 경기 흐름 · ● 득점 기록</small></section>
  <section className="tr-panel tr-review"><h2><small>04</small> 경기 총평 <span>MATCH REVIEW</span></h2><p data-report-text="경기 총평">{comment||'FLA 기록을 불러오면 경기 총평을 만들 수 있습니다.'}</p></section>
  <ReportBrand/>
 </div>;
}
