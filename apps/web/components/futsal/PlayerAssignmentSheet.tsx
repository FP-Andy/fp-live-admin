import type {ReportDraft} from '../../lib/futsal-report';
import {assignmentRows,type AssignmentPlayer} from '../../lib/futsal-report-assignment';
import {reportTeamOptions} from '../../lib/futsal-team-report';
import {clubName} from '../../lib/futsal-clubs';
import {teamLogo} from '../../lib/futsal-team-logos';
import ReportBrand from './ReportBrand';

// Try several nearby label positions, keeping leader lines attached to the
// original, operator-selected box. No track is inferred for this still frame.
export function assignmentLabels(players:AssignmentPlayer[],own:'home'|'away',canvasHeight=675){
 const placed:Array<{x:number;y:number;width:number;height:number}>=[];
 return players.map(p=>{const side=p.group.startsWith('home')?'home':p.group.startsWith('away')?'away':'referee',text=side==='referee'?'심판':`${side===own?'아군':'상대'}${p.group.endsWith('_gk')?' GK':''} #${p.number}`,width=Math.max(90,text.length*12+14),height=29,cx=(p.box[0]+p.box[2])*600,top=p.box[1]*canvasHeight;
  const candidates=[-height-5,8,-height*2-9,42].flatMap(dy=>[-width/2,8,-width-8].map(dx=>({x:Math.max(3,Math.min(1197-width,cx+dx)),y:Math.max(3,Math.min(canvasHeight-3-height,top+dy)),width,height})));
  const rect=candidates.find(a=>!placed.some(b=>a.x<b.x+b.width+3&&a.x+a.width+3>b.x&&a.y<b.y+b.height+3&&a.y+a.height+3>b.y))||candidates[0];placed.push(rect);return {p,side,text,cx,top,...rect};
 });
}
export default function PlayerAssignmentSheet({draft}:{draft:ReportDraft}){
 const frame=draft.assignment,canvasHeight=frame?1200*frame.height/frame.width:675,options=reportTeamOptions(draft),sides=[options.side,options.side==='home'?'away':'home'] as const,colors={home:options.homeColor,away:options.awayColor,referee:'#57465A'};
 return <div className="mr-sheet ar-sheet">
  <header className="mr-sheet-top"><span>FINE PLAY · QUEEN CUP</span><span>PLAYER GUIDE</span></header>
  <div className="ar-heading"><small>FIND YOUR NUMBER</small><h1>사진 속 나를 찾아보세요</h1><p data-report-text="배정표 경기">{draft.matchName}</p></div>
  <div className="ar-frame" style={frame?{width:Math.min(836,470*frame.width/frame.height),aspectRatio:`${frame.width}/${frame.height}`} : undefined}>{frame?<><img src={frame.image} alt="초기 설정 장면"/><svg viewBox={`0 0 1200 ${canvasHeight}`} aria-label="초기 선수 배정 번호">{assignmentLabels(frame.players,options.side,canvasHeight).map(({p,side,text,cx,top,x,y,width,height})=><g key={p.id}>
    <rect x={p.box[0]*1200} y={p.box[1]*canvasHeight} width={(p.box[2]-p.box[0])*1200} height={(p.box[3]-p.box[1])*canvasHeight} fill="none" stroke="#fff" strokeWidth="3"/>
    <rect x={p.box[0]*1200} y={p.box[1]*canvasHeight} width={(p.box[2]-p.box[0])*1200} height={(p.box[3]-p.box[1])*canvasHeight} fill="none" stroke={colors[side as keyof typeof colors]} strokeWidth="1.6"/>
    <path d={`M${cx} ${top}L${x+width/2} ${y+height/2}`} stroke="white" strokeWidth="1.5"/>
    <rect x={x} y={y} width={width} height={height} rx="4" fill="white" stroke={colors[side as keyof typeof colors]} strokeWidth="2"/><rect x={x} y={y} width="5" height={height} rx="2" fill={colors[side as keyof typeof colors]}/>
    <text x={x+width/2+2} y={y+height/2+1} dominantBaseline="middle" textAnchor="middle" fill="#30202A" fontSize="18" fontWeight="700">{text}</text>
   </g>)}</svg></>:<p>초기 설정 장면을 불러오면 선수 배정표가 완성됩니다.</p>}</div>
  <p className="ar-instruction">사진의 분석번호를 확인한 뒤, 같은 번호의 개인 리포트를 찾아보세요.</p>
  <div className="ar-teams">{sides.map((side,i)=>{const name=clubName(side==='home'?draft.homeName:draft.awayName),logo=teamLogo(name);return <section key={side} className="ar-team"><h2>{logo&&<img src={logo} alt={`${name} 로고`}/>}<span><small>{i===0?'아군':'상대'}</small>{name}</span></h2><table><thead><tr><th>분석번호</th><th>축구식</th><th>풋살식</th></tr></thead><tbody>{assignmentRows(draft,side).map(p=><tr key={p.id}><th>#{p.number}</th><td>{p.role?.football||'—'}</td><td>{p.role?.futsal||'—'}</td></tr>)}</tbody></table></section>;})}</div>
  <ReportBrand/>
 </div>;
}
