import {useEffect,useRef} from 'react';
import {paintHeatmap} from '../../public/fpa-cv/heatmap-render.mjs';
import {spatialSummary,heatmapDisplayCoverage,type HeatSource,type HeatPlayer,type ReportDraft} from '../../lib/futsal-report';
import {teamLogo} from '../../lib/futsal-team-logos';
import ReportBrand from './ReportBrand';
import ReportEventMap from './ReportEventMap';
import {reportPlayer} from '../../lib/futsal-report-events';
const time=(n:number)=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
function ClubLogo({name}:{name:string}){const src=teamLogo(name);return src?<img className="mr-team-logo" src={src} alt={`${name} 로고`} />:null;}
function HeatPitch({source,player}:{source:HeatSource|null;player?:HeatPlayer}){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{const c=ref.current;if(!c)return;c.width=1320;
  if(source&&player)paintHeatmap(c,source,player);else paintHeatmap(c,{width:80,height:40,scale:1},{grid:Array(3200).fill(0)});
 },[source,player]);
 return <canvas ref={ref} aria-label="선수 활동 히트맵"/>;
}

export default function PlayerReportSheet({draft,selected=draft.selected}:{draft:ReportDraft;selected?:string}){
 const {person,player:heatPlayer,map,direction}=reportPlayer(draft,selected);
 const spatial=spatialSummary(draft.heatmap,heatPlayer,direction);
 const ownName=person.side==='home'?draft.homeName:draft.awayName,opponent=person.side==='home'?draft.awayName:draft.homeName,ownScore=person.side==='home'?draft.homeScore:draft.awayScore,opponentScore=person.side==='home'?draft.awayScore:draft.homeScore;
 const hasScore=/^\d+$/.test(ownScore)&&/^\d+$/.test(opponentScore),result=hasScore?Number(ownScore)>Number(opponentScore)?'WIN':Number(ownScore)<Number(opponentScore)?'LOSE':'DRAW':'';
 const reviews=[{key:'strengths' as const,title:'좋았던 장면',en:'STRENGTHS'},{key:'improvements' as const,title:'다음 경기를 위한 제안',en:'NEXT STEP'}];
 return <div className="mr-sheet">
   <header className="mr-sheet-top"><span>FINE PLAY · QUEEN CUP</span><span>PLAYER MATCH REPORT</span></header>
   <div className="mr-player-heading"><span className="mr-number">{person.jersey?`NO. ${person.jersey}`:'NO. —'}</span><h1 data-report-text="선수 이름">{person.name||(person.jersey?`선수 #${person.jersey}`:'선수 이름')}{person.position&&<span className="mr-position">{person.position}</span>}</h1><p data-report-text="경기 이름">{draft.matchName||'경기 이름'}</p></div>
   <div className="mr-match-band"><div className="mr-club mr-own-team"><ClubLogo name={ownName}/><div><small>MY TEAM</small><strong data-report-text="소속 팀">{ownName||'소속 팀'}</strong></div></div><div className="mr-score"><strong>{ownScore||'—'} <i>:</i> {opponentScore||'—'}</strong>{result&&<span>{result}</span>}</div><div className="mr-club mr-opponent-team"><div><small>OPPONENT</small><strong data-report-text="상대 팀">{opponent||'상대 팀'}</strong></div><ClubLogo name={opponent}/></div></div>
   <section className="mr-map-section"><div className="mr-map-panel"><div className="mr-map-heading"><h2>HEAT MAP</h2><span>{direction==='right'?'공격 방향 →':'← 공격 방향'}</span></div><HeatPitch source={draft.heatmap} player={heatPlayer}/><small>{spatial?`히트맵 반영률 ${(heatmapDisplayCoverage(draft.heatmap!,heatPlayer!)*100).toFixed(1)}% · 영상 ${time(draft.heatmap!.from)}–${time(draft.heatmap!.to)}`:'히트맵 데이터 미연결'}</small></div><div className="mr-comment"><h3>활동 이야기</h3><p data-report-text="히트맵 코멘트">{person.heatComment||'히트맵 코멘트를 입력하세요.'}</p></div></section>
   <section className="mr-map-section"><div className="mr-map-panel"><div className="mr-map-heading"><h2>EVENT MAP</h2><span className="mr-event-legend"><i style={{background:(person.side==='home'?draft.teamReport?.homeColor:draft.teamReport?.awayColor)|| (person.side==='home'?'#FF7400':'#2158E8')}}/>아군 <i style={{background:(person.side==='home'?draft.teamReport?.awayColor:draft.teamReport?.homeColor)|| (person.side==='home'?'#2158E8':'#FF7400')}}/>상대</span></div><ReportEventMap draft={draft} person={person}/><small>{`● 슈팅 · ★ 볼 회수 · ◆ 수비 | 진한 마커: 이 선수 ${map.markers.filter(m=>m.personal&&m.x!==null).length}건`}<br/>{`양 팀 기록 ${map.markers.filter(m=>m.x!==null).length}건 · 좌표 없음 ${map.missing}건`}</small></div><div className="mr-comment"><h3>플레이 이야기</h3><p data-report-text="이벤트맵 코멘트">{person.eventComment||'이벤트맵 코멘트를 입력하세요.'}</p></div></section>
   <section className="mr-review"><div className="mr-review-heading"><h2>MATCH REVIEW</h2><span>한 경기의 기록, 다음 경기를 위한 힌트</span></div><div className="mr-review-grid">{reviews.map(r=><div key={r.key}><h3><small>{r.en}</small>{r.title}</h3><ol>{person[r.key].map((text,i)=><li key={i}><span>{String(i+1).padStart(2,'0')}</span><p data-report-text={`${r.title} ${i+1}`}>{text||'—'}</p></li>)}</ol></div>)}</div></section>
   <ReportBrand/>
</div>;
}
