import {mountSequenceSync} from './sequence-sync.mjs';
import {mountFramePairing} from './frame-pairing.mjs';
import {mountRefereeRoster} from './referee-roster.mjs';
import {mountFlow,flowUrl} from './review-flow.mjs';
import {mountWidePreparation} from './wide-preparation.mjs';
import {mountFpcRecordingRelay} from './fpc-recording-relay.mjs';
const $=id=>document.getElementById(id);let data,event,media,mode='auto',busy=false,presented=null,requested=null,loadGeneration=0;
let flow=null,linkedReady=false,momentDirty=false;const params=new URLSearchParams(location.search);let libraryMatchId=params.get('match');
const msg=s=>$('status').textContent=s;
const roster=mountRefereeRoster($('refereeRoster'),{api,scope:()=>data?.id||params.get('intake')?['intake',data?.id||params.get('intake')]:libraryMatchId?['matches',libraryMatchId]:null,message:msg,onChange:()=>flow?.update()});
const pairPicker=mountFramePairing($('framePairing'),{api,broadcast:()=>({frame:media?current():null,sha:media?.sha256,pause:()=>$('video').pause(),seeking:()=>$('video').seeking||$('video').readyState<2}),message:msg,onChange:()=>{linkedReady=false;flow?.update();}});
const sequence=mountSequenceSync($('sequenceSync'),{api,broadcast:()=>({video:$('video'),fps:media?.fps||0,sha:media?.sha256||null}),message:msg});
roster.load();
let widePanel=null,wideMatch=null,recordingRelay=null,recordingIntake=null;
function connectRecording(){if(!data?.id||recordingIntake===data.id)return;recordingRelay?.dispose();recordingIntake=data.id;recordingRelay=mountFpcRecordingRelay($('fpcRecordingRelay'),{intakeId:data.id,canPrepare:()=>!pairPicker.dirty(),onPrepared:()=>pairPicker.refresh()});}
function connectWide(){if(!libraryMatchId||wideMatch===libraryMatchId)return;widePanel?.dispose();wideMatch=libraryMatchId;$('widePreparationPanel').hidden=false;widePanel=mountWidePreparation($('workflowWide'),{matchId:libraryMatchId});}
connectWide();
async function api(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'요청을 처리하지 못했습니다.');return d;}
function lock(value){busy=value;for(const id of ['upload','sample','confirm','continue','report','saveOrder','resumeMatching'])$(id).disabled=value;flow?.update();}
$('videos').onchange=()=>$('videoNames').textContent=Array.from($('videos').files).map(f=>`${f.name} · ${(f.size/1024**2).toFixed(1)} MB`).join(' / ');
$('csv').onchange=()=>$('csvName').textContent=$('csv').files[0]?.name||'CSV를 선택하세요.';
async function poll(){data=await api(`/api/intake/${data.id}`);if(libraryMatchId&&data.libraryMatchId&&libraryMatchId!==data.libraryMatchId)throw Error('선택한 경기와 등록 자료가 다릅니다. 경기 상세에서 다시 여세요.');if(!libraryMatchId&&data.libraryMatchId){libraryMatchId=data.libraryMatchId;$('matchBack').href=`./match.html?id=${libraryMatchId}`;$('matchBack').textContent='← 경기 상세';}connectWide();$('matchingRecovery').hidden=!(data.status==='failed'&&data.matchingResumeAvailable);if(data.status==='failed'){lock(false);if(data.matchingResumeAvailable){$('upload').disabled=true;$('sample').disabled=true;}msg(data.error);return;}if(data.status==='uploading'){lock(false);msg('완료되지 않은 업로드입니다. 영상과 CSV를 다시 선택해 새로 등록하세요.');return;}if(data.status==='matching'){lock(true);msg('파일 확인 및 경기 시계 후보 탐색 중…');setTimeout(()=>poll().catch(e=>{msg(e.message);lock(false);}),1500);return;}lock(false);show();if(data.processing)await processingState();if(data.objectsReady&&!linkedReady&&!['running','queued','interrupted','failed'].includes(data.processing?.state)){showReady({caseId:data.linkedCaseId,poseUrl:'/pose-review.html?id='+data.linkedCaseId,url:'/reconstruction.html?id='+data.linkedCaseId});if(data.processing?.state!=='needs-review'){$('processingPanel').hidden=true;msg('객체 결과가 준비되어 있습니다. 수정한 객체의 자세는 관절 단계에서 재계산하세요.');}}}
$('resumeMatching').onclick=async()=>{lock(true);try{data=await api(`/api/intake/${data.id}/resume-matching`,{});$('matchingRecovery').hidden=true;msg('저장된 원본을 확인하고 후보 탐색을 이어갑니다.');await poll();}catch(e){msg(e.message);lock(false);}};
$('upload').onclick=async()=>{lock(true);try{const files=Array.from($('videos').files),csv=$('csv').files[0];if(!csv||!files.length)throw Error('영상과 CSV를 모두 선택하세요.');data=await api('/api/intake/create',{libraryMatchId,referees:roster.value(),csvText:await csv.text(),media:files.map(f=>({name:f.name,size:f.size}))});await roster.adopt();history.replaceState(null,'',`?intake=${data.id}${libraryMatchId?'&match='+encodeURIComponent(libraryMatchId):''}`);$('progress').hidden=false;const total=files.reduce((n,f)=>n+f.size,0);let done=0;for(let i=0;i<files.length;i++){for(let offset=0;offset<files[i].size;offset+=8*1024**2){const chunk=files[i].slice(offset,offset+8*1024**2);const r=await fetch(`/api/intake/${data.id}/media/${i}?offset=${offset}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:chunk});if(!r.ok)throw Error((await r.json()).error||'업로드 실패');done+=chunk.size;$('progress').value=done/total*100;msg(`영상 업로드 ${Math.round(done/total*100)}%`);}}await api(`/api/intake/${data.id}/finalize`,{});await poll();}catch(e){msg(e.message);lock(false);}};
$('sample').onclick=async()=>{lock(true);try{data=await api('/api/intake/demo',{});await roster.adopt();history.replaceState(null,'',`?intake=${data.id}${libraryMatchId?'&match='+encodeURIComponent(libraryMatchId):''}`);await poll();}catch(e){msg(e.message);lock(false);}};
function renderOrder(){
 $('orderPanel').hidden=false;$('orderRows').replaceChildren();
 const saved=data.mediaAssignments?.assignments||{};let count=0;
 for(const e of data.events){
  const proposal=data.mediaProposals?.[e.id]||{},row=document.createElement('div');row.className='order-row';
  const heading=document.createElement('div'),title=document.createElement('strong');
  title.textContent=`판독 ${e.number} · ${e.quarter}Q ${e.gameClock}`;heading.append(title);
  const select=document.createElement('select');select.dataset.eventId=e.id;select.setAttribute('aria-label',`판독 ${e.number} 영상`);
  select.append(new Option('영상을 선택하세요',''));for(const m of data.media)select.append(new Option(m.name,m.id));
  select.value=e.selection?.mediaId??saved[e.id]??proposal.mediaId??'';if(select.value)count++;
  select.onchange=()=>{const filled=$('orderRows').querySelectorAll('select');$('orderCount').textContent=`${Array.from(filled).filter(x=>x.value).length} / ${data.events.length} 연결`;};
  row.append(heading,select);$('orderRows').append(row);
 }
 $('orderCount').textContent=`${count} / ${data.events.length} 연결`;
}
$('saveOrder').onclick=async()=>{
 const assignments=Object.fromEntries(Array.from($('orderRows').querySelectorAll('select')).map(x=>[x.dataset.eventId,x.value]));
 if(Object.values(assignments).some(x=>!x))return msg('모든 판독 장면에 영상을 연결하세요.');
 lock(true);try{data=await api(`/api/intake/${data.id}/media-assignments`,{revision:data.revision,assignments});show();$('reviewPanel').scrollIntoView({behavior:'smooth'});msg('영상 연결을 저장했습니다. 각 장면의 판독 프레임을 확인하세요.');}catch(e){msg(e.message);}finally{lock(false);}
};
function show(){
 connectRecording();
 roster.load();
 updateSla();$('uploadPanel').hidden=true;renderOrder();
 const canReview=!!data.mediaAssignments||data.events.some(e=>e.selection);
 $('reviewPanel').hidden=!canReview;
 if(!canReview){msg('판독별 영상 후보를 확인하고 연결을 확정하세요.');return;}
 loadUniforms().catch(e=>msg(e.message));$('fixture').textContent=`${data.case.home} vs ${data.case.away} · ${data.case.date}`;$('warnings').textContent=data.warnings.join(' ');$('selectedCount').textContent=`${data.events.filter(e=>e.selection).length} / ${data.events.length} 프레임 확정`;tabs();open(event?.id||location.hash.slice(1)||data.events[0].id);msg('중계와 광각을 확인하고 판독 기준 프레임을 확정하세요.');
}
function tabs(){$('events').replaceChildren(...data.events.map(e=>{const b=document.createElement('button');b.textContent=`판독 ${e.number} · ${e.quarter}Q ${e.gameClock}${e.selection?' ✓':''}`;b.className=e.id===event?.id?'active':'';b.onclick=()=>{if(momentDirty||pairPicker.dirty())return msg('변경한 순간·광각 연결을 ‘이 프레임 확정’으로 저장한 뒤 이동하세요.');open(e.id);};return b;}));}
function open(id){cancelPick();event=data.events.find(e=>e.id===id)||data.events[0];const previous=data.events[data.events.findIndex(e=>e.id===event.id)-1]||null;pairPicker.open(data.id,event.id,previous);sequence.open(data.id,event.id);$('actionWindow').value=String(event.selection?.actionWindowSeconds??(event.selection?30:12));$('eventTitle').textContent=`${event.quarter}Q ${event.gameClock}`;$('reason').textContent=event.recordedReason;$('saved').textContent=event.selection?`확정됨 · F${event.selection.frameIndex} (${event.selection.mode==='auto'?'자동 제안':'수동 선택'})`:'';$('media').replaceChildren(...data.media.map(m=>new Option(m.name,m.id)));$('candidate').replaceChildren(...event.candidates.map((c,i)=>new Option(`${c.label} · F${c.frameIndex}`,String(i))));const preferred=event.preferredMediaId;const firstCandidate=preferred?event.candidates.find(c=>c.mediaId===preferred):event.candidates[0];mode='manual';document.querySelector(`input[name=mode][value=${mode}]`).checked=true;const selected=event.selection||firstCandidate||{mediaId:preferred||data.media[0].id,frameIndex:0};$('media').value=selected.mediaId;$('candidate').value=String(Math.max(0,event.candidates.findIndex(c=>c.mediaId===selected.mediaId&&c.frameIndex===selected.frameIndex)));loadMedia(selected.mediaId,selected.frameIndex);setMode();tabs();$('continue').disabled=busy||!data.events.every(e=>e.selection);if(linkedReady)$('poseLink').href=flowUrl('objects',data.linkedCaseId,event.id);recordFields();flow?.update();}
function recordFields(){
 momentDirty=false;
 const moment=event.selection?.analysisMoment||{};$('momentPhase').value=moment.phase||'unconfirmed';$('momentClock').value=moment.clock||'';$('momentNote').value=moment.note||'';
 $('recordQuarter').value=event.quarter;$('recordClock').value=event.gameClock==='시각 미기재'?'':event.gameClock;$('recordDecision').value=event.recordedDecision;$('recordReason').value=event.recordedReason;$('recordBasis').value='';
 const correction=data.recordCorrections?.find(r=>r.eventId===event.id);
 $('recordCorrectionNote').textContent=correction?`원본 CSV ${correction.original.quarter}Q ${correction.original.gameClock} → 현재 ${event.quarter}Q ${event.gameClock} · 정정한 기록을 모든 단계에서 사용합니다.`:'원본 CSV를 보존하고 정정한 내용을 모든 단계에서 함께 사용합니다. 영상 프레임은 그대로 유지됩니다.';
}
$('saveRecord').onclick=async()=>{
 if(momentDirty)return msg('기준 순간 설명을 먼저 프레임 확정으로 저장하세요.');
 lock(true);$('saveRecord').disabled=true;
 try{data=await api(`/api/intake/${data.id}/records`,{version:data.recordsVersion,eventId:event.id,fields:{quarter:Number($('recordQuarter').value),gameClock:$('recordClock').value,recordedDecision:$('recordDecision').value,recordedReason:$('recordReason').value},reason:$('recordBasis').value});show();await flow?.refresh();msg('기록 정정을 저장했습니다. 객체·관절 계산과 선택 프레임은 유지됩니다.');}
 catch(e){msg(e.message);}finally{lock(false);$('saveRecord').disabled=false;}
};
function loadMedia(id,frame=0){cancelPick();const generation=++loadGeneration;media=data.media.find(m=>m.id===id);$('video').pause();presented=null;requested=frame;$('frame').max=media.frames-1;$('scrubber').max=media.frames-1;$('video').src=`/intake-assets/${data.id}/${media.id}.mp4`;$('video').onloadedmetadata=()=>{if(generation===loadGeneration)seek(frame);};$('video').load();if($('video').requestVideoFrameCallback){const callback=(_,meta)=>{if(generation!==loadGeneration)return;presented=Math.min(media.frames-1,Math.round(meta.mediaTime*media.fps));if(presented===requested)requested=null;times();$('video').requestVideoFrameCallback(callback);};$('video').requestVideoFrameCallback(callback);}}
function current(){return requested??presented??Math.floor($('video').currentTime*media.fps);}
function times(){if(!media)return;pairPicker.broadcastMoved();const f=current();$('frame').value=f;$('scrubber').value=f;$('time').textContent=`F${f} / ${(f/media.fps).toFixed(3)}초`;}
function seek(f){if(!media||!Number.isFinite(f))return;requested=Math.min(media.frames-1,Math.max(0,Math.round(f)));$('video').pause();$('video').currentTime=(requested+.1)/media.fps;times();}
function manual(){mode='manual';document.querySelector('input[value=manual]').checked=true;setMode();}
function setMode(){$('candidateField').hidden=mode==='manual';$('candidateHelp').textContent=mode==='auto'?'후보는 경기 시계 또는 기존 검토 프레임입니다. 접촉 순간을 영상에서 확인하세요.':'재생·슬라이더·프레임 이동으로 원하는 순간을 고르세요.';$('confirm').disabled=busy||(mode==='auto'&&!event.candidates.length);}
for(const input of document.querySelectorAll('input[name=mode]'))input.onchange=()=>{mode=input.value;setMode();if(mode==='auto'&&event.candidates.length){const i=event.candidates.findIndex(c=>c.mediaId===(event.preferredMediaId||$('media').value));if(i<0){manual();return msg('연결한 영상에 자동 프레임 후보가 없습니다. 직접 선택하세요.');}$('candidate').value=String(i);const c=event.candidates[i];$('media').value=c.mediaId;loadMedia(c.mediaId,c.frameIndex);}};
$('candidate').onchange=()=>{const c=event.candidates[Number($('candidate').value)];$('media').value=c.mediaId;loadMedia(c.mediaId,c.frameIndex);};$('media').onchange=()=>{manual();loadMedia($('media').value,0);};$('previous').onclick=()=>{manual();seek(current()-1);};$('next').onclick=()=>{manual();seek(current()+1);};$('frame').onchange=()=>{manual();seek(Number($('frame').value));};$('scrubber').oninput=()=>{manual();seek(Number($('scrubber').value));};$('video').onplay=manual;$('video').ontimeupdate=times;
$('confirm').onclick=async()=>{lock(true);try{$('video').pause();data=await api(`/api/intake/${data.id}/selection`,{revision:data.revision,eventId:event.id,mediaId:media.id,frameIndex:current(),...pairPicker.value(),mode,actionWindowSeconds:Number($('actionWindow').value),analysisMoment:{phase:$('momentPhase').value,clock:$('momentClock').value,note:$('momentNote').value}});linkedReady=false;flow?.update();$('resultPanel').hidden=true;$('processingPanel').hidden=true;$('download').hidden=true;$('step4').classList.remove('active');show();msg('선택한 원본과 프레임을 저장했습니다.');}catch(e){msg(e.message);}finally{lock(false);$('continue').disabled=!data.events.every(e=>e.selection);}};
function showReady(next){linkedReady=true;lock(false);if(!flow){flow=mountFlow({stage:'frame',caseId:next.caseId,eventId:()=>event?.id,isBusy:()=>busy||!linkedReady||uniformDirty||momentDirty||pairPicker.dirty()||roster.dirty(),message:msg});document.querySelector('.steps').hidden=true;}flow.refresh().catch(e=>msg(e.message));$('resultPanel').hidden=false;$('poseLink').href=flowUrl('objects',next.caseId,event?.id);$('spatialLink').href=next.url;$('step2').classList.add('active');$('continue').textContent='객체 단계로 이어가기 →';msg('객체 후보가 준비됐습니다. 객체 단계부터 장면 전체를 확인하세요.');}
async function processingState(){
 const job=data.processing;if(!job)return;if(job.state!=='complete'){linkedReady=false;flow?.update();}
 $('processingPanel').hidden=false;$('processingStage').textContent=job.stage;
 $('processingProgress').max=job.total||data.events.length;$('processingProgress').value=job.processed??job.completed??0;
 $('executionHistory').hidden=!data.processingExecution||!['complete','needs-review'].includes(data.processingExecution.state);$('executionSummary').textContent=data.processingExecution?.stage||'';
 $('processingDetails').replaceChildren(...(job.results||[]).map(r=>{const item=document.createElement('li');item.textContent=`판독 ${r.eventId.split('-').at(-1)} · F${r.frameIndex} · 객체 ${r.people}명 · ${r.posedPeople==null?'관절 검수 전':`관절 ${r.posedPeople}명`} · ${r.spatialReady===false?'코트 보정 대기':'객체 준비'}${r.refereeCandidates===0?' · 심판 역할 수동 확인 필요':''}${r.wideAssistance?.message?' · '+r.wideAssistance.message:''}`;return item;}));
 for(const issue of job.issues||[]){const item=document.createElement('li');item.textContent=`판독 ${issue.eventId.split('-').at(-1)} · F${issue.frameIndex} · 확인 필요: ${issue.error}`;$('processingDetails').append(item);}
 if(job.state==='complete'){showReady(job.next);return;}
 if(job.state==='needs-review'){
  lock(false);if(data.objectsReady)showReady(job.next);else $('continue').textContent='미완료 장면 다시 처리 →';
  $('processingStage').textContent=job.stage;msg(`객체 후보 ${job.completed}/${job.total} 준비. 판독 ${(job.issues||[]).map(i=>i.eventId.split('-').at(-1)).join(', ')}의 코트 좌표를 보정하세요. 객체 검수는 계속 진행할 수 있습니다.`);return;
 }
 $('resultPanel').hidden=true;$('download').hidden=true;
 if(job.state==='failed'||job.state==='interrupted'){lock(false);$('continue').textContent=job.state==='interrupted'?'중단된 작업 이어받기 →':'남은 작업 다시 처리 →';$('processingStage').textContent=job.stage+' · 확인 필요';msg((job.error||'저장된 작업을 이어받을 수 있습니다.')+' 선택한 프레임과 완료 결과는 저장되어 있습니다.');return;}
 lock(true);$('continue').textContent='새 프레임 처리 중…';msg(job.stage+' · 창을 닫아도 서버가 실행 중이면 처리가 계속됩니다.');
 setTimeout(()=>pollProcessing().catch(e=>{lock(false);msg('처리 상태 연결이 끊겼습니다. 새로고침하면 저장된 상태를 다시 확인합니다. '+e.message);}),1500);
}
async function pollProcessing(){data=await api(`/api/intake/${data.id}`);await processingState();}
$('continue').onclick=async()=>{if(roster.dirty())return msg('배정 심판 명단을 먼저 저장하세요.');if(pairPicker.dirty())return msg('광각 연결을 이 프레임 확정으로 저장하세요.');if(momentDirty)return msg('기준 순간 설명을 ‘이 프레임 확정’으로 저장하세요.');if(uniformDirty||uniformSaving)return msg('유니폼 색상을 먼저 저장하세요.');if(linkedReady){location.href=flowUrl('objects',data.linkedCaseId,event.id);return;}lock(true);$('download').hidden=true;try{const next=await api(`/api/intake/${data.id}/handoff`,{});if(next.state==='processing'){await pollProcessing();$('processingPanel').scrollIntoView({behavior:'smooth'});}else{showReady(next);$('resultPanel').scrollIntoView({behavior:'smooth'});}}catch(e){lock(false);msg(e.message);}};
$('report').onclick=async()=>{lock(true);try{const next=await api(`/api/intake/${data.id}/handoff`,{});if(next.state!=='ready'){await pollProcessing();return;}const c=await api(`/api/cases/${next.caseId}`),result=await api(`/api/cases/${next.caseId}/report`,{revision:c.revision});$('download').href=result.pdf;$('download').hidden=false;$('step4').classList.add('active');msg(`${result.pageCount}페이지 PDF 생성 · 경기 요약 1페이지 + 장면마다 1페이지`);lock(false);}catch(e){lock(false);msg(e.message);}};
let uniformData=null,uniformKey=null,uniformDirty=false,picking=null,pickFrame=null,uniformSaving=false;
async function loadUniforms(){
 if(!data?.id||uniformKey===data.id)return;const key=data.id;
 uniformData=await api(`/api/intake/${key}/uniforms`);uniformKey=key;
 $('homeColor').value=uniformData.home;$('awayColor').value=uniformData.away;
 $('homeName').textContent=`홈 · ${data.case.home}`;$('awayName').textContent=`어웨이 · ${data.case.away}`;
 $('uniformStatus').textContent=uniformData.configured?'저장된 색상입니다. 선수 팀 구분과 2D·3D 유니폼에 사용합니다.':'색상을 추출한 뒤 저장하세요. 저장 전에는 선수 팀을 자동 구분하지 않습니다.';
}
function cancelPick(){const active=!!picking;picking=null;$('uniformFrame').hidden=true;$('pickWrap').classList.remove('picking');$('cancelPick').hidden=true;if(active)$('uniformStatus').textContent=uniformDirty?'추출을 종료했습니다. 변경한 색상은 저장 후 반영됩니다.':uniformData?.configured?'저장된 색상입니다. 선수 팀 구분과 2D·3D 유니폼에 사용합니다.':'색상을 추출한 뒤 저장하세요.';}
async function startPick(team){
 try{
  if(busy||uniformSaving||!media||!uniformData)return;
  const video=$('video');video.pause();if(video.readyState<2||video.seeking)throw Error('프레임이 표시된 다음 색상을 추출하세요.');
  const canvas=$('uniformFrame');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d',{willReadFrequently:true}).drawImage(video,0,0);
  pickFrame={frameIndex:presented??Math.floor(video.currentTime*media.fps),mediaId:media.id,eventId:event.id};picking=team;canvas.hidden=false;$('pickWrap').classList.add('picking');$('cancelPick').hidden=false;
  $('uniformStatus').textContent=`${team==='home'?'홈':'어웨이'} 유니폼 몸통의 단색 부분을 클릭하세요. (Esc: 취소)`;
  canvas.scrollIntoView({block:'center',behavior:'instant'});
 }catch(e){msg(e.message);}
}
$('pickHome').onclick=()=>startPick('home');$('pickAway').onclick=()=>startPick('away');$('cancelPick').onclick=cancelPick;
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&picking)cancelPick();});
$('uniformFrame').onclick=e=>{
 if(!picking)return;const canvas=$('uniformFrame'),r=canvas.getBoundingClientRect(),x=Math.round((e.clientX-r.left)/r.width*canvas.width),y=Math.round((e.clientY-r.top)/r.height*canvas.height);
 const pixels=canvas.getContext('2d').getImageData(Math.max(0,Math.min(canvas.width-5,x-2)),Math.max(0,Math.min(canvas.height-5,y-2)),5,5).data;
 const rgb=[0,1,2].map(c=>Array.from({length:25},(_,i)=>pixels[i*4+c]).sort((a,b)=>a-b)[12]);const hex='#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('');
 const team=picking;$(team+'Color').value=hex;uniformData.samples[team]=pickFrame;uniformDirty=true;cancelPick();flow?.update();
 $('uniformStatus').textContent=`${team==='home'?'홈':'어웨이'} ${hex.toUpperCase()} 추출 · 유니폼 색상 저장을 눌러 반영하세요.`;
};
for(const team of ['home','away'])$(team+'Color').oninput=()=>{if(!uniformData)return;delete uniformData.samples[team];uniformDirty=true;flow?.update();$('uniformStatus').textContent='색상 변경 · 저장하면 팀 구분과 2D·3D에 반영됩니다.';};
$('saveUniforms').onclick=async()=>{
 if(busy||!uniformData||uniformSaving)return;uniformSaving=true;$('saveUniforms').disabled=true;
 try{cancelPick();uniformData=await api(`/api/intake/${data.id}/uniforms`,{...uniformData,home:$('homeColor').value,away:$('awayColor').value});uniformDirty=false;flow?.update();$('uniformStatus').textContent='유니폼 색상 저장 완료 · 선수 팀은 색상으로 제안하며, 2D에서 직접 수정할 수 있습니다. 심판 역할은 유지합니다.';}
 catch(e){msg(e.message);}finally{uniformSaving=false;$('saveUniforms').disabled=false;}
};
window.addEventListener('beforeunload',e=>{if(uniformDirty||momentDirty||pairPicker.dirty()||roster.dirty()){e.preventDefault();e.returnValue='';}});
if(libraryMatchId){try{const m=await api(`/api/library/matches/${encodeURIComponent(libraryMatchId)}`);$('matchContext').hidden=false;$('matchContext').textContent=`${m.date} · ${m.home} vs ${m.away} · 이 경기의 자료 등록`;$('matchBack').href=`./match.html?id=${m.id}`;$('matchBack').textContent='← 경기 상세';$('sample').hidden=true;}catch(e){msg(e.message);lock(true);throw e;}}
let key=params.get('intake');if(!key&&params.get('case')){try{key=(await api(`/api/cases/${params.get('case')}/intake`)).id;}catch(e){msg(e.message);}}if(key){data={id:key};poll().catch(e=>msg(e.message));}

function updateSla(){const start=data?.uploadCompletedAt;if(!start){$('slaClock').textContent=data?'이전 접수: 업로드 완료 시각이 없어 90분 경과를 소급 계산하지 않습니다.':'';return;}const completed=data.delivery?.firstPublishedAt,elapsed=Math.max(0,((completed?Date.parse(completed):Date.now())-Date.parse(start))/60000),left=Math.max(0,90-elapsed);$('slaClock').textContent=completed?`첫 납품본 표시까지 ${Math.ceil(elapsed)}분 · ${elapsed<=90?'90분 이내':'90분 초과'} · PDF 개정 이력 보관`:`업로드 완료 후 ${Math.floor(elapsed)}분 경과 · 90분까지 ${Math.ceil(left)}분 · 장면 ${data.events?.length||0}개`;}
setInterval(updateSla,15000);

$('actionWindow').onchange=()=>{linkedReady=false;$('continue').disabled=true;flow?.update();$('saved').textContent='추적 길이가 바뀌었습니다. 이 프레임 확정을 눌러 저장하세요.';};

for(const id of ['momentPhase','momentClock','momentNote'])$(id).oninput=()=>{momentDirty=true;flow?.update();$('saved').textContent='기준 순간 설명이 바뀌었습니다. 이 프레임 확정을 눌러 저장하세요.';};
