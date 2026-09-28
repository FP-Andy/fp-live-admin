import { validateReview, emptyReview, boxesAt, identityAt, trackRange, assign, importEvents, eventPatches, label, clock, clone } from './core.mjs';
import { RecoveryClient } from './recovery-client.mjs';
import { emptyRecovery, hydrateRecovery, recoverySignature } from './recovery-protocol.mjs';
import { setupUI } from './setup-ui.mjs';
import { uniformAt } from './integrity.mjs';
import {classifyKit} from './keeper-context.mjs';
import { courtPosition } from './boundary.mjs';
import { fpaUI } from './fpc-ui.mjs';
import { workbenchShell } from './shell.mjs';
import { heatmapUI } from './heatmap-ui.mjs';
import { checkpointUI } from './checkpoint-ui.mjs';
import { ReviewBatch,previewSegments } from './review-batch.mjs';
import {lineupUI} from './lineup.mjs';
import {ServerReview} from './server-review.mjs';

const $ = id => document.getElementById(id);
const video = $('video');
let data = null, review = null, selected = null, filter = 'visible', undo = [], mediaOffset = 0, mediaReady = false, objectURL = null;
let currentBoxes = [], lastList = '', lastTime = -1, mediaKind = 'preview';
let working = null, recovery = null, resultMedia = null;
let batch=null, loadRevision=0, loadingDataset=false;
let serverReview=null;
window.addEventListener('beforeunload',event=>{if(serverReview?.dirty){event.preventDefault();event.returnValue='';}});
let datasetBinding=null;
const recoveryClient=new RecoveryClient({onProgress:showRecoveryProgress});
const colors = { home: '#ffac70', away: '#73b6ff', referee:'#ebe7a9', ignore: '#96a0af', unknown: getComputedStyle(document.documentElement).getPropertyValue('--fp-brand').trim() || '#ff7400' };
const sourceTime = () => video.currentTime + mediaOffset;
const message = (text, error = false) => { $('message').textContent = text; $('message').classList.toggle('error', error); };
const guard = action => async event => { try { await action(event); } catch (error) { message(error.message || String(error), true); } };
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
const storageKey = () => `fpa-cv-review:${data.datasetId}`;
const setup = setupUI({getData:()=>data,getReview:()=>review,getWorking:()=>working,getRecovery:()=>recovery,commit,seek,time:sourceTime,selectTrack,message,video});
const lineup=lineupUI({holder:$('lineup-content'),getReview:()=>review,commit,message});

const fpa=fpaUI({getData:()=>data,getReview:()=>review,getWorking:()=>working,commit:next=>commit(next,false),saveDraft:next=>{review=next;if(working)working={...working,events:next.events,links:next.links,fpa:next.fpa};persist();},seek,time:sourceTime,pause:()=>video.pause(),message,canUndo:()=>undo.length>0,undo:()=>$('undo').click()});
const heatmaps=heatmapUI({getData:()=>data,getWorking:()=>working,getRecovery:()=>recovery,message});
const checkpoints=checkpointUI({getData:()=>data,getReview:()=>review,getWorking:()=>working,getRecovery:()=>recovery,commit,seek,time:sourceTime,video,message,onChange:render,apply:applyReview,isPending:()=>!!batch?.dirty});
let workMode='fpa';
$('review-workspace').append($('player-inspector'),$('reconnect-panel'));
function selectMode(mode){
  workMode=mode;
  for(const button of document.querySelectorAll('[data-work-mode]')){const selected=button.dataset.workMode===mode;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
  $('fpc-editor').hidden=mode!=='fpa';$('review-workspace').hidden=mode!=='review';$('heatmap-workspace').hidden=mode!=='heatmap';$('checkpoint-workspace').hidden=mode!=='checkpoints';
  if(mode==='review'){$('player-inspector').open=true;$('reconnect-panel').open=true;}
  if(mode==='heatmap')heatmaps.open();
  if(mode==='checkpoints')checkpoints.render();
}
const modeButtons=[...document.querySelectorAll('[data-work-mode]')];
for(const [index,button] of modeButtons.entries()){
  button.onclick=()=>selectMode(button.dataset.workMode);
  button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?modeButtons.length-1:(index+(event.key==='ArrowRight'?1:-1)+modeButtons.length)%modeButtons.length;modeButtons[next].focus();modeButtons[next].click();};
}

async function jsonFile(file) {
  if (!file) throw Error('파일을 선택하세요.');
  if (file.size > 150 * 1024 * 1024) throw Error('JSON이 150MB를 초과합니다. 분석 구간을 나눠 주세요.');
  return JSON.parse(await file.text());
}
function persist() {
  try { localStorage.setItem(storageKey(), JSON.stringify(review)); $('save-state').textContent = '브라우저 자동 저장됨'; }
  catch { $('save-state').textContent = '자동 저장 공간이 부족합니다. 작업 백업으로 저장하세요.'; message('자동 저장하지 못했습니다. 작업 백업을 눌러 JSON을 저장하세요.', true); }
  if(serverReview&&data?.datasetId===serverReview.datasetId)serverReview.stage(review);
}
function commit(next) {
  undo.push(clone(review)); if (undo.length > 50) undo.shift();
  // Review history must not roll back the last successfully applied snapshot.
  const state=batch?.state(),identityChanged=recoverySignature(next)!==recoverySignature(review);
  review=state?{...next,batch:state}:next;
  if(identityChanged)heatmaps.invalidate();
  persist();refresh();
}
function showRecoveryProgress(info) {
  $('recovery-status').hidden=false;
  const progress=$('recovery-progress');
  if(info.total>0){progress.max=info.total;progress.value=info.completed;}
  else progress.removeAttribute('value');
  progress.hidden=false;
  $('recovery-label').textContent=info.phase+(info.total>0?` · ${info.completed.toLocaleString()} / ${info.total.toLocaleString()} 프레임`:'');
  $('recovery-note').textContent=loadingDataset?'대용량 결과를 불러오는 중입니다.':'제출한 검수 계산 중 · 추가 수정은 다음 반영을 위해 저장됩니다.';
  $('recovery-action').hidden=loadingDataset;
  $('recovery-action').disabled=false;
  $('recovery-action').textContent='계산 중지';
}
function rebuildWorking() {
  working={...review,segments:previewSegments(review,recovery,batch?.applied),duplicateAliases:recovery.duplicates};
}
function refresh() {
  if(review&&data){
    recovery=batch?.view||emptyRecovery(data,'cancelled');
    rebuildWorking();setup.configuration();lineup.render();
    if(!loadingDataset){renderBatchStatus();renderCycle();}
  }
  lastList='';$('undo').disabled=!undo.length;renderHistory();fpa.refresh();checkpoints.render();render();
}
function renderBatchStatus(){
  if(!batch)return;
  $('recovery-status').hidden=false;
  if(batch.running){$('recovery-note').textContent='제출한 검수 계산 중 · 추가 수정은 다음 반영을 위해 저장됩니다.';return;}
  $('recovery-progress').hidden=true;
  $('recovery-action').hidden=false;
  $('recovery-action').disabled=!batch.dirty&&!!batch.result&&!batch.error;
  $('recovery-action').textContent='검수 반영 · 재연결';
  const revision=batch.round?`${batch.round+1}차 결과`:'1차 초벌 결과';
  $('recovery-label').textContent=batch.error|| (batch.dirty?`${revision} · 수정 반영 대기`:`${revision} · 검수 가능`);
  $('recovery-note').textContent=batch.dirty?`${batch.changes.join(' · ')} 수정 저장됨 · 모두 수정한 뒤 한 번에 반영하세요.`:'추가 태깅 → 검수 반영을 필요한 만큼 반복하고 히트맵을 저장하세요.';
}
function renderCycle(){
  if(!batch)return;
  $('review-cycle').hidden=false;
  const version=batch.round+1,next=version+1,reviewing=review.workflow?.reviewing||batch.dirty;
  $('cycle-title').textContent=batch.running?`${version}차 결과 · 연결 계산 중`:reviewing?`${next}차 검수 중 · 현재 ${version}차 결과 참고`:`${version}차 ${version===1?'초벌 ':''}결과`;
  $('cycle-note').textContent=batch.dirty?`${batch.changes.join(' · ')} 저장됨. 수정들을 모아 다음 결과를 만드세요.`:reviewing?'추천 장면이나 원하는 시점에서 BB와 선수 번호를 연결하고 확인 저장을 누르세요.':'결과를 확인하고, 필요한 만큼 추가 검수하거나 히트맵을 저장하세요.';
  $('cycle-start').textContent=`${next}차 검수 시작`;$('cycle-start').hidden=reviewing||batch.running;
  $('cycle-apply').textContent=`수정 모아 ${next}차 결과 만들기`;$('cycle-apply').disabled=!batch.dirty||batch.running;
  $('cycle-heatmap').disabled=batch.view.status!=='complete';
  $('cycle-count').textContent=`· ${version}차`;
  const list=$('cycle-history');list.replaceChildren();
  for(const h of [...batch.history].reverse())list.append(text('li',`${h.version}차 ${h.version===1?'초벌':'검수 반영'} · ${new Date(h.completedAt).toLocaleString('ko-KR')} · 확인 ${h.checkpoints}장면${h.changes.length?' · '+h.changes.join(', '):''}`));
}
function beginReview(mode='checkpoints'){
  if(!review||!batch)return;
  review={...review,workflow:{reviewing:true}};persist();renderCycle();selectMode(mode);
  document.querySelector(`[data-work-mode="${mode}"]`).focus();
}
$('cycle-start').onclick=()=>beginReview();
$('cycle-scenes').onclick=()=>beginReview();
$('cycle-tracks').onclick=()=>beginReview('review');
$('cycle-heatmap').onclick=()=>selectMode('heatmap');
$('cycle-apply').onclick=applyReview;
function applyReview(){
  if(!batch||loadingDataset||batch.running)return;
  if(checkpoints.hasUnsaved()){message('현재 장면의 확인을 먼저 저장하거나 취소하세요.',true);return;}
  message('');heatmaps.invalidate();const submitted=batch;
  void submitted.run().then(ok=>{if(ok&&submitted===batch&&!batch.dirty){review={...review,workflow:{reviewing:false}};persist();refresh();}});
}
function showRecoveryStopped(reason) {
  $('recovery-status').hidden=false;$('recovery-progress').hidden=true;
  $('recovery-label').textContent=reason;
  $('recovery-note').textContent='수동 지정과 FPA 기록은 유지됩니다.';
  $('recovery-action').hidden=false;$('recovery-action').disabled=false;$('recovery-action').textContent='검수 반영 · 재연결';
}
$('recovery-action').onclick=()=>{
  if(!data||loadingDataset)return;
  if(batch?.running)batch.cancel();else applyReview();
};
async function loadDataset(source) {
  heatmaps.invalidate();
  loadingDataset=true;batch?.cancel();
  // Discard automatic labels from an interrupted calculation, never manual work.
  if(data){recovery=emptyRecovery(data,'cancelled');refresh(false);}
  showRecoveryProgress({phase:'트래킹 결과 읽는 중'});
  return recoveryClient.load(source);
}
function setDataset(value, initialReview = null) {
  // Already validated inside the worker, including manually opened JSON files.
  const next = value;
  if(serverReview&&serverReview.datasetId!==next.datasetId)serverReview=null;
  loadingDataset=false;batch=null;
  datasetBinding={source:recoveryClient.source,contentHash:recoveryClient.contentHash};
  resultMedia = null;
  video.pause(); mediaReady = false; video.removeAttribute('src'); video.load();
  if (objectURL) URL.revokeObjectURL(objectURL); objectURL = null;
  data = next; review = emptyReview(data); selected = null; undo = [];
  recovery=null;working=null;
  if(data.detector.teamConstraint?.uniforms)review=validateReview({...review,uniforms:data.detector.teamConstraint.uniforms},data);
  setup.stopPick();
  try {
    const saved = localStorage.getItem(storageKey());
    if(serverReview){review=validateReview(serverReview.initial||initialReview||review,data);message('FPC 서버의 작업을 불러왔습니다.');}
    else if (saved) { review = validateReview(JSON.parse(saved), data); message('이 트래킹 실행의 이전 검수를 복원했습니다.'); }
    else if(initialReview) { review=validateReview(initialReview,data);message('새 실행의 초기 선수 지정과 유니폼 색상을 불러왔습니다.'); }
    else message('트래킹을 열었습니다. 일치하는 원본 영상 또는 preview.mp4를 열어 주세요.');
  } catch { message('이전 자동 저장을 읽지 못했습니다. 내보낸 검수 JSON을 불러올 수 있습니다.', true); }
  review={...review,events:review.events.map(e=>({...e,row:{...e.row,FpaEventId:e.row.FpaEventId||crypto.randomUUID()}}))};
  $('video-info').textContent = `${data.video.name} · ${data.video.width} × ${data.video.height} · 분석 ${clock(data.video.clipStart)}–${clock(data.video.clipEnd)}`;
  $('model-name').textContent = `${data.detector.model || 'YOLO26'} · ByteTrack${data.detector.teamConstraint?.enabled?' + 팀 색상':''} · ${data.detector.sampleFps.toFixed(1)} fps`;
  $('export').disabled = false; $('assign-fields').disabled = true; $('selected-track').textContent = '선택 대기';
  $('seek').min = data.video.clipStart; $('seek').max = data.video.clipEnd;
  $('end-time').textContent = clock(data.video.clipEnd); $('stage').style.aspectRatio = `${data.video.width}/${data.video.height}`;
  $('empty').hidden = false;
  $('tracking-setup').open=!review.setup;fpa.reset();
  batch=new ReviewBatch({data,getReview:()=>review,saveState:state=>{review={...review,batch:state};persist();},compute:snapshot=>recoveryClient.compute(snapshot),hydrate:hydrateRecovery,cancel:()=>recoveryClient.cancel(),onChange:()=>{
    heatmaps.invalidate();refresh();
    if(batch.running)showRecoveryProgress({phase:'저장된 검출로 선수 연결 계산'});
    else if(workMode==='heatmap'&&!batch.dirty&&!batch.error)heatmaps.open();
  }});
  refresh();void batch.run({restore:true});
}
function seek(time) {
  if (!mediaReady) return;
  const min = Math.max(data.video.clipStart, mediaOffset), max = Math.min(data.video.clipEnd, mediaOffset + video.duration);
  video.currentTime = Math.max(min, Math.min(max - 1 / data.video.fps, time)) - mediaOffset;
  render();
}
function setMedia(src, kind) {
  if (!data) throw Error('먼저 트래킹 결과(tracks.json)를 열어 주세요. 영상만으로는 트래킹이 실행되지 않습니다.');
  video.pause(); mediaReady = false; mediaKind = kind;
  $('video-mode').value = kind; mediaOffset = kind === 'preview' ? data.video.clipStart : 0;
  video.src = src; video.load();
}
video.addEventListener('loadedmetadata', () => {
  if (!data) return;
  const expected = mediaKind === 'preview' ? data.video.clipEnd - data.video.clipStart : data.video.duration;
  if (!Number.isFinite(video.duration) || Math.abs(video.duration - expected) > 0.3 || Math.abs(video.videoWidth / video.videoHeight - data.video.width / data.video.height) > 0.02) {
    mediaReady = false; $('empty').hidden = false;
    message('영상 길이 또는 화면 비율이 트래킹과 다릅니다. 맞는 파일과 영상 기준(미리보기/전체 원본)을 선택하세요.', true); return;
  }
  mediaReady = true; $('empty').hidden = true; video.currentTime = Math.max(0, (review.setup?.time ?? data.video.clipStart) - mediaOffset);
  $('source-note').textContent = `화면 시간 = 원본 시각 · 미리보기 시작 ${clock(data.video.clipStart)}`;
  fpa.alignNewTime();message(''); render();
});
video.addEventListener('error', () => { if (video.getAttribute('src')) message('영상을 재생하지 못했습니다. H.264 preview.mp4를 열어 주세요.', true); });
video.addEventListener('play', () => { $('play').textContent = 'Ⅱ'; });
video.addEventListener('pause', () => { $('play').textContent = '▶'; render(); });
video.addEventListener('seeked', render);
video.addEventListener('ended', render);

function selectTrack(id, jump = false) {
  video.pause(); selected = id;
  if(workMode==='checkpoints'){checkpoints.selectTrack(id);lastList='';render();return;}
  if (jump && !currentBoxes.some(b => b.id === id)) seek(data.tracks.find(t => t.id === id).first);
  const identity = identityAt(working, id, sourceTime());
  if(workMode!=='fpa'||!fpa.matching())selectMode('review');
  $('assign-fields').disabled = false; $('selected-track').textContent = `TRACK #${id}`;
  const [from, to] = trackRange(data, id);
  $('range-from').value = from.toFixed(6); $('range-to').value = to.toFixed(6);
  $('scope').value = 'all'; $('range-fields').hidden = true;
  if(identity?.source==='auto'){
    $('scope').value='range';$('range-fields').hidden=false;
    $('range-from').value=identity.from;$('range-to').value=identity.to;
  }
  $('selection-info').textContent = `원본 ${clock(from)}–${clock(to)} · ${data.tracks.find(t => t.id === id).samples}개 검출`;
  setup.selected(id,identity,currentBoxes.find(b=>b.id===id)); renderHistory(); lastList = ''; render();
}
function renderHistory() {
  const holder = $('history'); holder.replaceChildren();
  if (!review || selected === null) { holder.textContent = '트랙을 선택하면 지정 구간을 볼 수 있습니다.'; return; }
  const items = working.segments.filter(s => s.trackId === selected);
  if (!items.length) holder.textContent = '아직 지정된 번호가 없습니다.';
  for (const s of items) {
    const identity=identityAt(working,s.trackId,s.from);
    const button = text('button', `${s.source==='auto'?'자동 · ':''}${label(identity, selected)}`); button.append(text('small', `${clock(s.from)} → ${clock(s.to)} (끝 시각 미포함)`));
    button.onclick = () => seek(s.from+Math.min(.001,(s.to-s.from)/2)); holder.append(button);
  }
}
function drawCrop(box) {
  const canvas = $('crop'), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  delete canvas.dataset.source;
  $('crop-empty').hidden = !!box && video.readyState >= 2;
  if (!box || video.readyState < 2) return;
  const [x1, y1, x2, y2] = box.box, pad = (x2 - x1) * .35;
  const x = Math.max(0, x1-pad) * video.videoWidth, y = Math.max(0, y1-pad) * video.videoHeight;
  const w = Math.min(video.videoWidth-x, (x2-x1+2*pad) * video.videoWidth), h = Math.min(video.videoHeight-y, (y2-y1+2*pad) * video.videoHeight);
  const scale = Math.min(canvas.width/w, canvas.height/h);
  canvas.dataset.source=JSON.stringify({x,y,w,h,dx:(canvas.width-w*scale)/2,dy:(canvas.height-h*scale)/2,scale});
  ctx.drawImage(video, x,y,w,h,(canvas.width-w*scale)/2,(canvas.height-h*scale)/2,w*scale,h*scale);
}
function render() {
  if (!data) return;
  const time = sourceTime();
  if (mediaReady && time >= data.video.clipEnd && !video.paused) video.pause();
  $('time').textContent = clock(time); $('seek').value = time;
  const rawBoxes = mediaReady && !video.seeking ? boxesAt(data, time) : [];
  currentBoxes = mediaReady && !video.seeking ? boxesAt(recovery?.data||data, time) : [];
  const displayBoxes=$('show-raw').checked?rawBoxes:currentBoxes;
  const boxHolder = $('boxes'); boxHolder.replaceChildren();
  // Account for letterboxing, including fullscreen and resized windows.
  const stage = $('stage'), scale = Math.min(stage.clientWidth/data.video.width, stage.clientHeight/data.video.height);
  const dw = data.video.width*scale, dh = data.video.height*scale;
  boxHolder.style.cssText = `left:${(stage.clientWidth-dw)/2}px;top:${(stage.clientHeight-dh)/2}px;width:${dw}px;height:${dh}px;right:auto;bottom:auto`;
  for (const box of displayBoxes) {
    const identity = (workMode==='checkpoints'?checkpoints.identity(box.id,time):null)||identityAt(working, box.id, time);
    const duplicate=recovery.duplicates.find(d=>d.trackId===box.id&&d.from<=time&&time<d.to);
    const held=recovery.masks.some(m=>m.trackId===box.id&&m.from<=time&&time<m.to)&&!identity;
    const uniform=uniformAt(recovery.timeline,box.id,time)||classifyKit(box,time,review.uniforms,recovery.keeperContext);
    if (identity?.team === 'ignore' && !$('show-ignored').checked) continue;
    const boundaryCandidate=!identity&&courtPosition(box.box,data.detector.roi,data.video.width/data.video.height)?.inside===false;
    const button = text('button', '', `box${selected === box.id ? ' selected' : ''}${identity?.source==='auto'?' automatic':''}${boundaryCandidate?' boundary-candidate':''}`), [x1,y1,x2,y2] = box.box;
    const detectedTeam=uniform.group?.startsWith('home')?'home':uniform.group?.startsWith('away')?'away':uniform.group;
    button.style.cssText = `left:${x1*100}%;top:${y1*100}%;width:${(x2-x1)*100}%;height:${(y2-y1)*100}%;--ink:${colors[identity?.team || detectedTeam || 'unknown']}`;
    const boxLabel=duplicate?`중복 #${box.id} → #${duplicate.canonicalTrackId}`:identity?`${identity.checkpoint?'✓ ':identity.source==='auto'?'≈ ':''}${label(identity,box.id)}`:`${held?'팀 충돌 · ':detectedTeam==='home'?`홈${uniform.group==='home_gk'?' GK':''} 추정 · `:detectedTeam==='away'?`원정${uniform.group==='away_gk'?' GK':''} 추정 · `:boundaryCandidate?'경계 ':''}#${box.id}`;
    button.setAttribute('aria-label', `${boxLabel} · 트랙 ${box.id}`);
    button.title = `트랙 #${box.id} · 검출 신뢰도 ${(box.confidence*100).toFixed(0)}%`;
    if ($('show-labels').checked) button.append(text('span',boxLabel));
    // Stop on pointerdown: playing video replaces boxes every frame, so waiting
    // for click can lose the target between mousedown and mouseup.
    button.onpointerdown = event => { event.preventDefault(); selectTrack(box.id); if(workMode==='fpa')void fpa.selectPlayer(box.id,time); };
    button.onclick = event => { if (event.detail === 0) {selectTrack(box.id); if(workMode==='fpa')void fpa.selectPlayer(box.id,time);} };
    boxHolder.append(button);
  }
  drawCrop(rawBoxes.find(b => b.id === selected));
  const assigned = currentBoxes.filter(b => { const i = identityAt(working, b.id, time); return i && i.team !== 'ignore'; }).length;
  $('coverage').textContent = `${rawBoxes.length}개 원본 · 중복 ${rawBoxes.length-currentBoxes.length}개 ${$('show-raw').checked?'표시 중':'숨김'} · ${assigned}개 명단 지정`;
  const duplicate = new Map();
  for (const box of currentBoxes) {
    const i = identityAt(working, box.id, time); if (!i || i.team === 'ignore') continue;
    const key = label(i, box.id); duplicate.set(key, [...(duplicate.get(key) || []), box.id]);
  }
  const conflicts = [...duplicate].filter(([, ids]) => ids.length > 1);
  $('conflict').hidden = !conflicts.length;
  $('conflict').textContent = conflicts.map(([name, ids]) => `${name}: 트랙 ${ids.map(i=>'#'+i).join(', ')}가 동시에 보입니다. 중복 검출 또는 잘못된 연결인지 확인하세요.`).join(' ');
  const listSignature = JSON.stringify([filter, selected, currentBoxes.map(b => [b.id, identityAt(working,b.id,time)]), working.segments]);
  if (listSignature !== lastList) { lastList = listSignature; renderTracks(time); }
  setup.live(currentBoxes,selected);
  if(workMode==='checkpoints')checkpoints.paint();
}
function renderTracks(time) {
  const holder = $('track-list'); holder.replaceChildren();
  const list = data.tracks.filter(t => filter === 'visible' ? currentBoxes.some(b => b.id === t.id) : filter === 'unassigned' ? !identityAt(working,t.id, Math.max(t.first, Math.min(time,t.last))) : true);
  $('track-count').textContent = list.length;
  for (const t of list) {
    const at = Math.max(t.first,Math.min(time,t.last)), identity = identityAt(working,t.id,at);
    const button = text('button', label(identity,t.id), `track-item${selected === t.id ? ' selected' : ''}`);
    button.style.setProperty('--ink', colors[identity?.team || 'unknown']);
    button.append(text('small', `#${t.id} · ${clock(t.first)}–${clock(t.last)}`));
    button.onclick = () => selectTrack(t.id,true); holder.append(button);
  }
  if (!list.length) holder.append(text('p', '이 범위에 표시할 트랙이 없습니다.', 'muted'));
}
function assignmentRange() {
  if (selected === null) throw Error('트랙을 선택하세요.');
  const [min,max] = trackRange(data,selected), scope = $('scope').value;
  return scope === 'all' ? [min,max] : scope === 'after' ? [Math.max(min,sourceTime()),max] : [Number($('range-from').value),Number($('range-to').value)];
}
$('assign-form').onsubmit = guard(event => {
  event.preventDefault();
  const [from,to] = assignmentRange(), submission=setup.submitted(),identity=submission.identity;
  commit(assign(submission.review,data,selected,from,to,identity));
  message(`${label(identity,selected)} · ${clock(from)}–${clock(to)} 구간에 적용했습니다.`);
});
$('clear').onclick = guard(() => { const [from,to] = assignmentRange(); const identity=identityAt(working,selected,sourceTime());let next=assign(review,data,selected,from,to,null);if(identity?.source==='auto')next={...next,rejections:[...next.rejections,{trackId:selected,personId:identity.personId,from,to}]};commit(next);message('선택 구간의 선수 지정을 해제했습니다.'); });
$('exclude-track').onclick = guard(() => { const [from,to] = assignmentRange();video.pause();commit(assign(review,data,selected,from,to,{team:'ignore',jersey:'',source:'manual'}));message(`BB #${selected} · ${clock(from)}–${clock(to)} 제외됨 · 되돌리기로 복원할 수 있습니다.`); });
$('scope').onchange = () => { $('range-fields').hidden = $('scope').value !== 'range'; };
$('undo').onclick = () => { if (undo.length) { const previous=undo.pop(),changed=recoverySignature(previous)!==recoverySignature(review);review={...previous,batch:batch.state()};if(changed)heatmaps.invalidate();persist();refresh(); void fpa.reloadSelection(); message('직전 검수 변경을 되돌렸습니다.'); } };
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active',b===button)); lastList = ''; render(); };
$('tracks-file').onchange = guard(async event => {
  const file=event.target.files[0];event.target.value='';if(!file)return;
  const revision=++loadRevision;
  try {
    const payload=await loadDataset(file);if(revision!==loadRevision)return;
    setDataset(payload);const url=new URL(location.href);url.searchParams.delete('job');url.searchParams.delete('autoload');history.replaceState(null,'',url);
  } catch(error){if(revision===loadRevision)failedDatasetLoad(error);}
});
$('video-file').onchange = guard(event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  if (!data) throw Error('트래킹 JSON을 먼저 열어 주세요.');
  const kind = file.name === data.video.name ? 'original' : 'preview';
  if (kind === 'original' && data.video.sizeBytes && file.size !== data.video.sizeBytes) throw Error('동일한 이름의 다른 원본 파일입니다. 영상 크기가 일치하지 않습니다.');
  if (objectURL) URL.revokeObjectURL(objectURL); objectURL = URL.createObjectURL(file); setMedia(objectURL,kind);
});
$('video-mode').onchange = () => {
  const kind=$('video-mode').value;
  if(resultMedia?.[kind])setMedia(resultMedia[kind],kind);
  else if(resultMedia&&!objectURL){$('video-mode').value=mediaKind;message('전체 원본 영상은 영상 열기로 연결하세요.');}
  else if(video.getAttribute('src'))setMedia(objectURL||video.getAttribute('src'),kind);
};
$('review-file').onchange = guard(async event => {
  if (!data) throw Error('트래킹 JSON을 먼저 열어 주세요.');
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  const imported = validateReview(await jsonFile(file),data);
  imported.events=imported.events.map(e=>({...e,row:{...e.row,FpaEventId:e.row.FpaEventId||crypto.randomUUID()}}));
  commit(imported); fpa.reset(); message('작업을 복원했습니다.');
});
$('export').onclick = guard(() => {
  const payload = { ...review, exportedAt: new Date().toISOString(), video: data.video, reconnectionStatus:recovery.status, automaticSegments:recovery.segments, identityHolds:recovery.masks, duplicateAliases:recovery.duplicates,pendingReconnections:recovery.suggestions,eventPatches: eventPatches(working), note: 'events는 작업자가 저장·번호 연결한 FPA 수정본입니다. 불러온 원본은 fpa.source에 보존합니다. 자동 트랙 연결은 제안(suggested)이며 운영 FPA DB에는 자동 반영하지 않습니다. reconnectionStatus가 complete일 때 자동 재연결 계산이 완료된 상태입니다.' };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = `${data.video.name.replace(/\.[^.]+$/,'')}-review.json`; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
  message('작업 백업 JSON을 다운로드했습니다.');
});
function togglePlay() { if (!mediaReady) return; if (video.paused) { if (sourceTime() >= data.video.clipEnd-1/data.video.fps) seek(data.video.clipStart); video.play().catch(e=>message(e.message,true)); } else video.pause(); }
$('play').onclick = togglePlay;
$('back').onclick = () => { video.pause(); if (data) seek(sourceTime()-1/data.video.fps); };
$('forward').onclick = () => { video.pause(); if (data) seek(sourceTime()+1/data.video.fps); };
$('seek').oninput = event => { video.pause(); seek(Number(event.target.value)); };
$('speed').onchange = event => { video.playbackRate = Number(event.target.value); };
$('fullscreen').onclick = guard(async () => { if (!document.fullscreenElement) await $('stage').requestFullscreen(); else await document.exitFullscreen(); });
$('show-labels').onchange = render; $('show-ignored').onchange = render; $('show-raw').onchange=render;
document.addEventListener('keydown',event => {
  if($('work-panel').hidden || event.defaultPrevented || event.target.closest?.('[role=tablist]'))return;
  if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  if (data && ['ArrowLeft','ArrowRight'].includes(event.code)) { event.preventDefault(); video.pause(); seek(sourceTime()+(event.code==='ArrowLeft'?-1:1)*(event.shiftKey?1:1/data.video.fps)); }
});
new ResizeObserver(render).observe($('stage'));

// Frame callbacks keep overlays on decoded video frames. Paused/seeking renders
// are handled by events; browsers without rVFC use animation frames.
function frameLoop() {
  if(video.requestVideoFrameCallback) video.requestVideoFrameCallback(()=>{render();frameLoop();});
  else requestAnimationFrame(()=>{if(video.currentTime!==lastTime){lastTime=video.currentTime;render();}frameLoop();});
}
frameLoop();
async function loadRun(id) {
  if(serverReview?.dirty)await serverReview.flush();
  const revision=++loadRevision;
  const response=await fetch(`/api/tracking/jobs/${encodeURIComponent(id)}`);
  if(!response.ok)throw Error('분석 작업을 찾지 못했습니다.');
  const job=await response.json();
  if(job.status!=='completed'||!job.result)throw Error('분석이 끝난 후 작업을 열 수 있습니다.');
  const cloud=job.reviewStorage==='server'?new ServerReview(id,{status:(text,error)=>{$('save-state').textContent=text;if(error)message(text,true);}}):null;
  if(cloud){await cloud.open();cloud.datasetId=job.datasetId;}
  let initial=null;
  if(job.result.initialReview){const result=await fetch(job.result.initialReview);if(!result.ok)throw Error('초기 선수 지정을 읽지 못했습니다.');initial=await result.json();}
  if(revision!==loadRevision)return;
  shell.select('work');
  let payload;
  try{payload=await loadDataset(new URL(job.result.tracks,location.href).href);}
  catch(error){if(revision===loadRevision)failedDatasetLoad(error);return;}
  if(revision!==loadRevision)return;
  serverReview=cloud;setDataset(payload,initial);resultMedia=job.result;
  setMedia(job.result.preview,'preview');
  const url=new URL(location.href);url.searchParams.set('job',id);url.searchParams.delete('autoload');history.replaceState(null,'',url);
  window.dispatchEvent(new Event('fpa-cv:navigation'));
}
function failedDatasetLoad(error) {
  loadingDataset=false;
  recoveryClient.cancel();
  if(datasetBinding){recoveryClient.source=datasetBinding.source;recoveryClient.contentHash=datasetBinding.contentHash;}

  if(data&&datasetBinding){
    showRecoveryStopped('새 결과를 불러오지 못했습니다. 기존 작업을 유지합니다.');
    refresh(false);message(error.message,true);return;
  }
  $('recovery-progress').hidden=true;$('recovery-action').hidden=true;
  $('recovery-label').textContent='결과를 불러오지 못했습니다.';
  $('recovery-note').textContent='분석 목록에서 작업을 다시 열어 주세요.';
  message(error.message,true);
}
const shell=workbenchShell({openRun:loadRun,pause:()=>video.pause()});
const params=new URLSearchParams(location.search);
window.addEventListener('fpa-cv:purged',event=>{
  if(new URLSearchParams(location.search).get('job')!==event.detail?.id)return;
  // Clear the open deleted dataset so it cannot be edited or auto-saved again.
  video.pause();recoveryClient.cancel();serverReview=null;
  const url=new URL(location.href);url.searchParams.delete('job');url.searchParams.delete('autoload');url.hash='tracking';
  location.replace(url.href);
});
if(params.has('job')||params.get('autoload')==='1'){
  try{await loadRun(params.get('job')||'existing');}
  catch(error){message(error.message,true);shell.select('work');}
}
