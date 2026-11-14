import {$,api,bridge,dateText,intakeId,node,uuid} from './fpc-ui.mjs';
const id=new URLSearchParams(location.search).get('id');
const states={uploading:'업로드 미완료',matching:'영상·시계 확인 중','awaiting-selection':'프레임 선택 대기',selected:'프레임 선택 저장됨',failed:'처리 확인 필요'};
async function load(){
 if(!uuid(id))throw Error('경기를 확인해 주세요.');
 const access=await api(`/api/courtside/matches/${id}/access`),[match,cases,drafts]=await Promise.all([api(`/api/matches/${id}`),api(`/api/courtside/matches/${id}/cases`),api(`/api/courtside/matches/${id}/intakes`)]);
 $('matchTitle').textContent=match.name;document.title=`${match.name} | COURTSIDE`;$('matchMeta').textContent=`${dateText(match)} · KBL`;
 $('uploadData').href=`./fpc-intake.html?match=${encodeURIComponent(id)}`;$('uploadData').hidden=!access.canEdit;
 $('sourceNote').textContent=access.canEdit?'FPC 경기 정보가 연결되어 있습니다. 중계 영상·CSV를 등록한 뒤 같은 순간의 광각 프레임을 확인하세요.':'이 경기는 읽기 권한만 있습니다.';
 const completed=Array.isArray(cases.cases)?cases.cases:[];
 if(completed.length){$('resumeCase').hidden=false;$('resumeCase').href=bridge(id,completed[0].id,'cases');}
 const items=Array.isArray(drafts.intakes)?drafts.intakes.filter(i=>intakeId(i.id)):[];$('intakeCount').textContent=`${items.length}건`;
 $('intakes').replaceChildren(...items.map(item=>{
  const link=node('a','intake-row');link.href=item.status==='uploading'?`./fpc-intake.html?match=${encodeURIComponent(id)}&resume=${encodeURIComponent(item.id)}`:bridge(id,item.id);
  const info=node('div');info.append(node('strong','','영상·판독 자료'),node('p','',item.receivedAt?new Date(item.receivedAt).toLocaleString('ko-KR'):'등록 시각 미확인'));
  link.append(info,node('span','',`${states[item.status]||'상태 확인 필요'} →`));return link;
 }));
 if(!items.length)$('intakes').append(node('p','help','아직 등록한 자료가 없습니다. 위의 영상·CSV 등록에서 시작하세요.'));
}
load().catch(e=>{$('status').textContent=e.message;$('uploadData').hidden=true;});
