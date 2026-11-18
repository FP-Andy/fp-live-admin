import {$,api,bridge,dateText,intakeId,node,uuid} from './fpc-ui.mjs';
import {workProgress} from './match-progress.mjs';
const id=new URLSearchParams(location.search).get('id');
const states={uploading:'업로드 미완료',matching:'영상·시계 확인 중','awaiting-selection':'프레임 선택 대기',selected:'프레임 선택 저장됨',failed:'처리 확인 필요'};
async function load(){
 if(!uuid(id))throw Error('경기를 확인해 주세요.');
 const access=await api(`/api/courtside/matches/${id}/access`),[match,cases,drafts]=await Promise.all([api(`/api/matches/${id}`),api(`/api/courtside/matches/${id}/cases`),api(`/api/courtside/matches/${id}/intakes`)]);
 $('matchTitle').textContent=match.name;document.title=`${match.name} | COURTSIDE`;$('matchMeta').textContent=`${dateText(match)} · KBL`;
 $('uploadData').href=`./fpc-intake.html?match=${encodeURIComponent(id)}`;$('uploadData').hidden=!access.canEdit;
 $('sourceNote').textContent=access.canEdit?'FPC 경기 정보가 연결되어 있습니다. 중계 영상·CSV를 등록한 뒤 같은 순간의 광각 프레임을 확인하세요.':'이 경기는 읽기 권한만 있습니다.';
 if(access.canManageEditors)loadEditors();
 const completed=Array.isArray(cases.cases)?cases.cases:[];
 if(completed.length){$('inputTitle').textContent='판독 자료가 등록되어 있습니다.';$('sourceNote').textContent=access.canEdit?'저장된 판독 작업은 위의 진행 상태에서 이어갈 수 있습니다.':'이 경기는 읽기 권한만 있습니다.';$('resumeCase').hidden=false;$('resumeCase').href=bridge(id,completed[0].id,'cases');loadProgress(completed[0].id);}
 if(completed.length){loadPresence();setInterval(loadPresence,30000);}
 const items=Array.isArray(drafts.intakes)?drafts.intakes.filter(i=>intakeId(i.id)):[];$('intakeCount').textContent=`${items.length}건`;
 $('intakes').replaceChildren(...items.map(item=>{
  const link=node('a','intake-row');link.href=item.status==='uploading'?`./fpc-intake.html?match=${encodeURIComponent(id)}&resume=${encodeURIComponent(item.id)}`:bridge(id,item.id);
  const info=node('div');info.append(node('strong','','영상·판독 자료'),node('p','',item.receivedAt?new Date(item.receivedAt).toLocaleString('ko-KR'):'등록 시각 미확인'));
  link.append(info,node('span','',`${states[item.status]||'상태 확인 필요'} →`));return link;
 }));
 if(!items.length)$('intakes').append(node('p','help','아직 등록한 자료가 없습니다. 위의 영상·CSV 등록에서 시작하세요.'));
}
async function loadPresence(){
 try{const data=await api(`/api/courtside/matches/${encodeURIComponent(id)}/presence`),names={frame:'경기·프레임',objects:'객체',joints:'관절',spatial:'2D·3D',report:'리포트'};
  $('workProgressPeople').textContent=data.people?.length?'최근 2분 활동 · '+data.people.map(person=>`${person.name} (${names[person.stage]||'작업'}${/^review-\d+$/.test(person.eventId||'')?' · '+person.eventId.replace('review-','')+'번':''})`).join(' · '):'최근 2분 내 작업 활동 없음';
 }catch{$('workProgressPeople').textContent='작업자 활동을 확인할 수 없습니다.';}
}
async function loadEditors(){
 $('editorPanel').hidden=false;const status=$('editorStatus'),list=$('editorList'),save=$('saveEditors');save.disabled=true;
 try{
  let info=await api(`/api/courtside/matches/${encodeURIComponent(id)}/editors`);
  const selected=new Set(info.editorIds||[]);
  const users=Array.isArray(info.users)?info.users:[],known=new Set(users.map(person=>person.id));
  const people=[...users,...[...selected].filter(id=>!known.has(id)).map(id=>({id,name:`현재 목록에 없는 기존 작업자 (${id})`}))];
  const counts=new Map();for(const person of people)counts.set(person.name,(counts.get(person.name)||0)+1);
  list.replaceChildren(...people.map(person=>{const label=node('label');label.style.cssText='display:flex;align-items:center;gap:8px;margin:8px 0';const input=node('input');input.type='checkbox';input.value=person.id;input.checked=selected.has(person.id);label.append(input,document.createTextNode(person.name+(counts.get(person.name)>1?` · ${person.id.slice(-6)}`:'')));return label;}));
  if(!info.users.length)list.append(node('p','help','선택할 작업자 계정이 없습니다.'));
  save.disabled=false;status.textContent='';
  save.onclick=async()=>{save.disabled=true;try{
   const editorIds=[...list.querySelectorAll('input:checked')].map(input=>input.value);
   info=await api(`/api/courtside/matches/${encodeURIComponent(id)}/editors`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:info.version,editorIds})});
   status.textContent='작업자 권한을 저장했습니다.';
  }catch(e){status.textContent=e.message;}finally{save.disabled=false;}};
 }catch(e){status.textContent=e.message;}
}
async function loadProgress(caseId){
 if(!/^[a-z0-9-]+$/.test(caseId))return;
 const base=`/api/courtside/matches/${encodeURIComponent(id)}/cases/${encodeURIComponent(caseId)}/bridge`;
 $('workProgress').hidden=false;
 try{
  const [flow,batches]=await Promise.all([api(`${base}/api/cases/${caseId}/review-flow`),api(`${base}/api/cases/${caseId}/report-video-batches`).catch(()=>({}))]);
  const progress=workProgress(flow,batches.job);
  $('workProgressTitle').textContent=progress.title;$('workProgressStages').textContent=progress.stages;$('workProgressVideo').textContent=progress.video;
  $('workProgressLink').href=base+'/'+progress.path;$('workProgressLink').hidden=false;
 }catch{$('workProgressTitle').textContent='진행 상태를 불러오지 못했습니다.';$('workProgressStages').textContent='아래 현재 판독 작업 이어가기에서 확인하세요.';}
}
load().catch(e=>{$('status').textContent=e.message;$('uploadData').hidden=true;});
