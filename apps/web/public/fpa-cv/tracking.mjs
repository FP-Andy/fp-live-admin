import {uploadLibrary} from './upload-library.mjs';
import {preflight} from './preflight.mjs';
const $=id=>document.getElementById(id);
const active=new Set(['queued','starting','running','cancelling']);
const states={ready:'초기 설정 완료',queued:'대기',starting:'준비 중',running:'분석 중',cancelling:'중지 중',cancelled:'취소됨',interrupted:'중단됨',failed:'실패',completed:'완료'};
const sizeText=n=>n>1024**3?`${(n/1024**3).toFixed(1)} GB`:`${(n/1024**2).toFixed(1)} MB`;
const durationText=n=>{if(!Number.isFinite(n))return '계산 중';const seconds=Math.max(0,Math.ceil(n));return seconds<60?`${seconds}초`:`${Math.floor(seconds/60)}분 ${seconds%60}초`;};
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
async function api(path,options){const response=await fetch(path,options);let value;try{value=await response.json();}catch{throw Error('서버 응답을 확인하지 못했습니다.');}if(!response.ok)throw Error(value.detail||'요청을 처리하지 못했습니다.');return value;}
const post=(path,value={})=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});

export function trackingUI({openJob}){
 let file=null,url=null,busy=false,xhr=null,caps=null,jobSignature='',opening=null,uploaded=null,preparingId=null,aborted=false,sourceDuration=NaN,playable=true,needOriginalFrame=false;
 const video=$('tracking-preview');
 const pendingJobs=new Set();
 const syncRange=()=>{
  const entire=$('tracking-entire').checked;
  $('tracking-range').hidden=entire;
  $('tracking-to').disabled=entire;
 };
 const setDuration=duration=>{
  sourceDuration=duration;
  // Keep millisecond controls and their limits at the same display precision.
  // Frame-decoded duration may differ slightly from the browser's metadata.
  for(const id of ['initial-frame-time','tracking-from','tracking-to'])$(id).max=duration.toFixed(3);
 };
 const status=(message,error=false)=>{for(const id of ['tracking-message','initial-frame-status']){$(id).textContent=message;$(id).classList.toggle('error',error);}};
 const updateReady=()=>{
  const start=calibration.time();
  $('tracking-from').value=Number.isFinite(start)?start.toFixed(3):'';
  $('tracking-to').min=Number.isFinite(start)?start.toFixed(3):'0';
  const deviceReady=caps?.ready&&($('tracking-device').value!=='gpu'||caps.gpu);
  $('start-tracking').disabled=busy||!file||!deviceReady||calibration.issues().length>0;
  $('detect-initial-frame').disabled=busy||!file||!deviceReady;
  $('preflight-check').hidden=!file;
  if(needOriginalFrame&&deviceReady&&!busy){needOriginalFrame=false;queueMicrotask(()=>$('detect-initial-frame').click());}
  $('gpu-status').textContent=caps?.checking?'GPU 확인 중':caps?.ready?caps.gpuLabel||'GPU 없음 · CPU 선택 가능':'분석 환경 확인 필요';
  $('execution-mode').textContent=caps?.execution==='aws'?'AWS GPU 분석':'로컬 작업';
  const note=document.querySelector('#tracking-form .tracking-small-note');if(note)note.textContent=caps?.uploadStorage==='s3'?'경기별 설정을 모두 저장한 뒤 일괄 분석을 시작하세요. 초기 장면 검출과 본 분석은 GPU 한 대를 순서대로 사용합니다.':caps?.execution==='aws'?'영상 전송 후 브라우저를 닫아도 분석은 계속됩니다.':'영상은 이 컴퓨터에서 분석합니다. 다른 탭에서 작업하는 동안에도 분석은 계속됩니다.';
  library.enable(caps?.uploadStorage==='s3');
  $('start-tracking').textContent=caps?.uploadStorage==='s3'?'초기 설정 저장 · 분석 준비':'초기 설정 확정 · 트래킹 시작';
  $('tracking-device').options[0].textContent=caps?.gpuLabel?`${caps.gpuLabel} · 자동 선택`:'GPU · 자동 선택';
 };
 const library=uploadLibrary({api,post,select:chooseUploaded,status});
 $('library-files').onchange=event=>{library.add([...event.target.files]);event.target.value='';};
 const calibration=preflight({video,status,change:updateReady,isBusy:()=>busy});
 calibration.reset();
 function choose(next){
  if(busy||!next)return;
  if(!/\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(next.name)){status('MP4, MOV, M4V, AVI, MKV 또는 WebM 영상을 선택하세요.',true);return;}
  if(next.size>(caps?.maxUploadBytes||20*1024**3)){status('영상은 20GB 이하로 선택하세요.',true);return;}
  if(url)URL.revokeObjectURL(url);
  file=next;uploaded=null;sourceDuration=NaN;playable=true;needOriginalFrame=false;$('initial-frame-time').value='0';url=URL.createObjectURL(next);calibration.reset();
  $('tracking-file-name').textContent=next.name;$('tracking-file-size').textContent=sizeText(next.size);
  $('tracking-preview-wrap').hidden=false;$('tracking-empty').hidden=true;
  video.src=url;video.load();$('tracking-upload-progress').hidden=true;status('');
 }
 async function chooseUploaded(next){
  if(busy){status('현재 초기 장면 검출이 끝난 뒤 다른 영상을 선택하세요.',true);return;}
  if(file&&uploaded?.id!==next.id&&Number.isFinite(calibration.time())&&!confirm('저장하지 않은 초기 설정을 닫고 다른 영상을 여시겠어요?'))return;
  if(url)URL.revokeObjectURL(url);url=null;file=next;uploaded=next;sourceDuration=NaN;playable=true;needOriginalFrame=false;
  $('initial-frame-time').value='0';calibration.reset();$('tracking-file-name').textContent=next.name;$('tracking-file-size').textContent=sizeText(next.size);
  $('tracking-preview-wrap').hidden=false;$('tracking-empty').hidden=true;video.src=`/api/tracking/uploads/${next.id}/source`;video.load();status('코트와 초기 13명을 지정한 뒤 초기 설정을 저장하세요.');
 }
 $('tracking-video-file').addEventListener('change',event=>{if(caps?.uploadStorage==='s3'){library.add([...event.target.files]);event.target.value='';}else choose(event.target.files[0]);});
 for(const name of ['dragenter','dragover'])$('tracking-drop').addEventListener(name,event=>{event.preventDefault();$('tracking-drop').classList.add('dragging');});
 for(const name of ['dragleave','drop'])$('tracking-drop').addEventListener(name,event=>{event.preventDefault();$('tracking-drop').classList.remove('dragging');if(name==='drop'){if(caps?.uploadStorage==='s3')library.add([...event.dataTransfer.files]);else choose(event.dataTransfer.files[0]);}});
 video.addEventListener('loadedmetadata',()=>{
  if(!file)return;setDuration(video.duration);playable=true;
  $('tracking-preview-stage').style.aspectRatio=`${video.videoWidth}/${video.videoHeight}`;
  $('tracking-file-size').textContent=`${sizeText(file.size)} · ${video.videoWidth} × ${video.videoHeight} · ${durationText(video.duration)}`;
  $('tracking-to').value=video.duration.toFixed(3);updateReady();
 });
 video.addEventListener('error',()=>{if(file){playable=false;needOriginalFrame=true;status('원본에서 초기 장면을 불러옵니다. 재생 대신 장면 시각으로 이동할 수 있습니다.');}updateReady();});
 video.addEventListener('timeupdate',()=>{if(playable&&!Number.isFinite(calibration.time()))$('initial-frame-time').value=video.currentTime.toFixed(3);});
 $('initial-frame-time').onchange=()=>{const time=Number($('initial-frame-time').value);if(playable&&Number.isFinite(time)&&time>=0&&time<sourceDuration)video.currentTime=time;};
 $('tracking-device').addEventListener('change',updateReady);
 $('tracking-entire').addEventListener('change',syncRange);
 syncRange();
 const upload=selected=>new Promise((resolve,reject)=>{
  const request=new XMLHttpRequest();xhr=request;request.open('POST',`/api/tracking/uploads?name=${encodeURIComponent(selected.name)}`);request.setRequestHeader('Content-Type','application/octet-stream');
  request.upload.onprogress=event=>{if(event.lengthComputable){const percent=event.loaded/event.total*100,label=`영상 전송 ${percent.toFixed(1)}% · ${sizeText(event.loaded)} / ${sizeText(event.total)}`;$('upload-progress').value=percent;$('upload-label').textContent=label;$('detect-initial-frame').textContent=`영상 전송 ${percent.toFixed(1)}%`;status(label);}};
  request.upload.onload=()=>{if(busy){status('영상 전송 완료 · 서버 저장을 확인하고 있습니다.');$('detect-initial-frame').textContent='전송 확인 중…';}};
  request.onload=()=>{xhr=null;try{const value=JSON.parse(request.responseText);if(request.status>=400)throw Error(value.detail||'영상 전송 실패');resolve(value);}catch(error){reject(error);}};
  request.onerror=()=>reject(Error('분석 서버 연결을 확인하세요.'));request.onabort=()=>reject(Error('영상 전송을 취소했습니다.'));request.send(selected);
 });
 const setBusy=value=>{busy=value;$('tracking-fields').disabled=value;$('tracking-video-file').disabled=value;$('tracking-upload-progress').hidden=!value;if(!value)$('detect-initial-frame').textContent='이 장면에서 선수 찾기';updateReady();};
 $('cancel-upload').onclick=async()=>{aborted=true;xhr?.abort();if(preparingId)try{await post(`/api/tracking/jobs/${preparingId}/cancel`);}catch(error){status(error.message,true);}};
 $('detect-initial-frame').onclick=async()=>{
  if(busy||!file)return;video.pause();const time=Number($('initial-frame-time').value);if(!Number.isFinite(time)||time<0){status('장면 시각을 확인하세요.',true);return;}aborted=false;setBusy(true);$('cancel-upload').hidden=false;$('cancel-upload').textContent='취소';status(playable?'선택한 장면의 선수를 찾고 있습니다.':'원본 영상을 전송하고 초기 장면을 준비합니다. 준비 후 장면 시각으로 이동할 수 있습니다.');
  try{
   if(!uploaded){
    $('detect-initial-frame').textContent='연결 확인 중…';$('upload-progress').value=0;$('upload-label').textContent='분석 서버 연결 확인';status('분석 서버 연결을 확인한 뒤 영상을 전송합니다.');
    if(caps?.execution==='aws')await post('/api/tracking/uploads/check');
    if(aborted)throw Error('초기 장면 검출을 취소했습니다.');
    $('detect-initial-frame').textContent='영상 전송 0.0%';status(`영상 ${sizeText(file.size)} 전송 중 · 전송이 끝나면 이 장면의 선수를 찾습니다.`);
    uploaded=await upload(file);
   }
   if(aborted)throw Error('초기 장면 검출을 취소했습니다.');
   $('detect-initial-frame').textContent='선수 찾는 중…';status('영상 전송 완료 · 선택한 장면의 선수를 찾고 있습니다.');
   const job=await post('/api/tracking/preparations',{uploadId:uploaded.id,time,device:$('tracking-device').value});preparingId=job.id;
   if(aborted)await post(`/api/tracking/jobs/${job.id}/cancel`);
   let result=job;
   while(active.has(result.status)){$('upload-progress').value=result.progress||0;$('upload-label').textContent=result.status==='queued'?'초기 장면 검출 대기':result.stage;status($('upload-label').textContent);await new Promise(resolve=>setTimeout(resolve,800));result=await api(`/api/tracking/jobs/${job.id}`);}
   if(result.status!=='completed')throw Error(aborted?'초기 장면 검출을 취소했습니다.':result.error||'초기 장면 검출이 중단되었습니다.');
   const data=await api(result.result.detections);
   const endWasFull=!Number.isFinite(sourceDuration)||$('tracking-to').value===sourceDuration.toFixed(3);
   setDuration(data.duration);
   if(endWasFull)$('tracking-to').value=data.duration.toFixed(3);
   $('tracking-preview-stage').style.aspectRatio=`${data.width}/${data.height}`;
   $('tracking-file-size').textContent=`${sizeText(file.size)} · ${data.width} × ${data.height} · ${durationText(data.duration)}`;
   await calibration.setPrepared(data,result.id,result.result.frame);status('');
  }catch(error){status(error.message,true);}finally{preparingId=null;setBusy(false);}
 };
 $('choose-initial-frame').onclick=()=>{const time=calibration.time();calibration.clearFrame(!playable);if(playable&&Number.isFinite(time))video.currentTime=time;$('preflight-frame-time').textContent='다른 장면을 찾은 뒤 다시 검출하세요';};
 $('tracking-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!file)return;
  const issues=calibration.issues();if(issues.length){status('초기 설정을 완료하세요: '+issues.join(' · '),true);return;}
  const start=calibration.time(),requestedEnd=$('tracking-entire').checked?sourceDuration:Number($('tracking-to').value);
  if(!Number.isFinite(sourceDuration)||!Number.isFinite(start)||!Number.isFinite(requestedEnd)||(!$('tracking-entire').checked&&!$('tracking-to').value)||requestedEnd<=start||requestedEnd>sourceDuration+.001){status('종료 시각은 초기 설정 장면 이후, 영상 끝 이내로 지정하세요.',true);return;}
  const end=Math.min(requestedEnd,sourceDuration);
  const options={defer:caps?.uploadStorage==='s3',start,duration:$('tracking-entire').checked?0:end-start,roi:calibration.roi(),device:$('tracking-device').value,setup:calibration.setup()};
  setBusy(true);$('cancel-upload').hidden=true;$('upload-label').textContent='초기 설정을 저장하고 분석 시작';status('');
  try{
   await post('/api/tracking/jobs',{uploadId:uploaded.id,...options});
   status(options.defer?'초기 설정을 저장했습니다. 다음 경기를 설정하거나 준비된 경기의 분석을 시작하세요.':'초기 설정을 적용해 분석을 시작했습니다.');
   file=null;uploaded=null;video.removeAttribute('src');video.load();if(url)URL.revokeObjectURL(url);url=null;calibration.reset();
   $('tracking-video-file').value='';$('tracking-preview-wrap').hidden=true;$('tracking-empty').hidden=false;$('tracking-file-name').textContent='영상을 선택하거나 여기에 놓으세요';$('tracking-file-size').textContent='MP4 · MOV · M4V · AVI · MKV · WebM';
   await refreshJobs();
  }catch(error){status(error.message,true);}finally{setBusy(false);}
 });
 async function action(id,operation,button){
  if(pendingJobs.has(id))return;
  pendingJobs.add(id);button.disabled=true;
  try{
   const job=await post(`/api/tracking/jobs/${id}/${operation}`);
   if(operation==='purge'){
    if(job.datasetId)try{localStorage.removeItem(`fpa-cv-review:${job.datasetId}`);}catch{}
    try{localStorage.removeItem(`fpa-cv-cloud-draft:${id}`);}catch{}
    window.dispatchEvent(new CustomEvent('fpa-cv:purged',{detail:job}));
    $('tracking-list-message').classList.remove('error');
    $('tracking-list-message').textContent=job.sourceDeleted?'분석 결과와 원본 영상을 영구 삭제했습니다.':'분석 결과를 영구 삭제했습니다. 다른 분석에서 쓰는 원본 영상은 유지했습니다.';
   }
   if(operation==='delete'||operation==='restore'){
    $('tracking-list-message').classList.remove('error');
    $('tracking-list-message').textContent=operation==='restore'?'분석 목록으로 복원했습니다.':active.has(job.status)?'분석을 중지하고 삭제한 분석으로 이동했습니다.':'목록에서 삭제했습니다. 아래 삭제한 분석에서 복원할 수 있습니다.';
   }
  }catch(error){$('tracking-list-message').textContent=error.message;$('tracking-list-message').classList.add('error');}
  finally{pendingJobs.delete(id);jobSignature='';try{await refreshJobs();}catch(error){status(error.message,true);}}
 }
 async function open(job,button){
  if(opening)return;opening=job.id;button.disabled=true;button.textContent='불러오는 중';
  try{await openJob(job.id);}catch(error){status(error.message,true);}finally{opening=null;jobSignature='';await refreshJobs();}
 }
 function renderJobs(jobs,deleted=[]){
  $('tracking-job-count').textContent=jobs.length;
  $('tracking-deleted-count').textContent=deleted.length;
  $('tracking-active-count').textContent=jobs.filter(job=>active.has(job.status)).length?`${jobs.filter(job=>active.has(job.status)).length}개 진행 중`:'';
  for(const [items,holder,trashed] of [[jobs,$('tracking-jobs'),false],[deleted,$('tracking-deleted-jobs'),true]]){
   holder.replaceChildren();
   if(!items.length)holder.append(el('p',trashed?'삭제한 분석이 없습니다.':'완료된 영상은 이곳에서 작업 화면으로 열 수 있습니다.','tracking-jobs-empty'));
   for(const job of items){
   const card=el('article',undefined,'tracking-job');card.dataset.jobId=job.id;
   const head=el('div',undefined,'tracking-job-heading'),name=el('h3',job.name),badge=el('span',states[job.status]||job.status,`job-status ${job.status}`);head.append(name,badge);card.append(head);
   const info=[job.deviceLabel,job.model];if(job.id==='existing')info.push('기존 트래킹 결과');else if(job.options)info.push(job.options.duration?`${job.options.start.toFixed(3)}–${(job.options.start+job.options.duration).toFixed(3)}초`:`${job.options.start.toFixed(3)}초부터 끝까지`);
   if(job.options?.setup)info.push('코트·팀 색상 적용');
   else if(job.id!=='existing')info.push('초기 설정 전 결과');
   if(Number.isInteger(job.initialMatched))info.push(`초기 번호 연결 ${job.initialMatched}/13`);
   if(job.initialMatched<13)card.append(el('p','일부 초기 번호를 확실하게 연결하지 못했습니다. 작업 화면에서 확인하세요.','tracking-setup-warning'));
   if(job.samples)info.push(`${job.samples}개 샘플`);card.append(el('p',info.filter(Boolean).join(' · '),'tracking-job-meta'));
   if(active.has(job.status)){
    const progress=el('progress');progress.max=100;progress.value=job.progress||0;progress.setAttribute('aria-label','트래킹 진행률');card.append(progress);
    const estimating=job.status==='starting'||(job.status==='running'&&job.progress<98);
    const eta=estimating?(Number.isFinite(job.eta)?` · 약 ${durationText(job.eta)} 남음`:' · 남은 시간 계산 중'):'';
    const status=el('p',`${job.stage} · ${Math.round(job.progress||0)}%${eta}`,'tracking-job-progress');
    status.title='남은 추적 시간 = 처리 경과 시간 ÷ 완료한 분석 프레임 수 × 남은 분석 프레임 수';card.append(status);
    if(Number.isInteger(job.totalFrames)&&job.totalFrames>0&&Number.isInteger(job.processedFrames)){
     const details=[`분석 프레임 ${job.processedFrames.toLocaleString('ko-KR')} / ${job.totalFrames.toLocaleString('ko-KR')}`];
     if(Number.isFinite(job.elapsed)&&job.elapsed>0)details.push(`${durationText(job.elapsed)} 경과`);
     if(Number.isFinite(job.processingFps)&&job.processingFps>0)details.push(`평균 ${job.processingFps.toFixed(1)}프레임/초`);
     card.append(el('p',details.join(' · '),'tracking-job-progress'));
    }
   }
   if(job.error){const detail=el('details',undefined,'tracking-error-detail');detail.append(el('summary','중단 원인'),el('pre',job.error));card.append(detail);}
   const actions=el('div',undefined,'tracking-job-actions');
   if(trashed){const button=el('button',active.has(job.status)?'중지 후 복원 가능':'목록으로 복원','subtle');button.disabled=active.has(job.status);button.onclick=()=>action(job.id,'restore',button);actions.append(button);}
   else if(job.status==='ready'){const button=el('button','1차 분석 시작','primary');button.onclick=()=>action(job.id,'start',button);actions.append(button);}
   else if(job.status==='completed'){const button=el('button','작업 시작 →','primary');button.disabled=!!opening;button.onclick=()=>open(job,button);actions.append(button);}
   else if(active.has(job.status)){const button=el('button',job.status==='cancelling'?'중지 중':'분석 취소','subtle');button.disabled=job.status==='cancelling';button.onclick=()=>action(job.id,'cancel',button);actions.append(button);}
   else{const button=el('button','다시 분석','subtle');button.onclick=()=>action(job.id,'retry',button);actions.append(button);}
   if(!trashed){const button=el('button',active.has(job.status)?'중지 후 삭제':'삭제','job-delete');button.title='목록에서 삭제 · 삭제한 분석에서 복원 가능';button.onclick=()=>action(job.id,'delete',button);actions.append(button);}
   if(trashed&&job.id!=='existing'){
    const button=el('button','영구 삭제','job-delete');button.disabled=active.has(job.status);
    button.onclick=()=>{if(confirm(`“${job.name}” 분석을 영구 삭제할까요?\n\n분석 결과와 저장된 검수는 복구할 수 없습니다. 다른 분석에서 사용하지 않는 원본 영상도 삭제됩니다. 다운로드한 백업은 남습니다.`))void action(job.id,'purge',button);};
    actions.append(button);
   }
   if(pendingJobs.has(job.id))for(const button of actions.querySelectorAll('button'))button.disabled=true;
   const date=trashed?job.deletedAt:job.finishedAt;if(date)actions.append(el('time',new Date(date*1000).toLocaleString('ko-KR')));card.append(actions);holder.append(card);
   }
  }
 }
 let readyJobs=[];
 $('start-ready-jobs').onclick=async()=>{const button=$('start-ready-jobs');button.disabled=true;try{await post('/api/tracking/batch/start',{ids:readyJobs});jobSignature='';await refreshJobs();status('분석 예약이 완료됐습니다. 업로드도 모두 끝났다면 창을 닫아도 됩니다.');}catch(error){status(error.message,true);}finally{button.disabled=false;}};
 async function refreshJobs(){const {jobs,deleted=[]}=await api('/api/tracking/jobs');readyJobs=jobs.filter(j=>j.status==='ready').map(j=>j.id);$('start-ready-jobs').hidden=!readyJobs.length;$('start-ready-jobs').textContent=`준비된 ${readyJobs.length}경기 모두 분석 시작`;await library.refresh(jobs);const signature=JSON.stringify([jobs,deleted]);if(signature!==jobSignature){jobSignature=signature;renderJobs(jobs,deleted);}return [...jobs,...deleted];}
 async function poll(){
  let delay=4000;
  try{
   if(!caps||caps.checking||!caps.ready){caps=await api('/api/tracking/capabilities');updateReady();if(caps.error)status(caps.error,true);else status('');}
   const jobs=await refreshJobs();if(caps?.checking||jobs.some(job=>active.has(job.status)))delay=1500;
  }catch(error){$('gpu-status').textContent='서버 연결 확인';status(error.message,true);}
  setTimeout(poll,delay);
 }
 void poll();
 return {refresh:refreshJobs};
}
