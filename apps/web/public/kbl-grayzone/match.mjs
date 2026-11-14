import {mountWidePreparation} from './wide-preparation.mjs';
const $=id=>document.getElementById(id),id=new URLSearchParams(location.search).get('id');
const stateNames={uploading:'업로드 미완료',matching:'영상·시계 확인 중','awaiting-selection':'프레임 선택 대기',selected:'프레임 선택 저장됨',failed:'처리 확인 필요'};
const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
try{const r=await fetch(`/api/library/matches/${encodeURIComponent(id)}`),m=await r.json();if(!r.ok)throw Error(m.error);
 $('matchTitle').textContent=`${m.home} vs ${m.away}`;document.title=`${m.home} vs ${m.away} | COURTSIDE`;
 $('matchMeta').textContent=`${m.date} · KBL${m.gameNumber?` · 경기 ${m.gameNumber}`:''}${m.venue?` · ${m.venue}`:''}`;
 $('uploadData').href=`./workflow.html?match=${m.id}`;
 mountWidePreparation($('widePreparation'),{matchId:m.id,initialMatch:m,autoCheck:true});
 $('sourceNote').textContent=m.caseId?'등록된 장면의 객체·관절·공간 검수와 리포트로 이어집니다.':m.fpcMatchId?'FPC 경기 정보가 연결되어 있습니다. 중계 영상·CSV는 별도로 등록하세요. 프레임을 확정하면 T4에서 추적·자세를 처리합니다.':'중계 영상과 CSV 등록 → 프레임 확정 → T4 처리 → 객체·관절·공간 검수 순서로 진행합니다.';
 if(m.referees?.length){$('referees').hidden=false;$('referees').textContent='배정 심판 · '+m.referees.map(r=>`#${r.number} ${r.name}`).join(' / ');}
 if(m.caseId){$('resumeCase').hidden=false;$('resumeCase').href=`./workflow.html?case=${m.caseId}&match=${m.id}`;}
 if(m.demoMatchId){$('demoClips').hidden=false;$('demoClips').href=`./#match=${m.demoMatchId}`;}
 $('intakeCount').textContent=`${m.intakes.length}건`;
 $('intakes').replaceChildren(...m.intakes.map(i=>{const link=node('a','intake-row','');link.href=`./workflow.html?match=${m.id}&intake=${i.id}`;const info=node('div','','');info.append(node('strong','',`영상 ${i.videoCount}개 · 판독 ${i.eventCount}건`),node('p','',new Date(i.receivedAt).toLocaleString('ko-KR')),node('p','',i.media.map(m=>m.name).join(' · ')));link.append(info,node('span','',`${stateNames[i.status]||i.status} · ${i.selectedCount}/${i.eventCount} 선택 →`));return link;}));
 if(!m.intakes.length)$('intakes').append(node('p','help','아직 등록한 자료가 없습니다. 위의 영상·CSV 등록에서 시작하세요.'));
}catch(e){$('status').textContent=e.message;$('uploadData').hidden=true;}
