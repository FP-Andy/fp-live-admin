// The browser uses its existing FPC session; the workbench receives no session or S3 credential.
export function recordingPreviewUrl(origin,mid,sid,part){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!uuid.test(mid)||!uuid.test(sid)||!Number.isSafeInteger(part)||part<1)return null;
 return new URL(`api/recordings/matches/${encodeURIComponent(mid)}/${encodeURIComponent(sid)}/files/${part-1}`,origin+'/').href;
}
export function mountFpcRecordingRelay(host,{intakeId,onPrepared=()=>{},canPrepare=()=>true}={}){
 const match=location.pathname.match(/^\/api\/courtside\/matches\/([0-9a-f-]+)\/(?:intakes|cases)\/[^/]+\/bridge\//i);
 if(!match||! /^[a-f0-9]{24}$/.test(intakeId||''))return {dispose(){}};
 const mid=match[1],root=new URL('api/courtside/matches/'+encodeURIComponent(mid)+'/intakes/'+encodeURIComponent(intakeId)+'/',location.origin+'/');
 host.innerHTML=`<details class="pair-panel"><summary>FPC 녹화에서 광각 조각 불러오기</summary><p class="help">녹화 저장소의 조각을 먼저 재생하고, 필요한 조각만 작업 저장소에 확보합니다. 저장 시각은 경기 시각이 아니므로 같은 순간을 직접 확인하세요.</p><div class="pair-tools"><button type="button" data-relay="load">경기 녹화 불러오기</button><label>녹화<select data-relay="session"><option value="">녹화 선택</option></select></label><button type="button" data-relay="parts" disabled>녹화 조각 보기</button></div><label class="field">광각 조각<select data-relay="part"><option value="">조각 선택</option></select></label><div class="pair-tools"><button type="button" data-relay="preview" disabled>선택 조각 미리보기</button><button type="button" data-relay="prepare" disabled>선택 조각 작업에 사용</button></div><video data-relay="video" controls muted playsinline preload="none" hidden></video><p class="help" role="status" data-relay="status"></p></details>`;
 const $=name=>host.querySelector(`[data-relay="${name}"]`);let disposed=false,busy=false,sessions=[];
 const status=s=>{if(!disposed)$('status').textContent=s;};
 const controls=()=>{if(disposed)return;$('load').disabled=busy;$('session').disabled=busy;$('parts').disabled=busy||!$('session').value;$('part').disabled=busy;$('prepare').disabled=busy||!$('session').value||!$('part').value;$('preview').disabled=$('prepare').disabled;};
 const stopPreview=()=>{const video=$('video');video.pause();video.removeAttribute('src');video.load();video.hidden=true;};
 async function get(url,opts){const response=await fetch(url,opts);const data=await response.json();if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'FPC 녹화 원본을 확인하지 못했습니다.');return data;}
 $('load').onclick=async()=>{stopPreview();busy=true;controls();try{
  // Existing authentication; the dedicated response contains no stream key.
  const data=await get(new URL('api/courtside/matches/'+encodeURIComponent(mid)+'/recording-parts',location.origin+'/'));
  const rows=Array.isArray(data.recordings)?data.recordings:[];
  sessions=rows.map(r=>({id:r.id,createdAt:r.created_at,parts:Array.isArray(r.parts)?r.parts.map(p=>({number:p.number,name:p.sourcePartName,duration:p.duration})):[]}));
  $('session').replaceChildren(new Option('녹화 선택',''),...sessions.map(r=>new Option((r.createdAt?new Date(r.createdAt).toLocaleString('ko-KR'):'녹화')+' · '+r.parts.length+'개 조각',r.id)));
  $('part').replaceChildren(new Option('조각 선택',''));status(sessions.length?'녹화를 선택한 뒤 조각을 불러오세요.':'이 경기의 녹화가 없습니다.');
 }catch(e){status(e.message);}finally{busy=false;controls();}};
 $('session').onchange=()=>{stopPreview();$('part').replaceChildren(new Option('조각 선택',''));controls();};$('part').onchange=()=>{stopPreview();controls();};
 $('parts').onclick=()=>{const record=sessions.find(r=>r.id===$('session').value);if(!record)return;
  const valid=record.parts.filter(p=>Number.isInteger(p.number)&&p.number>0&&typeof p.name==='string'&&/^take-[0-9]{5,}-part-[0-9]{6,}\.mp4$/.test(p.name));
  $('part').replaceChildren(new Option('조각 선택',''),...valid.map(p=>new Option('녹화 '+p.number+'번 · '+p.name+(Number.isFinite(p.duration)?' · '+p.duration.toFixed(1)+'초':''),p.name)));
  status(valid.length?(valid.length<record.parts.length?'일부 조각의 원본 식별자를 확인할 수 없어 제외했습니다.':'녹화 조각을 선택해 확보한 뒤 두 화면을 비교하세요.'):'녹화 서비스에서 원본 식별자를 제공하지 않아 확인할 수 없습니다.');controls();
 };
 $('preview').onclick=()=>{const record=sessions.find(r=>r.id===$('session').value),part=record?.parts.find(p=>p.name===$('part').value),url=part&&recordingPreviewUrl(location.origin,mid,record.id,part.number);if(!url)return status('녹화 조각을 확인하세요.');const video=$('video');video.hidden=false;video.src=url;video.load();status('FPC 녹화 조각을 재생해 장면을 확인하세요.');};
 $('video').onerror=()=>status('미리보기를 열지 못했습니다. FPC 로그인과 녹화 저장 상태를 확인하세요.');
 $('prepare').onclick=async()=>{const sid=$('session').value,part=$('part').value;if(!sid||!part)return;if(!canPrepare())return status('변경한 광각 프레임을 먼저 저장하거나 장면을 다시 여세요.');busy=true;controls();status('선택한 조각을 서버에서 확보하고 있습니다.');try{
  const data=await get(new URL('recording-sessions/'+encodeURIComponent(sid)+'/parts/'+encodeURIComponent(part)+'/prepare',root),{method:'POST'});
  if(data.status!=='stored-unpaired')throw Error('확보 상태를 확인하지 못했습니다.');
  try{await onPrepared();status('조각을 확보했습니다. 아래 광각 구간에서 선택하고 같은 순간인지 직접 확인하세요.');}
  catch{status('조각은 확보했습니다. 변경한 프레임을 저장한 뒤 광각 구간을 새로고침하세요.');}
 }catch(e){status(e.message);}finally{busy=false;controls();}};
 return {dispose(){stopPreview();disposed=true;}};
}
