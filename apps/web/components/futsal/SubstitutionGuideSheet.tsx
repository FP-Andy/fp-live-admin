import type {ReportDraft} from '../../lib/futsal-report';
import type {SubstitutionResultEvent} from '../../public/fpa-cv/substitution-report.mjs';
import {formatLogTime as time} from '../../public/fla-video/substitution-log.mjs';
import ReportBrand from './ReportBrand';
export default function SubstitutionGuideSheet({draft,events}:{draft:ReportDraft;events:SubstitutionResultEvent[]}){
 return <div className="mr-sheet mr-sub-guide"><header className="mr-sheet-top"><span>FINE PLAY · QUEEN CUP</span><span>SUBSTITUTION GUIDE</span></header><div className="mr-player-heading"><span className="mr-number">FIND YOUR NUMBER</span><h1>교체 투입된 나를 찾아보세요</h1><p>{draft.matchName}</p></div>
 {events.map(e=><section className="mr-sub-scene" key={e.id}><h2>{e.team==='home'?draft.homeName:draft.awayName} · 새 분석번호 #{e.inNumber}</h2><p>영상 {time(e.inTime!)} 투입 · #{e.outNumber}의 퇴장 구간과 분리</p>{draft.substitutionReport?.images?.[e.id]?<img src={draft.substitutionReport.images[e.id]} alt={`분석번호 ${e.inNumber}의 교체 입장 장면`}/>:<div className="mr-sub-image-placeholder">PDF 추출 시 해당 영상 장면이 자동으로 들어갑니다.</div>}</section>)}
 <p className="mr-sub-guide-note">새 번호는 실제 등번호가 아닌 출전 구간의 분석번호예요. 투입 전·퇴장 후 시간은 해당 히트맵에서 제외했어요. 재입장한 동일인인지는 별도로 확인하며, 짧은 출전 구간은 관측된 움직임을 중심으로 읽어 주세요.</p><ReportBrand/></div>;
}
