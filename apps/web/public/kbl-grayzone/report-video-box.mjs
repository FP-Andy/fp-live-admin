const spatialUrl=(caseId,eventId)=>`./reconstruction.html?id=${encodeURIComponent(caseId)}#${encodeURIComponent(eventId)}`;

export function mountReportVideoBox({caseId,api,onChange,onComplete,getRevision=()=>null,getTotal=()=>0,canRetry=()=>false}){
 const $=id=>document.getElementById(id), check=$('includeVideos'),list=$('videoReadyList'),progress=$('reportVideoProgress');
 let ready=null,checking=false,preparing=false,restoring=true,job=null,timer=null;
 const path=`/api/cases/${encodeURIComponent(caseId)}`;
 const running=()=>!!job&&['queued','running'].includes(job.state);
 function buttonState(){check.disabled=restoring||running()||preparing;$('checkVideoReady').disabled=restoring||checking||running()||preparing;onChange();}
 function p(text){const el=document.createElement('p');el.textContent=text;return el;}
 function readinessView(){
  list.replaceChildren();if(!ready)return;
  const automatic=ready.events.filter(x=>x.autoPrepare).length;
  list.append(p(ready.ready?(automatic?`${automatic}개 장면은 제작 시 자동으로 자세를 보정합니다.`:'모든 장면의 영상 제작 준비가 됐습니다.'):`영상 준비 ${ready.events.filter(x=>x.ready).length}/${ready.events.length}장면`));
  for(const row of ready.events.filter(x=>!x.ready)){
   const line=p(`${row.number}번 · ${row.message} `),a=document.createElement('a');
   a.href=spatialUrl(caseId,row.eventId);a.textContent='공간 검수에서 확인 →';line.append(a);list.append(line);
  }
 }
 async function refresh(){
  checking=true;buttonState();list.replaceChildren(p('영상 제작 준비 상태를 확인하고 있습니다.'));
  try{ready=await api(path+'/report-video-readiness');readinessView();}
  catch(e){ready=null;list.replaceChildren(p(e.message));}
  finally{checking=false;buttonState();}
 }
 function renderJob(){
  progress.replaceChildren();if(!job)return;
  const subset=Number(getTotal())>0&&Array.isArray(job.events)&&job.events.length<Number(getTotal());
  progress.append(p(subset&&job.state==='complete'?`선택한 ${job.events.length}개 장면 제작 완료`:job.stage||'제작 상태 확인 중'));
  if(running()&&Array.isArray(job.events)){
   const finished=new Set((job.videos||[]).map(row=>row.eventId));
   const waiting=job.events.filter(event=>!finished.has(event)&&event!==job.currentEvent);
   if(job.currentEvent)progress.append(p(`${job.currentEvent.replace('review-','')}번 장면 제작 중`));
   if(waiting.length)progress.append(p(`제작 대기 · ${waiting.map(event=>event.replace('review-','')+'번').join(' → ')}`));
  }
  if(job.reportNeedsRefresh)progress.append(p('PDF는 이전 입력 기준이거나 생성이 완료되지 않았습니다. 최신 코멘트를 저장한 뒤 PDF를 다시 생성하세요.'));
  else if(job.report){const delivery=job.report.delivery;progress.append(p(delivery?.state==='complete'?'PDF · 전달 폴더 저장됨':`PDF · ${delivery?.message||'전달 저장 상태 확인 필요'}`));}
  if(job.reportIssue)progress.append(p('PDF · '+job.reportIssue));
  for(const row of job.videos||[]){
   const number=row.eventId.replace('review-','');let text=`${number}번 영상 · `;
   if(row.state==='complete'){const delivery=row.result?.delivery;text+=delivery?.state==='complete'?'전달 폴더 저장됨':delivery?.state==='ready-for-download'?'다운로드 준비됨':`제작 완료 · 전달 저장 실패: ${delivery?.message||'상태 확인 필요'}`;}
   else text+=row.error||'제작 실패';
   const line=p(text);if(row.state==='complete'&&/^[a-f0-9]{24}$/.test(row.jobId||'')){const a=document.createElement('a');a.href=`/case-review-video/${encodeURIComponent(caseId)}/${encodeURIComponent(row.eventId)}/${row.jobId}.mp4`;a.textContent=' 영상 내려받기 ↗';line.append(a);}else if(row.state!=='complete'){
    const a=document.createElement('a');a.href=spatialUrl(caseId,row.eventId);a.textContent=' 장면 확인 →';line.append(a);
   }progress.append(line);
  }
  // A retry becomes the latest batch. Include all failed or unstarted scenes so
  // retrying one cannot hide another failure; never rerun a stale or completed scene.
  if(!running()&&Array.isArray(job.events)){
   const rows=new Map((job.videos||[]).map(row=>[row.eventId,row]));
   const retryEvents=job.events.filter(event=>/^review-\d+$/.test(event)&&(!rows.has(event)||['failed','interrupted'].includes(rows.get(event).state)));
   if(retryEvents.length){const retry=document.createElement('button');retry.type='button';retry.textContent=`미완료 영상 ${retryEvents.length}개 다시 제작`;retry.disabled=preparing;
    retry.onclick=async()=>{if(running()||preparing)return;if(!canRetry()){progress.append(p('저장하지 않은 입력과 현재 장면 상태를 확인하세요.'));return;}try{await startEvents(getRevision(),retryEvents);}catch(e){progress.append(p(e.message));}};progress.append(retry);}
  }
  if(job.error)progress.append(p(job.error));
 }
 async function poll(){
  if(!job)return;
  try{job=(await api(path+'/report-video-batches/'+job.jobId)).job;renderJob();buttonState();
   if(running())timer=setTimeout(poll,4000);else if(job.report)await onComplete(job);
  }catch(e){progress.replaceChildren(p('제작 상태를 불러오지 못했습니다. '+e.message));timer=setTimeout(poll,10000);}
 }
 check.onchange=()=>{if(check.checked)refresh();else buttonState();};
 $('checkVideoReady').onclick=refresh;
 async function restore(){try{const r=await api(path+'/report-video-batches');if(r.job){job=r.job;renderJob();if(running())poll();}}catch(e){progress.replaceChildren(p('영상 제작 상태를 확인하지 못했습니다. '+e.message));}finally{restoring=false;buttonState();}}
 async function startEvents(revision,events){
   if(!Number.isInteger(revision))throw Error('경기 상태를 다시 불러온 뒤 시도하세요.');
   preparing=true;buttonState();
   try{
    const existing=await api(path+'/report-video-batches');
    if(existing.job&&['queued','running'].includes(existing.job.state)){job=existing.job;renderJob();clearTimeout(timer);poll();return;}
    job=(await api(path+'/report-video-batches',{revision,events})).job;
    renderJob();clearTimeout(timer);poll();
   }catch(error){
    // A gateway can drop the response after the server accepted the request.
    // Recover the existing batch before allowing another click.
    try{const existing=await api(path+'/report-video-batches');if(existing.job&&['queued','running'].includes(existing.job.state)){job=existing.job;renderJob();clearTimeout(timer);poll();return;}}catch{}
    throw error;
   }
   finally{preparing=false;buttonState();}
 }
 return {selected:()=>check.checked,isRunning:()=>running()||preparing,canGenerate:()=>!restoring&&!running()&&!preparing&&(!check.checked||(!checking&&!!ready?.ready)),
  async start(revision){if(!ready?.ready)throw Error('영상 제작 준비 상태를 확인하세요.');return startEvents(revision,ready.events.map(e=>e.eventId));},restore};
}
