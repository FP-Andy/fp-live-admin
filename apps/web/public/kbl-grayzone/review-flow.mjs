import {progress,nextIncomplete,nextWork,stageAllowed} from './flow-progress.mjs';
import {mountWorkSession} from './work-session.mjs';
const labels={frame:'경기·프레임',objects:'객체',joints:'관절',spatial:'2D·3D',report:'리포트'};
const order=Object.keys(labels);
function navigate(url){
 const target=new URL(url,location.href),samePage=target.pathname===location.pathname&&target.search===location.search;
 location.href=target.href;
 // A clip is in the hash. Reload the editor on same-stage links so its
 // selected frame cannot silently remain on the previously open clip.
 if(samePage)location.reload();
}
export function flowUrl(stage,caseId,eventId){const file=stage==='frame'?'workflow.html':stage==='objects'||stage==='joints'?'pose-review.html':stage==='spatial'?'reconstruction.html':'report-review.html';return `./${file}?${stage==='frame'?'case':'id'}=${encodeURIComponent(caseId)}${['objects','joints'].includes(stage)?`&stage=${stage}`:''}${eventId?'#'+eventId:''}`;}
async function request(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'단계 상태를 불러오지 못했습니다.');return d;}
export function mountFlow({stage,caseId,eventId,save,isDirty=()=>false,isBusy=()=>false,onLock=()=>{},onBlocked=()=>{},message=()=>{}}){
 const main=document.querySelector('main'),feedback=main.querySelector('.task-feedback'),work=document.createElement('div');feedback?.remove();work.className='flow-work';work.append(...main.childNodes);main.append(work);
 const head=document.createElement('section');head.className='flow-shell';
 head.innerHTML='<div class="flow-context"><a>← 경기 상세</a><span>단계별 판독 워크스페이스</span><a>영상·CSV 등록</a></div><nav class="flow-steps" aria-label="작업 단계"></nav><p class="flow-summary" role="status"></p><div class="flow-total" role="status"></div><div class="flow-clips" aria-label="전체 판독 클립 상태"></div><div class="flow-gate" hidden><p></p><a></a></div>';
 const links=head.querySelectorAll('.flow-context a');links[0].href=`./match.html?id=${encodeURIComponent(caseId)}`;links[1].href=`./workflow.html?match=${encodeURIComponent(caseId)}`;
 main.prepend(head);if(feedback)head.after(feedback);const foot=document.createElement('div');foot.className='flow-footer';foot.innerHTML='<div><b class="flow-foot-title"></b><span class="flow-foot-note"></span></div><div class="flow-buttons"><button class="secondary flow-save">현재 상태 저장</button><button class="flow-next"></button></div>';main.append(foot);
 const nav=head.querySelector('nav'),summary=head.querySelector('.flow-summary'),saveButton=foot.querySelector('.flow-save'),next=foot.querySelector('.flow-next'),gate=head.querySelector('.flow-gate');let current=null,pending=false;
 mountWorkSession({host:head,caseId,stage,eventId});
 const getEvent=()=>current?.events.find(e=>e.id===eventId());
 function render(){
  if(current?.libraryMatchId){links[0].href=`./match.html?id=${encodeURIComponent(current.libraryMatchId)}`;links[1].href=`./workflow.html?match=${encodeURIComponent(current.libraryMatchId)}`;}
  const e=getEvent(),all=current?.events||[],counts=progress(all),allowed=stageAllowed(current,stage,eventId()),locked=!!current&&!allowed;
  counts.frame=all.filter(c=>Number.isInteger(c.frameIndex)).length;
  work.hidden=!current||locked;work.inert=!current||locked;gate.hidden=!locked;
  if(locked){const targetStage=stageAllowed(current,stage)?stage:current.activeStage,target=nextIncomplete(all,targetStage);gate.querySelector('p').textContent=`${labels[targetStage]} · 클립 ${target?.number??1}부터 순서대로 진행하세요. 각 단계는 클립 1 → ${counts.total} 확인 후 다음 단계로 이어집니다.`;const a=gate.querySelector('a');a.href=flowUrl(targetStage,caseId,target?.id);a.textContent=`${labels[targetStage]} · 클립 ${target?.number??1}로 →`;a.onclick=ev=>{ev.preventDefault();navigate(a.href);};}
  nav.replaceChildren(...order.map((s,i)=>{
   const a=document.createElement('a'),open=stageAllowed(current,s),complete=s==='frame'?counts.total>0&&counts.frame===counts.total:current?.stages?.[s]?.complete;
   const number=document.createElement('b'),label=document.createElement('span');number.textContent=String(i).padStart(2,'0');label.textContent=`${labels[s]}${s in counts?` (${counts[s]}/${counts.total})`:''}${complete?' ✓':''}`;a.append(number,label);
   a.href=flowUrl(s,caseId,s==='frame'?eventId():nextIncomplete(all,s==='report'?'spatial':s)?.id||eventId());a.className=s===stage?'current':complete?'done':'';
   if(s===stage)a.setAttribute('aria-current','step');if(!open){a.classList.add('locked');a.setAttribute('aria-disabled','true');}
   a.onclick=ev=>{ev.preventDefault();if(!open||pending||isBusy()||isDirty())message(!open?'모든 클립의 앞 단계를 먼저 완료하세요.':'현재 상태를 저장한 뒤 이동하세요.');else navigate(a.href);};return a;
  }));
  summary.textContent=stage==='report'&&current?`전체 ${counts.total}개 클립 · ${current.reportReady?'PDF 생성 가능 · 납품 전 내용 확인':'앞 단계 검수 필요'}`:e?`판독 ${e.number} · ${e.quarter}Q ${e.gameClock} · F${e.frameIndex??'미선택'} | ${labels[stage]} 확인 ${counts[stage]??0}/${counts.total}`:'단계 상태를 불러오는 중입니다.';
  head.querySelector('.flow-total').textContent=current?`객체 ${counts.objects}/${counts.total} → 관절 ${counts.joints}/${counts.total} → 2D·3D ${counts.spatial}/${counts.total} · 각 단계는 클립 1 → ${counts.total} 순서로 고정됩니다.`:'전체 클립 상태 확인 중…';
  head.querySelector('.flow-clips').replaceChildren(...all.map(clip=>{
   const s=stage==='frame'?'frame':allowed&&stage!=='report'?stage:current.activeStage;
   const done=s==='frame'?Number.isInteger(clip.frameIndex):clip.stages[s]?.complete;
   const a=document.createElement('a');a.href=flowUrl(s,caseId,clip.id);a.className=clip.id===eventId()?'selected':'';if(done||s==='report'&&clip.stages.spatial?.complete)a.classList.add('complete');
   const clipOpen=stageAllowed(current,s,clip.id);if(!clipOpen){a.classList.add('locked');a.setAttribute('aria-disabled','true');}
   a.textContent=`판독 ${clip.number} · ${clip.quarter}Q ${clip.gameClock} | ${s==='report'?'단계 확인 ✓':`${labels[s]} ${done?'완료 ✓':clip.stages[s]?.ready?'확인 대기':'보정 필요'}`}`;
   a.onclick=ev=>{ev.preventDefault();if(!clipOpen)message('앞 클립부터 순서대로 확인하세요.');else if(isDirty()||isBusy()||pending)message('현재 상태를 저장한 뒤 다른 클립으로 이동하세요.');else navigate(a.href);};return a;
  }));
  const remaining=all.filter(c=>c.id!==eventId()&&!c.stages[stage]?.complete);
  foot.querySelector('.flow-foot-title').textContent=`${labels[stage]}${stage in counts?` · ${counts[stage]}/${counts.total} 클립 확인`:''}`;
  foot.querySelector('.flow-foot-note').textContent=isDirty()?'저장하지 않은 변경이 있습니다.':locked?'앞 단계의 모든 클립을 먼저 확인하세요.':e?.courtCalibrationRequired?(stage==='spatial'?'코트 좌표 보정이 필요합니다. 완료 전에는 2D·3D 확인과 PDF 추출이 제한됩니다.':`코트 좌표 보정 대기 · ${labels[stage]} 확인 후 다음 클립으로 이동할 수 있습니다. 2D·3D 완료는 코트 보정 후 가능합니다.`):e?.unresolvedSpatialIds?.length&&stage==='objects'?`공간 위치 미확인 ${e.unresolvedSpatialIds.length}명 · 객체 확인 후 2D·3D에서 보정할 수 있습니다.`:e?.unresolvedSpatialIds?.length&&stage==='spatial'?`공간 위치 확인 필요: ${e.unresolvedSpatialIds.length}명 · 위치 지정 또는 영상에만 유지`:'현재 상태 저장은 작업 보관입니다. 클립 확인 후 같은 단계의 남은 클립으로 이어집니다.';
  foot.hidden=stage==='report';saveButton.hidden=!save||stage==='report';saveButton.disabled=pending||isBusy()||!e||!allowed;
  next.hidden=stage==='report';next.textContent=stage==='frame'?'객체 단계 시작 →':remaining.length?`클립 ${e?.number??'—'} 확인 · 클립 ${remaining[0].number}로 →`:`클립 ${e?.number??'—'} 확인 · ${labels[order[order.indexOf(stage)+1]]}${stage==='spatial'?'':' 클립 1'}로 →`;
  saveButton.textContent=pending?'저장 중…':'현재 상태 저장';if(pending)next.textContent='단계 처리 중…';
  next.disabled=pending||isBusy()||!e||!allowed||(stage==='frame'&&!current?.stages?.objects?.available);
 }
 async function refresh(){try{current=await request(`/api/cases/${caseId}/review-flow`);render();return current;}catch(e){summary.textContent=`단계 상태를 불러오지 못했습니다: ${e.message}`;throw e;}}
 async function run(action){if(pending||isBusy()||!stageAllowed(current,stage,eventId()))return;pending=true;onLock(true);render();try{await action();}catch(e){message(e.message);}finally{pending=false;onLock(false);render();}}
 saveButton.onclick=()=>run(async()=>{await save();await refresh();message('현재 클립을 저장했습니다. 단계 확인은 아직 하지 않았습니다.');});
 next.onclick=()=>run(async()=>{
  if(stage==='frame'){navigate(flowUrl('objects',caseId,nextIncomplete(current.events,'objects')?.id||eventId()));return;}
  message('현재 클립을 저장하고 확인합니다…');if(save)await save();await refresh();const s=getEvent()?.stages[stage];
  if(!s?.available)throw Error('모든 클립의 앞 단계를 먼저 완료하세요.');
  if(stage==='spatial'&&getEvent()?.unresolvedSpatialIds?.length&&!getEvent()?.courtCalibrationRequired){
   const detail=onBlocked(getEvent());
   throw Error(detail||`공간 위치가 미확정인 ${getEvent().unresolvedSpatialIds.length}명의 발 접점을 보정하거나 영상에만 유지로 지정하세요.`);
  }
  await request(`/api/cases/${caseId}/events/${eventId()}/review-flow`,{stage,token:s.token});await refresh();const target=nextWork(current,stage);navigate(flowUrl(target.stage,caseId,target.eventId));
 });
 render();return {refresh,update:render,get current(){return current;},get available(){return stageAllowed(current,stage,eventId());}};
}
