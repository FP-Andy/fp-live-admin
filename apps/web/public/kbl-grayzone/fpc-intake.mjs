import {$,api,bridge,intakeId,uuid} from './fpc-ui.mjs';
const params=new URLSearchParams(location.search),match=params.get('match');
let resume=params.get('resume'),busy=false,canEdit=false;
const message=s=>$('status').textContent=s;
async function readCsv(file){
 let timer;
 try{return await Promise.race([file.text(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CSV 파일을 읽지 못했습니다. 파일 접근 권한을 확인한 뒤 다시 선택하세요.')),15000);})]);}
 finally{clearTimeout(timer);}
}
$('matchBack').href=`./fpc-match.html?id=${encodeURIComponent(match||'')}`;$('matchBack').textContent='← 경기 상세';
$('videos').onchange=()=>$('videoNames').textContent=Array.from($('videos').files).map(f=>`${f.name} · ${(f.size/1024**2).toFixed(1)} MB`).join(' / ');
$('csv').onchange=()=>$('csvName').textContent=$('csv').files[0]?.name||'CSV를 선택하세요.';
if(resume){$('fixtureConfirmed').checked=true;$('fixtureConfirmed').parentElement.hidden=true;$('upload').textContent='영상 이어 올리기 →';message('중단된 등록입니다. 처음 선택한 영상과 같은 파일을 다시 선택하세요.');}
async function upload(id,files){
 const base=`/api/courtside/matches/${encodeURIComponent(match)}/intakes/${id}/bridge/api/intake/${id}`;
 const saved=await api(base);
 if(saved.status!=='uploading'||saved.media.length!==files.length)throw Error('처음 선택한 영상과 같은 파일을 모두 선택하세요.');
 const total=files.reduce((n,f)=>n+f.size,0);let done=0;
 $('progress').hidden=false;
 for(let i=0;i<files.length;i++){
  const file=files[i],previous=saved.media[i];
  if(file.name!==previous.name||file.size!==previous.size)throw Error('처음 선택한 영상과 같은 파일을 모두 선택하세요.');
  let verified=0;
  if(previous.received&&!previous.uploadChunks?.length)throw Error('기존 업로드의 원본을 검증할 수 없습니다. 새 접수로 등록하세요.');
  for(const part of previous.uploadChunks||[]){
   if(part.offset!==verified||part.size<=0||part.size>8*1024*1024||part.offset+part.size>previous.received||!/^[a-f0-9]{64}$/.test(part.sha256))throw Error('저장된 업로드 기록을 확인하세요.');
   const hash=await crypto.subtle.digest('SHA-256',await file.slice(part.offset,part.offset+part.size).arrayBuffer());
   if(Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')!==part.sha256)throw Error('선택한 영상이 이전에 전송한 원본과 다릅니다.');
   verified+=part.size;
  }
  if(verified!==previous.received)throw Error('저장된 업로드 기록을 확인하세요.');done+=verified;
  for(let offset=verified;offset<file.size;offset+=8*1024*1024){
   const response=await fetch(`${base}/media/${i}?offset=${offset}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file.slice(offset,offset+8*1024*1024)});
   if(!response.ok)throw Error('영상 전송이 중단됐습니다. 경기 상세에서 이어 올리세요.');
   done+=Math.min(8*1024*1024,file.size-offset);$('progress').value=total?Math.round(done/total*100):0;message(`영상 전송 ${$('progress').value}%`);
  }
 }
 const doneResponse=await fetch(`${base}/finalize`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 if(!doneResponse.ok)throw Error('영상 등록을 완료하지 못했습니다. 경기 상세에서 접수 상태를 확인하세요.');
 location.assign(bridge(match,id));
}
$('upload').onclick=async()=>{
 if(busy||!canEdit)return;const files=Array.from($('videos').files),csv=$('csv').files[0];
 if(!files.length||(!resume&&!csv))return message('영상과 CSV를 모두 선택하세요.');
 if(!resume&&!$('fixtureConfirmed').checked)return message('선택한 경기와 CSV의 경기일·팀을 확인해 주세요.');
 busy=true;$('upload').disabled=true;
 try{
  if(!resume){
   message('CSV와 선택한 영상을 확인하고 있습니다.');
   const created=await api(`/api/courtside/matches/${encodeURIComponent(match)}/intakes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csvText:await readCsv(csv),candidateMode:'auto',confirmUnverifiedDate:true,media:files.map(f=>({name:f.name,size:f.size}))})});
   if(!intakeId(created.id))throw Error('접수 결과를 확인하지 못했습니다.');resume=created.id;
   history.replaceState(null,'',`?match=${encodeURIComponent(match)}&resume=${encodeURIComponent(resume)}`);
  }
  await upload(resume,files);
 }catch(e){message(e.message);}finally{busy=false;$('upload').disabled=false;}
};
if(!uuid(match)||(resume&&!intakeId(resume))){$('upload').disabled=true;message('경기나 접수 자료를 확인해 주세요.');}
else api(`/api/courtside/matches/${encodeURIComponent(match)}/access`).then(access=>{canEdit=access.canEdit;if(!canEdit){$('upload').disabled=true;message('이 경기는 읽기 권한만 있습니다.');}}).catch(e=>{$('upload').disabled=true;message(e.message);});
