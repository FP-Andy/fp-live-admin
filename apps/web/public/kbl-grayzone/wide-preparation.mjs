const bytes=n=>n>=1024**3?`${(n/1024**3).toFixed(2)} GB`:`${(n/1024**2).toFixed(0)} MB`;
const duration=n=>`${Math.floor(n/3600)}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(Math.floor(n%60)).padStart(2,'0')}`;
async function api(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'광각 준비 상태를 확인하지 못했습니다.');return d;}

export function mountWidePreparation(container,{matchId,initialMatch=null,autoCheck=false}={}){
 let disposed=false,timer=null,match=initialMatch,state=null,selectedSession='',videoUrl='',actionBusy=false,linkBusy=false;
 container.classList.add('wide-preparation');
 container.innerHTML=`<div class="section-head"><div><small>PREPARATION / 광각 원본</small><h2>광각 영상 미리 준비</h2></div><span class="badge" data-wide="badge">확인 전</span></div>
 <p class="help">경기 전후에 원본을 받아두면 판독 자료를 받은 뒤 기다리는 시간을 줄일 수 있습니다. 다운로드는 한 번에 하나씩 진행합니다.</p>
 <p data-wide="message" role="status"></p><p class="help" data-wide="checked"></p>
 <div class="wide-actions"><button type="button" class="secondary" data-wide="link">FPC 경기 연결</button><button type="button" class="secondary" data-wide="refresh">녹화 목록 새로고침</button></div>
 <div data-wide="linkPanel" class="wide-link" hidden><label class="field">연결할 FPC 경기<select data-wide="fpc"></select></label><p class="help" data-wide="fpcNote"></p><div class="wide-actions"><button type="button" class="secondary" data-wide="fpcRefresh">최신 경기 불러오기</button><button type="button" data-wide="saveLink">이 경기 연결</button></div></div>
 <div data-wide="source" hidden><label class="field">광각 녹화 선택<select data-wide="sessions"></select></label><p data-wide="summary"></p>
 <progress data-wide="progress" max="100" value="0"></progress><div class="wide-actions"><button type="button" data-wide="cache">선택한 광각 원본 미리 확보</button><button type="button" class="secondary" data-wide="pause" hidden>일시정지</button><button type="button" data-wide="resume" hidden>받은 부분부터 이어받기</button></div>
 <details data-wide="preview"><summary>확보한 광각 구간 보기</summary><label class="field">원본 누적 시간<select data-wide="parts"></select></label><video data-wide="video" controls muted playsinline preload="none"></video><p class="help" data-wide="position"></p><p class="help">원본 누적 시간은 경기 시계와 다릅니다. 중계 화면의 쿼터·경기 시계·동작을 대조한 뒤 판독 장면으로 사용하세요.</p></details></div>`;
 const $=name=>container.querySelector(`[data-wide="${name}"]`);
 // FPC has already authorized and bound this match; do not offer relinking
 // from the embedded workbench, where cross-match changes are denied.
 if(location.pathname.startsWith('/api/courtside/'))$('link').hidden=true;
 const endpoint=action=>`/api/library/matches/${encodeURIComponent(matchId)}/wide${action?'/'+action:''}`;
 const message=text=>{$('message').textContent=text;};
 const later=(delay=2500)=>{clearTimeout(timer);if(!disposed&&state?.downloadActive)timer=setTimeout(()=>refresh().catch(e=>{error(e);later(5000);}),delay);};
 function error(e){if(!disposed)message(e.message);}
 function current(){return state?.recordings?.find(r=>r.session_id===selectedSession);}
 function controls(){
  if(disposed)return;
  const active=!!state?.downloadActive,linked=!!match?.fpcMatchId,r=current();
  $('refresh').disabled=actionBusy||active||!linked;$('link').disabled=actionBusy||active;
  $('sessions').disabled=actionBusy||active;
  $('cache').disabled=actionBusy||active||!r?.parts?.length||r.cachedParts===r.parts.length;
  $('pause').hidden=!active;$('pause').disabled=actionBusy;
  $('resume').hidden=!state?.resumeAvailable;$('resume').disabled=actionBusy;
  $('cache').hidden=active;
 }
 function renderParts(){
  const r=current(),parts=(r?.parts||[]).filter(p=>p.cached),old=$('parts').value;
  $('parts').replaceChildren(new Option('재생할 구간을 선택하세요.',''),...parts.map(p=>new Option(`${duration(p.start_seconds)}–${duration(p.start_seconds+p.duration)} · 구간 ${p.index+1}`,String(p.index))));
  if(parts.some(p=>String(p.index)===old))$('parts').value=old;
  $('preview').hidden=!parts.length;
  if(!parts.some(p=>p.url===videoUrl)){videoUrl='';$('video').pause();$('video').removeAttribute('src');$('video').load();}
 }
 function render(){
  if(disposed)return;
  const names={idle:'확인 전',unlinked:'연결 필요',queued:'준비 대기',running:'준비 중',listed:'원본 확보 대기',waiting:'녹화 대기',prepared:'원본 준비 완료',paused:'일시정지',interrupted:'이어받기 가능',failed:'연결 확인'};
  $('badge').textContent=names[state.state]||state.state;message(state.message);
  $('link').textContent=match?.fpcMatchId?'FPC 경기 연결 변경':'FPC 경기 연결';
  $('checked').textContent=state.checkedAt?`녹화 목록 확인 ${new Date(state.checkedAt).toLocaleString('ko-KR')}`:'';
  const records=state.recordings||[];
  if(state.downloadActive||!records.some(r=>r.session_id===selectedSession))selectedSession=state.selectedSessionId||'';
  $('sessions').replaceChildren(new Option('녹화를 선택하세요.',''),...records.map(r=>new Option(`${r.created_at?new Date(r.created_at).toLocaleString('ko-KR'):''} · ${duration(r.duration)} · ${bytes(r.bytes)}${r.recordingActive?' · 녹화 중':''}`,r.session_id)));
  $('sessions').value=selectedSession;$('source').hidden=!records.length;
  renderSummary();renderParts();controls();later();
 }
 function renderSummary(){
  const r=current();
  if(!r){$('summary').textContent='동일 경기의 녹화가 여러 개이면 사용할 녹화를 선택하세요.';$('progress').value=0;return;}
  const inProgress=state.downloadActive&&r.session_id===state.selectedSessionId;
  const done=Math.min(r.bytes,Math.max(r.cachedBytes,inProgress?state.receivedBytes||0:0));
  $('summary').textContent=`확보 ${r.cachedParts}/${r.parts.length}개 · ${bytes(done)} / ${bytes(r.bytes)} · 저장 공간 ${bytes(state.freeBytes)}${r.interruptions?` · 수신 중단 기록 ${r.interruptions}회`:''}${r.recordingActive?' · 녹화 종료 후 추가 구간 확인 필요':''}`;
  $('progress').value=r.bytes?done/r.bytes*100:0;
 }
 async function refresh(){if(disposed)return;state=await api(endpoint());render();}
 async function act(action){
  if(actionBusy||disposed)return;actionBusy=true;controls();
  try{state=await api(endpoint(action),{sessionId:(action==='resume'?state.selectedSessionId:selectedSession)||undefined});render();}catch(e){error(e);}finally{actionBusy=false;controls();}
 }
 $('refresh').onclick=()=>act('refresh');$('cache').onclick=()=>act('cache');$('pause').onclick=()=>act('pause');$('resume').onclick=()=>act('resume');
 $('sessions').onchange=()=>{selectedSession=$('sessions').value;renderSummary();renderParts();controls();};
 $('preview').ontoggle=()=>{if(!$('preview').open)$('video').pause();};
 $('parts').onchange=()=>{
  const part=current()?.parts.find(p=>String(p.index)===$('parts').value&&p.cached);if(!part)return;
  videoUrl=part.url;$('video').pause();$('video').src=part.url;$('video').load();
  $('position').textContent=`원본 누적 ${duration(part.start_seconds)}부터 · ${part.duration.toFixed(1)}초 구간`;
 };
 async function loadFpc(force=false){
  if(linkBusy||disposed)return;linkBusy=true;$('fpcRefresh').disabled=true;$('saveLink').disabled=true;
  try{
   let list=await api('/api/library/fpc'+(force?'/refresh':''),force?{}:undefined);
   for(let attempts=0;list.sync?.state==='running'&&attempts<25&&!disposed;attempts++){
    $('fpcNote').textContent='FPC 최신 경기 목록을 불러오는 중입니다.';await new Promise(r=>setTimeout(r,1000));list=await api('/api/library/fpc');
   }
   if(disposed)return;
   const teams=m=>m.home===match.home&&m.away===match.away;
   const rows=list.matches.filter(teams);
   $('fpc').replaceChildren(new Option('같은 홈·원정팀의 경기를 선택하세요.',''),...rows.map(m=>new Option(`${m.date} · ${m.home} vs ${m.away}${m.dateBasis==='registered-at'?' · FPC 등록일 기준':m.dateBasis==='recording-start'?' · 녹화 시작일 기준':''}`,m.id)));
   if(rows.some(m=>m.id===match.fpcMatchId))$('fpc').value=match.fpcMatchId;
   $('fpcNote').textContent=['failed','interrupted'].includes(list.sync?.state)?list.sync.message:list.sync?.state==='running'?'목록을 갱신 중입니다. 잠시 후 최신 경기 불러오기를 눌러 확인하세요.':`${rows.length}개 경기 · 날짜와 대진을 확인하세요.${list.fetchedAt?' 마지막 동기화 '+new Date(list.fetchedAt).toLocaleString('ko-KR'): ' 최신 경기 불러오기를 눌러 목록을 갱신하세요.'}${list.sync?.skipped?' '+list.sync.message:''}`;
  }catch(e){if(!disposed)$('fpcNote').textContent=e.message;}finally{linkBusy=false;if(!disposed){$('fpcRefresh').disabled=false;$('saveLink').disabled=false;}}
 }
 $('link').onclick=()=>{$('linkPanel').hidden=!$('linkPanel').hidden;if(!$('linkPanel').hidden)loadFpc();};
 $('fpcRefresh').onclick=()=>loadFpc(true);
 $('saveLink').onclick=async()=>{
  const fpcMatchId=$('fpc').value;if(!fpcMatchId)return;
  $('saveLink').disabled=true;
  try{match=await api(`/api/library/matches/${encodeURIComponent(matchId)}/fpc`,{fpcMatchId,expectedFpcMatchId:match.fpcMatchId||null});if(disposed)return;$('linkPanel').hidden=true;await refresh();if(match.preparationWarning)message(match.preparationWarning);}catch(e){error(e);}finally{if(!disposed)$('saveLink').disabled=false;}
 };
 const ready=(async()=>{
  match??=await api(`/api/library/matches/${encodeURIComponent(matchId)}`);
  await refresh();
  if(autoCheck&&match.fpcMatchId&&state.state==='idle')await act('refresh');
 })().catch(error);
 return {ready,refresh:()=>refresh().catch(error),dispose(){disposed=true;clearTimeout(timer);$('video').pause();}};
}
