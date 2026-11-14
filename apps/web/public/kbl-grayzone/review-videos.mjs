// The standard video must use the same improved mesh as spatial analysis.
// Explicit source/refit comparison modes remain separate, labelled workflows.
export async function submitReviewVideo({mode,ensureSharedPose,submit}){
 if(mode==='map')await ensureSharedPose();
 return submit(mode==='map'?{action:'create'}:{action:'create',playerOrientation:mode});
}
export function mountReviewVideos({caseId,getEvent,hasUnsaved,isBusy,ensureSharedPose}){
 const output=document.getElementById('reviewVideos'),refreshButton=document.getElementById('refreshVideos'),create=document.getElementById('createVideo'),refit=document.getElementById('createRefitVideo'),panel=document.getElementById('videoPanel');let timer=null,pending=false,available=false;
 async function refresh(){
  if(pending)return;pending=true;refreshButton.disabled=true;
  try{
   const response=await fetch(`/api/cases/${encodeURIComponent(caseId)}/review-videos`,{cache:'no-store'});if(!response.ok)throw Error('영상 상태를 불러오지 못했습니다.');
   const data=await response.json();const current=data.renderVersion==='courtside-cpu-video-v5-mannequin';available=data.renderAvailable&&current;output.replaceChildren();let running=false;
   if(!available){const note=document.createElement('p');note.textContent=current?'이 작업 서버에서는 영상 제작이 비활성화돼 있습니다.':'영상 제작 서버 버전을 확인하세요. 저장된 장면은 유지됩니다.';output.append(note);}
   for(const event of data.events){
    const row=document.createElement('p');row.append(document.createTextNode(`${event.number}번 장면 · `));
    if(!event.items.length&&!event.jobs.length)row.append(document.createTextNode('저장된 영상 없음'));
    for(const item of event.items){
     if(item.state==='ready'){const link=document.createElement('a');link.href=item.download;link.textContent=item.poseMode==='refit'?'자세 보정 비교 영상 다운로드':'영상 다운로드';link.download='';row.append(link);if(item.playerOrientation==='source')row.append(document.createTextNode(' (선수 중계 자세 시범)'));if(item.fallbackPeople?.length)row.append(document.createTextNode(` (기본 자세: ${item.fallbackPeople.join(', ')})`));if(item.positionOnlyPeople?.length)row.append(document.createTextNode(` (${item.positionOnlyRepresentation==='neutral-standing-assumption'?'광각 심판 기본 자세·시점 가정':'광각 위치 표식만'}: ${item.positionOnlyPeople.join(', ')})`));}
     else row.append(document.createTextNode(item.state==='stale'?(item.message||'장면 검수 후 재제작 필요'):'영상 파일 확인 필요'));
     row.append(document.createTextNode(' '));
    }
    const job=event.jobs?.[0];if(job){const ready=event.items.some(x=>x.id===job.jobId&&x.state==='ready');const state=job.state==='complete'?(ready?'완료':'결과 확인 필요'):job.state==='failed'||job.state==='interrupted'?'실패 · 다시 만들기 가능':job.stage||'대기';row.append(document.createTextNode(` · ${state}`));if(job.progress?.total)row.append(document.createTextNode(` ${job.progress.completed}/${job.progress.total}`));if(job.error)row.append(document.createTextNode(` · ${job.error}`));if(job.result?.delivery?.state==='complete')row.append(document.createTextNode(' · 아이탑 전달 폴더 저장됨'));if(job.result?.delivery?.state==='ready-for-download')row.append(document.createTextNode(' · 다운로드 준비됨'));if(job.result?.delivery?.state==='failed')row.append(document.createTextNode(` · 전달 폴더 저장 실패: ${job.result.delivery.message}`));if(['queued','running'].includes(job.state))running=true;}
    output.append(row);
   }
   if(running&&panel.open)timer=setTimeout(refresh,4000);
  }catch(error){output.textContent=error.message||'영상 상태를 확인하지 못했습니다.';}
  finally{pending=false;refreshButton.disabled=false;create.disabled=!available;refit.disabled=!available;}
 }
 refreshButton.addEventListener('click',()=>{clearTimeout(timer);refresh();});
 panel.addEventListener('toggle',()=>{clearTimeout(timer);if(panel.open)refresh();});
 async function submit(mode){
  const event=getEvent();if(!event){output.textContent='판독 장면을 먼저 선택하세요.';return;}if(hasUnsaved()||isBusy()){output.textContent='수정 중인 내용을 현재 상태 저장한 뒤 영상 제작을 눌러 주세요.';return;}
  create.disabled=true;refit.disabled=true;output.textContent='영상 제작을 등록하고 있습니다.';
  try{await submitReviewVideo({mode,ensureSharedPose,submit:async request=>{const response=await fetch(`/api/cases/${encodeURIComponent(caseId)}/events/${encodeURIComponent(event)}/video-jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});const data=await response.json();if(!response.ok)throw Error(data.error||'영상 제작을 시작하지 못했습니다.');return data;}});await refresh();}
  catch(error){output.textContent=error.message||'영상 제작을 시작하지 못했습니다.';create.disabled=!available;refit.disabled=!available;}
 }
 create.addEventListener('click',()=>submit(document.getElementById('playerVideoOrientation').value));
 refit.addEventListener('click',()=>submit('refit'));
}
