import {mountGpuControl} from './gpu-control.mjs';
import {taskElapsedSeconds} from './task-duration.mjs';
// Shared support/progress surface. Counts come from work records, never elapsed-time estimates.
const clean=value=>String(value??'').replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]').replace(/((?:api[_-]?key|token|password|authorization|secret)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&},]+)/gi,'$1"[REDACTED]"').replace(/\b(?:rf_[A-Za-z0-9]{15,}|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g,'[REDACTED]').slice(0,12000);
const logs=[];let task=null,started=null;
export function currentTaskState(){return task?.state||null;}
const host=document.createElement('section');host.className='task-feedback';host.setAttribute('aria-label','처리 진행과 오류 기록');
host.innerHTML='<details class="task-progress" hidden open><summary><strong>작업 진행</strong><span class="task-label" role="status"></span></summary><progress max="100"></progress><p class="task-count"></p></details><details class="task-errors" hidden><summary>오류 기록 · 지원용 로그</summary><p>현재 단계·작업 ID·오류 정보를 복사해 전달할 수 있습니다. 인증 키와 원본 영상은 포함하지 않습니다.</p><button type="button" class="secondary">오류 로그 복사</button><span role="status"></span><textarea readonly rows="9" aria-label="복사할 오류 로그"></textarea></details>';
const main=document.querySelector('main')||document.body;const anchor=main.querySelector('.flow-shell,.heading,.title');if(anchor)anchor.after(host);else main.prepend(host);
const style=document.createElement('style');style.textContent='.task-feedback{margin:20px 0}.task-progress{border:1px solid #e3e7ed;border-left:4px solid #f34d0b;padding:16px 20px;border-radius:8px;background:#fafbfc}.task-progress summary{cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap;list-style:none}.task-progress summary::-webkit-details-marker{display:none}.task-progress summary::after{content:"▾";margin-left:auto;color:#667084}.task-progress:not([open]) summary::after{content:"▸"}.task-label{display:block;font-size:13px}.task-progress progress{width:100%;accent-color:#f34d0b}.task-count{font-size:13px;color:#667084;margin:8px 0 0}.task-errors{border:1px solid #e5b09a;background:#fff8f4;padding:16px;border-radius:8px}.task-errors summary{cursor:pointer;color:#a93c16}.task-errors textarea{display:block;width:100%;margin-top:12px;font:12px/1.5 monospace;max-height:220px}.task-errors button{margin-right:12px}';document.head.append(style);
const gpuControl=mountGpuControl(document.querySelector('#status')||host);
const progress=host.querySelector('.task-progress'),label=host.querySelector('.task-label'),bar=host.querySelector('progress'),count=host.querySelector('.task-count'),details=host.querySelector('.task-errors'),logText=host.querySelector('textarea'),copyState=host.querySelector('.task-errors span');
try{progress.open=sessionStorage.getItem('kbl-task-progress-collapsed')!=='1';}catch{}
progress.addEventListener('toggle',()=>{try{sessionStorage.setItem('kbl-task-progress-collapsed',progress.open?'0':'1');}catch{}});
export function recordError(error,context={}){
 const row={at:new Date().toISOString(),page:location.pathname+location.search+location.hash,message:clean(error?.message||error),...context};
 if(row.message.includes('사용자 요청으로 T4가 중지'))gpuControl.show();
 const previous=logs.at(-1);if(previous&&previous.message===row.message&&previous.endpoint===row.endpoint&&Date.parse(row.at)-Date.parse(previous.at)<5000)return;
 logs.push(row);if(logs.length>12)logs.shift();details.hidden=false;details.open=true;
 logText.value=clean(JSON.stringify({application:'KBL COURTSIDE',errors:logs},null,2));
}
host.querySelector('button').onclick=async()=>{try{await navigator.clipboard.writeText(logText.value);copyState.textContent='오류 로그를 복사했습니다.';}catch{logText.focus();logText.select();copyState.textContent='선택한 로그를 ⌘C 또는 Ctrl+C로 복사하세요.';}};
function showTask(value,key){
 if(!value?.state)return;const active=['running','queued','preparing','submitted','receiving'].includes(value.state),ended=['complete','failed','interrupted','needs-review'].includes(value.state);if(!active&&!ended)return;
 if(!task||task.key!==key||started===null){const parsed=Date.parse(value.startedAt||value.createdAt||value.attemptStartedAt||'');started=Number.isFinite(parsed)?parsed:null;}task={...value,key};progress.hidden=false;renderTask();
 if(value.error)recordError(value.error,{endpoint:key,jobId:value.jobId,stage:value.stage,progress:value.progress});
}
function renderTask(){
 if(!task)return;const p=task.progress||task.currentProgress||{},done=task.state==='complete',failed=['failed','interrupted'].includes(task.state),age=taskElapsedSeconds(task,started);
 label.textContent=task.stage||p.phase||(done?'작업 완료':failed?'작업 확인 필요':'처리 중');
 const known=Number.isFinite(p.completed)&&p.total>0;
 if(done)bar.value=100;else if(known)bar.value=Math.max(0,Math.min(100,p.completed/p.total*100));else bar.removeAttribute('value');
 const parts=[];if(task.total)parts.push(`장면 ${task.completed||0}/${task.total}`);if(known)parts.push(`${p.phase||'현재 단계'} ${p.completed}/${p.total}${p.unit||'개'} · ${(p.completed/p.total*100).toFixed(0)}%`);else if(!done)parts.push(task.state==='queued'?'작업 순서 대기':'현재 단계 수량 집계 대기');
 if(age!==null)parts.push(`경과 ${Math.floor(age/60)}분 ${String(age%60).padStart(2,'0')}초`);if(p.updatedAt&&!done){const silent=Math.floor((Date.now()-Date.parse(p.updatedAt))/1000);if(silent>15)parts.push(`마지막 갱신 ${silent}초 전`);}if(done)parts.push('완료');if(failed)parts.push('저장한 작업에서 재시도 가능');count.textContent=parts.join(' · ');
}
setInterval(renderTask,1000);
const nativeFetch=window.fetch.bind(window);
window.fetch=async(input,options)=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href),isApi=url.origin===location.origin&&url.pathname.startsWith('/api/')&&!url.pathname.endsWith('/work-sessions'),method=options?.method||input?.method||'GET';
 try{
  const response=await nativeFetch(input,options);
  if(isApi&&(!response.ok||/\/api\/(?:intake\/[a-f0-9]+$|pose-jobs\/|report-jobs\/|cases\/[^/]+\/(?:events\/review-\d+\/pose|report-jobs)$)/.test(url.pathname))){
   try{const data=await response.clone().json();if(!response.ok)recordError(data.error||`HTTP ${response.status}`,{endpoint:url.pathname,httpStatus:response.status,method,diagnostics:data.diagnostics});
    const job=data.pose?.job||data.processing||data.job||(data.jobId?data:null);if(job)showTask(job,data.pose?.jobId||job.jobId||url.pathname);
   }catch(e){if(!response.ok)recordError(`HTTP ${response.status} · 응답 내용을 읽지 못했습니다.`,{endpoint:url.pathname,method});}
  }
  return response;
 }catch(e){if(isApi)recordError(e,{endpoint:url.pathname,method,httpStatus:null});throw e;}
};
window.addEventListener('error',e=>recordError(e.error||e.message,{source:clean(e.filename),line:e.lineno}));
window.addEventListener('unhandledrejection',e=>recordError(e.reason));

const gpuStyle=document.createElement('style');gpuStyle.textContent='.gpu-control{margin:18px 0;padding:18px 20px;border:1px solid #edc2af;border-left:4px solid #f34d0b;border-radius:8px;background:#fff8f4}.gpu-control p{margin:8px 0;font-size:13px}.gpu-control button{margin:5px 0}.gpu-control .gpu-note{color:#667084}';document.head.append(gpuStyle);
