const spatialUrl=(caseId,eventId)=>`./reconstruction.html?id=${encodeURIComponent(caseId)}#${encodeURIComponent(eventId)}`;

export function mountReportVideoBox({caseId,api,onChange,onComplete,onPrepared}){
 const $=id=>document.getElementById(id), check=$('includeVideos'),list=$('videoReadyList'),progress=$('reportVideoProgress');
 let ready=null,checking=false,preparing=false,job=null,timer=null;
 const path=`/api/cases/${encodeURIComponent(caseId)}`;
 const running=()=>!!job&&['queued','running'].includes(job.state);
 function buttonState(){check.disabled=running()||preparing;$('checkVideoReady').disabled=checking||running()||preparing;onChange();}
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
  progress.append(p(job.stage||'제작 상태 확인 중'));
  if(job.report){const delivery=job.report.delivery;progress.append(p(delivery?.state==='complete'?'PDF · 전달 폴더 저장됨':`PDF · ${delivery?.message||'전달 저장 상태 확인 필요'}`));}
  for(const row of job.videos||[]){
   const number=row.eventId.replace('review-','');let text=`${number}번 영상 · `;
   if(row.state==='complete'){const delivery=row.result?.delivery;text+=delivery?.state==='complete'?'전달 폴더 저장됨':delivery?.state==='ready-for-download'?'다운로드 준비됨':`제작 완료 · 전달 저장 실패: ${delivery?.message||'상태 확인 필요'}`;}
   else text+=row.error||'제작 실패';
   const line=p(text);if(row.state==='complete'&&/^[a-f0-9]{24}$/.test(row.jobId||'')){const a=document.createElement('a');a.href=`/case-review-video/${encodeURIComponent(caseId)}/${encodeURIComponent(row.eventId)}/${row.jobId}.mp4`;a.textContent=' 영상 내려받기 ↗';line.append(a);}else if(row.state!=='complete'){const a=document.createElement('a');a.href=spatialUrl(caseId,row.eventId);a.textContent=' 장면 확인 →';line.append(a);}progress.append(line);
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
 async function prepareScene(row){
  const token=crypto.randomUUID(),frame=document.createElement('iframe');
  frame.title=`판독 ${row.number} 자동 자세 보정`;frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;
  frame.style.cssText='position:fixed;left:-10000px;top:0;width:1280px;height:900px;opacity:0;pointer-events:none;border:0';
  frame.src=`./reconstruction.html?id=${encodeURIComponent(caseId)}&autoPrepare=${encodeURIComponent(token)}#${encodeURIComponent(row.eventId)}`;
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>finish(new Error(`${row.number}번 장면의 자동 보정 시간이 초과됐습니다.`)),30*60*1000);
   function finish(error,value){clearTimeout(timeout);window.removeEventListener('message',receive);frame.remove();error?reject(error):resolve(value);}
   function receive(e){if(e.origin!==location.origin||e.source!==frame.contentWindow||e.data?.token!==token||e.data?.caseId!==caseId)return;
    if(e.data.type==='kbl-auto-pose-ready')frame.contentWindow.postMessage({type:'kbl-auto-pose-start',token},location.origin);
    else if(e.data.type==='kbl-auto-pose-complete')finish(null,e.data);
    else if(e.data.type==='kbl-auto-pose-error')finish(new Error(`${row.number}번 · ${e.data.error}`));
   }
   window.addEventListener('message',receive);document.body.append(frame);
  });
 }
 async function restore(){try{const r=await api(path+'/report-video-batches');if(r.job){job=r.job;renderJob();buttonState();if(running())poll();}}catch(e){progress.replaceChildren(p('영상 제작 상태를 확인하지 못했습니다. '+e.message));}}
 return {selected:()=>check.checked,canGenerate:()=>!running()&&!preparing&&(!check.checked||(!checking&&!!ready?.ready)),
  async start(revision){if(!ready?.ready)throw Error('영상 제작 준비 상태를 확인하세요.');
   preparing=true;buttonState();
   try{
    let editorial=await api(path+'/report-editorial');
    const pending=ready.events.filter(e=>e.autoPrepare);
    for(let i=0;i<pending.length;i++){
     const row=pending[i];progress.replaceChildren(p(`자세 자동 보정 ${i+1}/${pending.length} · ${row.number}번 장면`),p('보정이 끝날 때까지 이 화면을 열어 두세요.'));
     const result=await prepareScene(row);
     const finalized=await api(path+`/events/${row.eventId}/auto-pose-finalize`,{previousCaptureId:result.previousCaptureId,captureId:result.captureId,version:editorial.version});
     if(!finalized.carried){const line=p(`${row.number}번 · ${finalized.reason} `),a=document.createElement('a');a.href=spatialUrl(caseId,row.eventId);a.textContent='장면 확인 →';line.append(a);progress.replaceChildren(line);throw Error(finalized.reason);}
     editorial=await api(path+'/report-editorial');
    }
    await onPrepared();
    job=(await api(path+'/report-video-batches',{revision,events:ready.events.map(e=>e.eventId)})).job;
    renderJob();clearTimeout(timer);poll();
   }catch(error){await onPrepared();throw error;}
   finally{preparing=false;buttonState();}
  },restore};
}
