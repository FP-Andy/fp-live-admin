import {useEffect,useRef} from 'react';
import {paintHeatmap} from '../../public/fpa-cv/heatmap-render.mjs';
import {attackDirection,blankPlayer,eventKind,eventPoint,reportEvents,spatialSummary,heatmapDisplayCoverage,type HeatSource,type HeatPlayer,type ReportDraft,type Direction} from '../../lib/futsal-report';
import {teamLogo} from '../../lib/futsal-team-logos';
import type {FpaEvent} from './fpaGraphics';
import ReportBrand from './ReportBrand';
const time=(n:number)=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
function ClubLogo({name}:{name:string}){const src=teamLogo(name);return src?<img className="mr-team-logo" src={src} alt={`${name} 로고`} />:null;}
function Pitch({source,player,events,direction,kind}:{source:HeatSource|null;player?:HeatPlayer;events:FpaEvent[];direction:Direction;kind:'heat'|'events'}){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{const c=ref.current;if(!c)return;c.width=1320;
  if(kind==='heat'&&source&&player)paintHeatmap(c,source,player);
  else paintHeatmap(c,{width:80,height:40,scale:1},{grid:Array(3200).fill(0)});
  if(kind==='events'){
   const ctx=c.getContext('2d')!,unit=c.width/44;
   events.forEach(e=>{const p=eventPoint(e,direction);if(!p)return;const x=(2+p.x)*unit,y=(2+p.y)*unit,r=9;
    ctx.fillStyle=eventKind(e)==='shot'?'#A13067':'#E162A7';ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();
    if(eventKind(e)==='shot')ctx.arc(x,y,r,0,Math.PI*2);else for(let i=0;i<10;i++){const angle=-Math.PI/2+i*Math.PI/5,rad=i%2?r*.45:r;const px=x+Math.cos(angle)*rad,py=y+Math.sin(angle)*rad;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath();ctx.fill();ctx.stroke();
   });
  }
 },[source,player,events,direction,kind]);
 return <canvas ref={ref} aria-label={kind==='heat'?'선수 활동 히트맵':'볼 회수·슈팅 이벤트맵'} />;
}

export default function PlayerReportSheet({draft,selected=draft.selected}:{draft:ReportDraft;selected?:string}){
 const person=draft.players[selected]||blankPlayer(),heatPlayer=draft.heatmap?.players.find(p=>p.id===selected),direction=attackDirection(draft,person);
 const events=reportEvents(draft.fpa,person,draft.homeName,draft.awayName),spatial=spatialSummary(draft.heatmap,heatPlayer,direction);
 const ownName=person.side==='home'?draft.homeName:draft.awayName,opponent=person.side==='home'?draft.awayName:draft.homeName,ownScore=person.side==='home'?draft.homeScore:draft.awayScore,opponentScore=person.side==='home'?draft.awayScore:draft.homeScore;
 const hasScore=/^\d+$/.test(ownScore)&&/^\d+$/.test(opponentScore),result=hasScore?Number(ownScore)>Number(opponentScore)?'WIN':Number(ownScore)<Number(opponentScore)?'LOSE':'DRAW':'';
 const reviews=[{key:'strengths' as const,title:'좋았던 장면',en:'STRENGTHS'},{key:'improvements' as const,title:'다음 경기를 위한 제안',en:'NEXT STEP'}];
 return <div className="mr-sheet">
   <header className="mr-sheet-top"><span>FINE PLAY · QUEEN CUP</span><span>PLAYER MATCH REPORT</span></header>
   <div className="mr-player-heading"><span className="mr-number">{person.jersey?`NO. ${person.jersey}`:'NO. —'}</span><h1 data-report-text="선수 이름">{person.name||(person.jersey?`선수 #${person.jersey}`:'선수 이름')}{person.position&&<span className="mr-position">{person.position}</span>}</h1><p data-report-text="경기 이름">{draft.matchName||'경기 이름'}</p></div>
   <div className="mr-match-band"><div className="mr-club mr-own-team"><ClubLogo name={ownName}/><div><small>MY TEAM</small><strong data-report-text="소속 팀">{ownName||'소속 팀'}</strong></div></div><div className="mr-score"><strong>{ownScore||'—'} <i>:</i> {opponentScore||'—'}</strong>{result&&<span>{result}</span>}</div><div className="mr-club mr-opponent-team"><div><small>OPPONENT</small><strong data-report-text="상대 팀">{opponent||'상대 팀'}</strong></div><ClubLogo name={opponent}/></div></div>
   <section className="mr-map-section"><div className="mr-map-panel"><div className="mr-map-heading"><h2>HEAT MAP</h2><span>{direction==='right'?'공격 방향 →':'← 공격 방향'}</span></div><Pitch kind="heat" source={draft.heatmap} player={heatPlayer} events={events} direction={direction}/><small>{spatial?`히트맵 반영률 ${(heatmapDisplayCoverage(draft.heatmap!,heatPlayer!)*100).toFixed(1)}% · 영상 ${time(draft.heatmap!.from)}–${time(draft.heatmap!.to)}`:'히트맵 데이터 미연결'}</small></div><div className="mr-comment"><h3>활동 이야기</h3><p data-report-text="히트맵 코멘트">{person.heatComment||'히트맵 코멘트를 입력하세요.'}</p></div></section>
   <section className="mr-map-section"><div className="mr-map-panel"><div className="mr-map-heading"><h2>EVENT MAP</h2><span>★ 볼 회수 · ● 슈팅</span></div><Pitch kind="events" source={draft.heatmap} events={events} direction={direction}/><small>{draft.fpa?`선택한 FPA 기록 전체 · 표시 ${events.filter(e=>e.points.length).length}건 · 좌표 없음 ${events.filter(e=>!e.points.length).length}건`:'FPA 데이터 미연결'}</small></div><div className="mr-comment"><h3>플레이 이야기</h3><p data-report-text="이벤트맵 코멘트">{person.eventComment||'이벤트맵 코멘트를 입력하세요.'}</p></div></section>
   <section className="mr-review"><div className="mr-review-heading"><h2>MATCH REVIEW</h2><span>한 경기의 기록, 다음 경기를 위한 힌트</span></div><div className="mr-review-grid">{reviews.map(r=><div key={r.key}><h3><small>{r.en}</small>{r.title}</h3><ol>{person[r.key].map((text,i)=><li key={i}><span>{String(i+1).padStart(2,'0')}</span><p data-report-text={`${r.title} ${i+1}`}>{text||'—'}</p></li>)}</ol></div>)}</div></section>
   <ReportBrand/>
</div>;
}
