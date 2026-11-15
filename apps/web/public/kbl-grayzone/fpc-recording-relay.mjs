// The browser uses its existing FPC session; the workbench receives no session or S3 credential.
export function recordingPreviewUrl(origin,mid,sid,part){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!uuid.test(mid)||!uuid.test(sid)||!Number.isSafeInteger(part)||part<1)return null;
 return new URL(`api/recordings/matches/${encodeURIComponent(mid)}/${encodeURIComponent(sid)}/files/${part-1}`,origin+'/').href;
}
const fpcReviewPath=/^\/api\/courtside\/matches\/([0-9a-f-]+)\/(?:intakes|cases)\/[^/]+\/bridge\//i;
export const isFpcReviewPath=path=>fpcReviewPath.test(path);
// Remote recordings can be played immediately. Preparing a chosen segment
// separately binds its exact bytes to the saved frame and downstream analysis.
export function fpcFrameSources(intakeId){
 const match=location.pathname.match(fpcReviewPath);
 if(!match||! /^[a-f0-9]{24}$/.test(intakeId||''))return null;
 const mid=match[1],origin=location.origin;
 async function get(url,opts){const response=await fetch(url,opts);let body;try{body=await response.json();}catch{throw Error('광각 녹화 응답을 확인할 수 없습니다.');}if(!response.ok)throw Error(typeof body.detail==='string'?body.detail:'광각 녹화를 확인하지 못했습니다.');return body;}
 return {
  async list(){
   const data=await get(new URL('api/courtside/matches/'+encodeURIComponent(mid)+'/recording-parts',origin+'/'));
   const result=[];
   for(const record of Array.isArray(data.recordings)?data.recordings:[]){
    let elapsed=0,expected=1;const sid=record.id;
    for(const part of Array.isArray(record.parts)?record.parts:[]){
     const number=part.number,name=part.sourcePartName,duration=part.duration;
     if(!Number.isSafeInteger(number)||number<1||typeof name!=='string'||!/^take-[0-9]{5,}-part-[0-9]{6,}\.mp4$/.test(name))continue;
     if(number!==expected)elapsed=null;expected=number+1;const start=elapsed;
     if(elapsed!==null)elapsed=Number.isFinite(duration)&&duration>0?elapsed+duration:null;
     const preview=recordingPreviewUrl(origin,mid,sid,number);if(!preview)continue;
     const stamp=record.created_at?new Date(record.created_at).toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'FPC 녹화';
     const time=start===null?'시간 확인 필요':`${Math.floor(start/60)}:${String(Math.floor(start%60)).padStart(2,'0')}부터`;
     result.push({id:`remote-${sid}-${number}`,label:`${stamp} · ${time} · 구간 ${number}`,remote:true,
      matchId:mid,sessionId:sid,partName:name,part:number-1,startSeconds:start,duration,previewUrl:preview});
    }
   }
   return result;
  },
  async prepare(row){
   const base=new URL('api/courtside/matches/'+encodeURIComponent(mid)+'/intakes/'+encodeURIComponent(intakeId)+'/',origin+'/');
   const url=new URL('recording-sessions/'+encodeURIComponent(row.sessionId)+'/parts/'+encodeURIComponent(row.partName)+'/prepare',base);
   const result=await get(url,{method:'POST'});
   if(result.status!=='stored-unpaired'||result.sessionId!==row.sessionId||result.partName!==row.partName||!/^[a-f0-9]{64}$/.test(result.sha256||''))throw Error('광각 구간의 준비 결과를 확인하세요.');
   return result;
  }
 };
}
export function mountFpcRecordingRelay(host,{intakeId,onPrepared=()=>{},canPrepare=()=>true,inline=false}={}){
 const match=location.pathname.match(fpcReviewPath);
 if(!match||! /^[a-f0-9]{24}$/.test(intakeId||''))return {dispose(){}};
 const mid=match[1],root=new URL('api/courtside/matches/'+encodeURIComponent(mid)+'/intakes/'+encodeURIComponent(intakeId)+'/',location.origin+'/');
 const start=inline?'<div class="pair-panel relay-panel"><h2>광각 녹화 미리보기</h2>':'<details class="pair-panel relay-panel"><summary>FPC 녹화에서 광각 조각 불러오기</summary>';
 host.innerHTML=start+`<p class="help">녹화 구간을 미리 보고 필요한 구간을 작업에 사용하세요. 원본을 변경하지 않습니다.</p><div class="pair-tools"><button type="button" data-relay="load">녹화 목록 새로고침</button><label>녹화<select data-relay="session"><option value="">녹화 선택</option></select></label></div><label class="field">광각 구간<select data-relay="part"><option value="">구간 선택</option></select></label><div class="pair-tools"><button type="button" data-relay="preview" disabled>선택 구간 미리보기</button><button type="button" data-relay="prepare" disabled>선택 구간 작업에 사용</button></div><video data-relay="video" controls muted playsinline preload="none" hidden></video><p class="help" role="status" data-relay="status"></p>`+(inline?'</div>':'</details>');
 const $=name=>host.querySelector(`[data-relay="${name}"]`);let disposed=false,busy=false,loaded=false,sessions=[];
 const status=s=>{if(!disposed)$('status').textContent=s;};
 const controls=()=>{if(disposed)return;$('load').disabled=busy;$('session').disabled=busy;$('part').disabled=busy;$('prepare').disabled=busy||!$('session').value||!$('part').value;$('preview').disabled=$('prepare').disabled;};
 const stopPreview=()=>{const video=$('video');video.pause();video.removeAttribute('src');video.load();video.hidden=true;};
 async function get(url,opts){const response=await fetch(url,opts);const data=await response.json();if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'FPC 녹화 원본을 확인하지 못했습니다.');return data;}
 async function loadRecordings(force=false){if(disposed||busy||loaded&&!force)return;stopPreview();busy=true;controls();status('녹화 목록을 불러오는 중입니다.');try{
  // Existing authentication; the dedicated response contains no stream key.
  const data=await get(new URL('api/courtside/matches/'+encodeURIComponent(mid)+'/recording-parts',location.origin+'/'));
  const rows=Array.isArray(data.recordings)?data.recordings:[];
  sessions=rows.map(r=>({id:r.id,createdAt:r.created_at,parts:Array.isArray(r.parts)?r.parts.map(p=>({number:p.number,name:p.sourcePartName,duration:p.duration})):[]}));
  $('session').replaceChildren(new Option('녹화 선택',''),...sessions.map(r=>new Option((r.createdAt?new Date(r.createdAt).toLocaleString('ko-KR'):'녹화')+' · '+r.parts.length+'개 조각',r.id)));
  $('part').replaceChildren(new Option('구간 선택',''));loaded=true;
  if(sessions.length===1){$('session').value=sessions[0].id;showParts();}
  else status(sessions.length?'녹화를 선택하세요.':'이 경기의 녹화가 없습니다.');
 }catch(e){status(e.message);}finally{busy=false;controls();}}
 $('load').onclick=()=>loadRecordings(true);
 $('session').onchange=()=>{stopPreview();$('part').replaceChildren(new Option('구간 선택',''));showParts();controls();};$('part').onchange=()=>{stopPreview();controls();};
 function showParts(){const record=sessions.find(r=>r.id===$('session').value);if(!record)return;
  const valid=record.parts.filter(p=>Number.isInteger(p.number)&&p.number>0&&typeof p.name==='string'&&/^take-[0-9]{5,}-part-[0-9]{6,}\.mp4$/.test(p.name));
  let elapsed=0,expected=1;const options=valid.map(p=>{if(p.number!==expected)elapsed=null;expected=p.number+1;const start=elapsed;if(elapsed!==null)elapsed=Number.isFinite(p.duration)?elapsed+p.duration:null;const time=start!==null&&Number.isFinite(p.duration)?`원본 누적 ${Math.floor(start/60)}:${String(Math.floor(start%60)).padStart(2,'0')}부터 · ${p.duration.toFixed(1)}초`:'시간 확인 필요';return new Option(`${p.number}번 · ${time} · ${p.name}`,p.name);});
  $('part').replaceChildren(new Option('구간 선택',''),...options);
  status(valid.length?(valid.length<record.parts.length?'일부 조각의 원본 식별자를 확인할 수 없어 제외했습니다.':'녹화 조각을 선택해 확보한 뒤 두 화면을 비교하세요.'):'녹화 서비스에서 원본 식별자를 제공하지 않아 확인할 수 없습니다.');controls();
 }
 $('preview').onclick=()=>{const record=sessions.find(r=>r.id===$('session').value),part=record?.parts.find(p=>p.name===$('part').value),url=part&&recordingPreviewUrl(location.origin,mid,record.id,part.number);if(!url)return status('녹화 조각을 확인하세요.');const video=$('video');video.hidden=false;video.src=url;video.load();status('FPC 녹화 조각을 재생해 장면을 확인하세요.');};
 $('video').onloadedmetadata=()=>status('미리보기가 준비됐습니다. 재생하며 필요한 구간을 확인하세요.');
 $('video').onerror=()=>status('미리보기를 열지 못했습니다. FPC 로그인과 녹화 저장 상태를 확인하세요.');
 $('prepare').onclick=async()=>{const sid=$('session').value,part=$('part').value;if(!sid||!part)return;if(!canPrepare())return status('변경한 광각 프레임을 먼저 저장하거나 장면을 다시 여세요.');busy=true;controls();status('선택한 조각을 서버에서 확보하고 있습니다.');try{
  const data=await get(new URL('recording-sessions/'+encodeURIComponent(sid)+'/parts/'+encodeURIComponent(part)+'/prepare',root),{method:'POST'});
  if(data.status!=='stored-unpaired')throw Error('확보 상태를 확인하지 못했습니다.');
  try{await onPrepared();status('조각을 확보했습니다. 아래 광각 구간에서 선택하고 같은 순간인지 직접 확인하세요.');}
  catch{status('조각은 확보했습니다. 변경한 프레임을 저장한 뒤 광각 구간을 새로고침하세요.');}
 }catch(e){status(e.message);}finally{busy=false;controls();}};
 return {load:loadRecordings,dispose(){stopPreview();disposed=true;}};
}
