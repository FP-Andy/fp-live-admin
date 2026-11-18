import {fpcFrameSources,formatFirstFrameReceived} from './fpc-recording-relay.mjs';

// A pair refers only to the displayed instant, not a replay's playback rate.
export function chooseWideSource(rows, selected, candidates) {
 const available=id=>rows.some(row=>row.id===id);
 if(selected&&available(selected.sourceId))return {id:selected.sourceId,frameIndex:selected.frameIndex};
 const candidate=candidates.find(item=>available(item.sourceId));
 if(candidate)return {id:candidate.sourceId,seconds:candidate.seconds??0};
 return rows.length?{id:rows[0].id,seconds:0}:null;
}
// Only mark a prior scene when the exact segment or a shared recording timeline proves it.
export function previousWideMarker(rows, previousEvent) {
 const selection=previousEvent?.selection,pair=selection?.widePair;
 if(!pair || selection.wideChoice!=='paired')return null;
 const clock=previousEvent.quarter && previousEvent.gameClock && previousEvent.gameClock!=='시각 미기재'
  ? `${previousEvent.quarter}Q ${previousEvent.gameClock}` : `판독 ${previousEvent.number??'이전'}`;
 let row=typeof pair.sourceId==='string'&&/^(prepared|relay)-/.test(pair.sourceId)
  ? rows.find(item=>item.id===pair.sourceId) : null;
 if(!row && pair.sessionId && Number.isFinite(pair.startSeconds) && Number.isFinite(pair.frameIndex) && pair.frameIndex>=0 && Number.isFinite(pair.fps) && pair.fps>0){
  const time=pair.startSeconds+pair.frameIndex/pair.fps;
  const matches=rows.filter(item=>item.sessionId===pair.sessionId&&(!pair.matchId||!item.matchId||item.matchId===pair.matchId)
   && Number.isFinite(item.startSeconds)&&Number.isFinite(item.duration)&&item.duration>0&&item.startSeconds<=time&&time<item.startSeconds+item.duration);
  if(matches.length===1)row=matches[0];
 }
 return {clock,sourceId:row?.id??null};
}
// Trim only when a shared recording and elapsed segment time can be verified.
export function filterWideAfterPrevious(rows, marker) {
 const anchor=rows.find(row=>row.id===marker?.sourceId);
 if(!anchor?.sessionId||!Number.isFinite(anchor.startSeconds))return {rows,filtered:false,uncomparable:0};
 const sameRecording=row=>row.sessionId===anchor.sessionId&&(!anchor.matchId||!row.matchId||anchor.matchId===row.matchId);
 const comparable=row=>sameRecording(row)&&Number.isFinite(row.startSeconds);
 const kept=rows.filter(row=>comparable(row)&&row.startSeconds>=anchor.startSeconds);
 return {rows:kept,filtered:true,uncomparable:rows.filter(row=>!comparable(row)).length};
}
// Merge prepared copies with the original recording list at the same position.
// Existing source IDs remain intact so saved frame pairs never change identity.
export function mergeWideSources(local,remote){
 const used=new Set();
 const matches=(left,right)=>left.relayOrigin?.sessionId===right.sessionId&&left.relayOrigin?.partName===right.partName
  || left.sessionId===right.sessionId&&Number.isInteger(left.part)&&left.part===right.part;
 const originals=remote.map(row=>{const saved=local.find(item=>!used.has(item.id)&&matches(item,row));if(!saved)return row;used.add(saved.id);return {...row,...saved,label:row.label,remote:false};});
 return [...local.filter(row=>!used.has(row.id)),...originals];
}
export function mountFramePairing(host,{api,broadcast,onChange=()=>{},message=()=>{}}){
 host.innerHTML=`<div class="pair-panel"><video data-role="video" controls muted playsinline preload="none"></video><p data-role="firstFrameTime" class="help">첫 프레임 수신 시각: 미기록</p><p data-role="skipped" class="help" hidden>이 장면은 중계 화면만 사용합니다.</p><div class="transport" data-role="transport"><button type="button" class="secondary" data-step="-1" disabled>−1 프레임</button><input data-role="scrubber" type="range" min="0" max="1" value="0" aria-label="광각 프레임 이동" disabled><button type="button" class="secondary" data-step="1" disabled>+1 프레임</button><output data-role="time">F—</output></div><label class="field wide-source-field" data-role="sourceField">광각 구간<select data-role="source" disabled><option value="">광각 구간을 찾는 중…</option></select></label><p data-role="previous" class="wide-previous help" hidden></p><div class="pair-settings"><p data-role="help" class="help"></p><span data-role="badge" class="pair-badge">선택 전</span><div class="pair-tools"><button type="button" class="secondary" data-role="refresh">광각 구간 새로고침</button><button type="button" class="secondary" data-role="retry" hidden>광각 구간 다시 준비</button><button type="button" class="secondary" data-role="skip">이 장면은 중계만 사용</button></div><div hidden><select data-role="choice"><option value="pending">광각 확인 대기</option><option value="paired">중계와 같은 순간 연결</option><option value="skip">이 장면은 중계만 사용</option></select><input data-role="frame" type="number" min="0" step="1"></div><div data-role="controls"><div class="pair-candidates" data-role="candidates"></div><div class="pair-tools" data-role="parts"><button type="button" class="secondary" data-part="-1">이전 구간</button><button type="button" class="secondary" data-part="1">다음 구간</button></div><label class="pair-confirm"><input type="checkbox" data-role="confirmed">공·선수 동작을 비교하여 두 화면이 같은 순간임을 확인했습니다.</label><p class="help">중계와 광각을 각각 멈춘 뒤 확인하세요. ‘이 프레임 확정’으로 함께 저장합니다.</p></div><p data-role="status" role="status" class="help"></p></div></div>`;
 const panel=host.closest('#reviewPanel'),settings=panel?.querySelector('#wideSettings'),confirmation=panel?.querySelector('#pairConfirmation');
 if(settings)settings.replaceChildren(host.querySelector('.pair-settings'));
 if(confirmation)confirmation.replaceChildren((settings||host).querySelector('.pair-confirm'));
 const $=role=>host.querySelector(`[data-role="${role}"]`)||settings?.querySelector(`[data-role="${role}"]`)||confirmation?.querySelector(`[data-role="${role}"]`),v=$('video');let key=null,eid=null,rows=[],meta=null,generation=0,loadToken=0,dirty=false,bound=null,selected=null,loading=false,presented=null,target=null,suggested=null,previousEvent=null,selectionOutsideFilter=false,provider=null,remoteCache=null,preparationQueue=Promise.resolve();
 const notify=()=>{dirty=true;$('badge').textContent=$('choice').value==='skip'?'중계만 사용 · 저장 전':$('confirmed').checked?'같은 순간 확인 · 저장 전':'변경됨 · 같은 순간 확인 필요';onChange();};
 const frame=()=>target??presented??Math.max(0,Math.min((meta?.frames||1)-1,Math.floor(v.currentTime*(meta?.fps||30))));
 function revoke(){if($('confirmed').checked){$('confirmed').checked=false;bound=null;$('status').textContent='프레임이 바뀌었습니다. 두 화면의 같은 순간을 다시 확인하세요.';notify();}}
 function times(){if(!meta)return;const f=frame();$('frame').value=f;$('scrubber').value=f;$('time').textContent=`F${f} · ${(f/meta.fps).toFixed(3)}초`;
  if(bound&&bound.wideFrame!==f)revoke();}
 function transportEnabled(enabled){$('scrubber').disabled=!enabled;host.querySelectorAll('[data-step]').forEach(b=>b.disabled=!enabled);}
 function move(f){if(!meta)return;revoke();v.pause();target=Math.max(0,Math.min(meta.frames-1,Math.round(f)));v.currentTime=(target+.1)/meta.fps;times();notify();}
 async function loadSource(sid,f=null,seconds=0){
  const token=++loadToken,scene=generation;loading=true;meta=null;presented=null;target=null;transportEnabled(false);v.pause();v.removeAttribute('src');v.load();revoke();
  $('retry').hidden=true;$('status').textContent='선택한 광각 구간을 여는 중…';
  try{
   const source=rows.find(row=>row.id===sid);if(!source)throw Error('광각 구간을 다시 선택하세요.');
   $('source').value=sid;
   const recordedAt=formatFirstFrameReceived(source.firstFrameReceivedAt);
   $('firstFrameTime').textContent=recordedAt?`첫 프레임 수신 시각 · ${recordedAt} (한국 시간)`:'첫 프레임 수신 시각 · 미기록';
   let sourceId=sid,receipt=null,resumePlayback=false;
   if(source.remote){
    // Playback starts directly from the recording while a verified local
    // copy is prepared in the background for exact frame selection.
    v.onseeked=null;v.onloadedmetadata=()=>{if(token===loadToken)$('status').textContent='광각 영상을 볼 수 있습니다. 프레임 단위 준비 중…';};
    v.onerror=()=>{if(token===loadToken)$('status').textContent='광각 미리보기를 열지 못했습니다. 다시 준비해 주세요.';};
    v.src=source.previewUrl;v.load();
    const task=preparationQueue.then(()=>token===loadToken&&scene===generation?provider.prepare(source):null);
    preparationQueue=task.catch(()=>{});receipt=await task;if(token!==loadToken||scene!==generation||!receipt)return;
    const updated=await api(`/api/intake/${key}/wide/${eid}`);if(token!==loadToken||scene!==generation)return;
    const prepared=updated.sources.find(row=>row.relayOrigin?.sessionId===source.sessionId&&row.relayOrigin?.partName===source.partName);
    if(!prepared)throw Error('준비한 광각 구간을 찾지 못했습니다. 다시 시도하세요.');
    sourceId=prepared.id;
    rows=rows.map(row=>row.id===sid?{...source,...prepared,id:sourceId,remote:false,label:source.label}:row);
    const option=Array.from($('source').options).find(option=>option.value===sid);if(option)option.value=sourceId;
    $('source').value=sourceId;resumePlayback=!v.paused;seconds=Number.isFinite(v.currentTime)?v.currentTime:0;v.pause();
   }
   const result=await api(`/api/intake/${key}/wide/${eid}/info/${sourceId}`);if(token!==loadToken||scene!==generation)return;
   if(receipt&&result.sourceSha256!==receipt.sha256)throw Error('광각 원본이 변경됐습니다. 구간을 다시 준비하세요.');
   meta=result;transportEnabled(true);$('source').value=sourceId;$('scrubber').max=meta.frames-1;$('frame').max=meta.frames-1;
   target=Math.max(0,Math.min(meta.frames-1,f??Math.round(seconds*meta.fps)));v.src=meta.url;
   v.onloadedmetadata=()=>{if(token===loadToken){v.currentTime=(target+.1)/meta.fps;times();}};
   v.onseeked=()=>{if(token!==loadToken)return;loading=false;presented=target??Math.floor(v.currentTime*meta.fps);target=null;times();$('status').textContent='광각 프레임을 확인하고 같은 순간 연결을 선택하세요.';if(resumePlayback){resumePlayback=false;v.play().catch(()=>{});}};
   v.onerror=()=>{if(token===loadToken){loading=false;meta=null;transportEnabled(false);$('status').textContent='광각 영상을 열지 못했습니다. 구간 새로고침 후 다시 선택하세요.';}};
   v.load();
   if(v.requestVideoFrameCallback){const cb=(_,m)=>{if(token!==loadToken||!meta)return;presented=Math.min(meta.frames-1,Math.round(m.mediaTime*meta.fps));if(presented===target)target=null;times();v.requestVideoFrameCallback(cb);};v.requestVideoFrameCallback(cb);}
  }catch(e){if(scene===generation&&token===loadToken){loading=false;$('retry').hidden=false;$('status').textContent=e.message;message(e.message);}}
 }
 async function refresh(reset=true,force=false){
  const scene=generation;if(!key||!eid)return;
  $('help').textContent='확보한 광각 구간을 확인하는 중…';
  try{const result=await api(`/api/intake/${key}/wide/${eid}`);if(scene!==generation)return;selected=result.selection;
   let remoteError='';if(provider&&(remoteCache===null||force)){try{remoteCache=await provider.list();}catch(e){remoteError=e.message;}if(scene!==generation)return;}
   const available=mergeWideSources(result.sources,remoteCache||[]);
   const marker=previousWideMarker(available,previousEvent),filtered=filterWideAfterPrevious(available,marker);rows=filtered.rows;
   selectionOutsideFilter=!!selected&&filtered.filtered&&!rows.some(row=>row.id===selected.sourceId);
   const allowed=new Set(rows.map(row=>row.id)),candidates=result.candidates.filter(candidate=>allowed.has(candidate.sourceId));
   $('help').textContent=remoteError?`녹화 목록을 불러오지 못했습니다. ${remoteError}`:provider?(rows.length?'광각 구간을 선택하면 바로 볼 수 있습니다. 프레임 준비는 자동으로 진행됩니다.':'이 경기의 광각 녹화가 없습니다. 녹화 상태를 확인한 뒤 새로고침하세요.'):result.message;
   $('source').replaceChildren(new Option(rows.length?'광각 구간 선택':'사용 가능한 광각 구간 없음',''),...rows.map(r=>new Option(r.label+(marker?.sourceId===r.id?` · 이전 판독 ${marker.clock} 포함`:''),r.id)));$('source').disabled=!rows.length;
   const note=filtered.filtered?`이전 판독 ${marker.clock}이 포함된 구간부터 표시합니다.${filtered.uncomparable?' 시간 순서를 확인할 수 없는 다른 구간은 제외했습니다.':''}`:previousEvent?(marker?`이전 판독 ${marker.clock}의 구간 순서를 확인할 수 없어 전체 목록을 표시합니다.`:'이전 판독의 광각 연결이 확정되지 않아 전체 목록을 표시합니다.'):'';
   $('previous').textContent=note;$('previous').hidden=!note;
   $('candidates').hidden=candidates.length<2;
   $('candidates').replaceChildren(...candidates.map((c,i)=>{const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=`후보 구간 ${i+1}`;b.title=c.basis;b.onclick=()=>{notify();$('choice').value='paired';choice(false);loadSource(c.sourceId,null,c.seconds);};return b;}));
   if(reset){$('choice').value=result.wideChoice||'pending';$('badge').textContent=selectionOutsideFilter?'기존 저장 구간이 목록 범위 밖입니다 · 다시 확인':selected?'같은 순간 저장됨':result.wideChoice==='skip'?'중계만 사용':'확인 대기';dirty=false;}
   // Show the first available segment immediately; the operator can choose
   // another before confirming the exact shared instant.
   suggested=chooseWideSource(rows,selected,candidates);
   $('parts').hidden=rows.length<2;
   choice(false);
   if(suggested&&$('choice').value!=='skip')await loadSource(suggested.id,suggested.frameIndex??null,suggested.seconds??0);
  }catch(e){if(scene===generation){$('help').textContent=e.message;message(e.message);}}
 }
 function choice(changed=true){const skip=$('choice').value==='skip';$('controls').hidden=skip;if(confirmation)confirmation.hidden=skip;v.hidden=skip;$('firstFrameTime').hidden=skip;$('transport').hidden=skip;$('sourceField').hidden=skip;$('previous').hidden=skip||!$('previous').textContent;$('skipped').hidden=!skip;$('skip').textContent=skip?'광각 화면 사용':'이 장면은 중계만 사용';if(changed){revoke();notify();}if(skip){v.pause();$('status').textContent=changed?'중계만 사용을 선택했습니다. 이 프레임 확정으로 저장하세요.':'이 장면은 중계 화면만 사용합니다.';}else if(changed){$('status').textContent='광각과 중계 화면을 비교한 뒤 같은 순간인지 확인하세요.';}}
 $('choice').onchange=()=>choice();
 $('skip').onclick=()=>{const wasSkip=$('choice').value==='skip';if(!wasSkip&&loading){++loadToken;loading=false;meta=null;transportEnabled(false);$('retry').hidden=true;v.pause();v.removeAttribute('src');v.load();}$('choice').value=wasSkip?'pending':'skip';choice();if(wasSkip&&!meta){const current=rows.find(row=>row.id===$('source').value)||suggested;if(current)loadSource(current.id,current.frameIndex??null,current.seconds??0);}};
 $('source').onchange=()=>{if(!$('source').value)return;notify();$('choice').value='paired';choice(false);loadSource($('source').value);};
 $('refresh').onclick=()=>{if(dirty){message('변경한 프레임을 먼저 확정하거나 장면을 다시 열어주세요.');return;}refresh(true,true);};
 $('retry').onclick=()=>{if($('source').value)loadSource($('source').value);};
 for(const b of host.querySelectorAll('[data-step]'))b.onclick=()=>move(frame()+Number(b.dataset.step));
 for(const b of (settings||host).querySelectorAll('[data-part]'))b.onclick=()=>{const i=rows.findIndex(r=>r.id===$('source').value),r=rows[i+Number(b.dataset.part)];if(r){notify();loadSource(r.id);}};
 $('frame').onchange=()=>move(Number($('frame').value));$('scrubber').oninput=()=>move(Number($('scrubber').value));
 v.ontimeupdate=times;v.onplay=()=>{broadcast().pause();revoke();notify();};
 $('confirmed').onchange=()=>{if($('confirmed').checked){const b=broadcast();b.pause();v.pause();if(!meta||loading||v.seeking||v.readyState<2||b.seeking()){$('confirmed').checked=false;return message('두 영상의 프레임이 표시된 다음 확인하세요.');}
  $('choice').value='paired';bound={broadcastFrame:b.frame,broadcastSha256:b.sha,wideFrame:frame()};$('status').textContent='같은 순간 확인됨 · 이 프레임 확정을 눌러 저장하세요.';}else bound=null;notify();};
 return {
  async open(intake,event,previous=null){if(key!==intake){remoteCache=null;provider=fpcFrameSources(intake);}key=intake;eid=event;previousEvent=previous;$('previous').hidden=true;$('previous').textContent='';++generation;++loadToken;loading=false;dirty=false;bound=null;selected=null;meta=null;suggested=null;selectionOutsideFilter=false;transportEnabled(false);$('retry').hidden=true;$('time').textContent='F—';v.pause();v.removeAttribute('src');v.load();$('confirmed').checked=false;await refresh();},
  async refresh(){if(dirty)throw Error('변경한 광각 프레임을 먼저 저장하거나 장면을 다시 여세요.');await refresh();},
  dirty:()=>dirty,
  broadcastMoved(){const b=broadcast();if(bound&&(b.frame!==bound.broadcastFrame||b.sha!==bound.broadcastSha256))revoke();if(selected&&!dirty&&$('choice').value==='paired'&&(selected.broadcastFrame!==b.frame||selected.broadcastSha256!==b.sha)){$('confirmed').checked=false;bound=null;$('status').textContent='중계 프레임이 바뀌었습니다. 광각과 같은 순간인지 다시 확인하세요.';notify();}},
  value(){const b=broadcast(),c=$('choice').value;
   if(c!=='paired')return {wideChoice:c,widePair:null};
   // An unchanged saved pair is safe to keep without opening its video again.
   if(!dirty&&!selectionOutsideFilter&&selected&&selected.broadcastFrame===b.frame&&selected.broadcastSha256===b.sha)return {wideChoice:'paired',widePair:{...selected,confirmed:true}};
   if(!bound||!$('confirmed').checked||!meta||loading||v.seeking||bound.wideFrame!==frame()||bound.broadcastFrame!==b.frame||bound.broadcastSha256!==b.sha)throw Error('중계·광각을 같은 순간에 멈추고 확인 체크를 눌러주세요.');
   return {wideChoice:'paired',widePair:{sourceId:meta.id,sourceSha256:meta.sourceSha256,frameIndex:frame(),broadcastFrame:b.frame,broadcastSha256:b.sha,confirmed:true}};
  }
 };
}
