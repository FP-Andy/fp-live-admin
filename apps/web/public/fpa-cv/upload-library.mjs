// Browser files are held only until transfer finishes. Completed sources live
// in the authenticated server library and survive closing this page.
export function uploadLibrary({api,post,select,status}){
 const $=id=>document.getElementById(id),pending=[],transfers=new Map();let enabled=false,running=false,uploads=[],signature='',jobs=[];
 const size=n=>`${(n/1024**3).toFixed(2)} GB`;
 function render(){
  const holder=$('uploaded-videos');holder.replaceChildren();$('uploaded-count').textContent=uploads.length;
  for(const t of transfers.values()){
   const row=document.createElement('article');row.className='upload-row';
   const name=document.createElement('strong');name.textContent=t.file.name;
   const label=document.createElement('span');label.textContent=t.error||`${t.state} · ${Math.floor(t.progress*100)}%`;
   const progress=document.createElement('progress');progress.max=1;progress.value=t.progress;
   row.append(name,label,progress);
   if(t.error){const retry=document.createElement('button');retry.type='button';retry.textContent='전송 재시도';retry.onclick=()=>{t.error=null;t.state='대기';pending.push(t);void pump();};row.append(retry);}
   holder.append(row);
  }
  for(const upload of uploads){
   if([...transfers.values()].some(t=>t.id===upload.id))continue;
   const row=document.createElement('article');row.className='upload-row';
   const name=document.createElement('strong');name.textContent=upload.name;
   const label=document.createElement('span');const related=jobs.filter(j=>j.uploadId===upload.id&&!j.deletedAt);
   label.textContent=`${size(upload.size)} · ${upload.status==='uploaded'?(related.length?`분석 ${related.length}개`:'초기 설정 대기'):'전송 미완료 · 다시 업로드 가능'}`;
   const button=document.createElement('button');button.type='button';button.textContent='초기 설정';button.disabled=upload.status!=='uploaded';button.onclick=()=>select(upload);
   const remove=document.createElement('button');remove.type='button';remove.className='job-delete';remove.textContent='영상 삭제';remove.disabled=related.length>0;
   remove.onclick=async()=>{if(!confirm(`“${upload.name}” 업로드를 삭제할까요?`))return;remove.disabled=true;try{await post(`/api/tracking/uploads/${upload.id}/remove`);signature='';await refresh();}catch(error){status(error.message,true);remove.disabled=false;}};
   row.append(name,label,button,remove);holder.append(row);
  }
  if(!holder.childElementCount){const p=document.createElement('p');p.className='tracking-jobs-empty';p.textContent='여러 영상을 선택해 업로드한 뒤, 경기별 초기 설정을 저장하세요.';holder.append(p);}
 }
 function put(url,blob,update){return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhr.open('PUT',url);xhr.timeout=180000;
  xhr.upload.onprogress=e=>{if(e.lengthComputable)update(e.loaded);};
  xhr.onload=()=>xhr.status>=200&&xhr.status<300&&xhr.getResponseHeader('ETag')?resolve(xhr.getResponseHeader('ETag')):reject(Error('S3 전송 응답을 확인하지 못했습니다.'));
  xhr.onerror=()=>reject(Error('영상 전송 연결이 끊겼습니다.'));xhr.ontimeout=()=>reject(Error('영상 전송 시간이 초과되었습니다.'));xhr.send(blob);
 });}
 async function transfer(t){
  if(!t.id){const upload=await post('/api/tracking/uploads/multipart',{name:t.file.name,size:t.file.size});t.id=upload.id;t.partSize=upload.partSize;t.parts=new Map();}
  const count=Math.ceil(t.file.size/t.partSize);let next=1;const loaded=new Map();
  const update=()=>{t.progress=([...t.parts.keys()].reduce((n,i)=>n+Math.min(t.partSize,t.file.size-(i-1)*t.partSize),0)+[...loaded.values()].reduce((a,b)=>a+b,0))/t.file.size;render();};
  let failed=null;
  const send=async()=>{while(next<=count&&!failed){const number=next++;if(t.parts.has(number))continue;const blob=t.file.slice((number-1)*t.partSize,number*t.partSize);try{
   let etag;
   for(let attempt=0;attempt<3;attempt++){
    try{const {parts}=await post(`/api/tracking/uploads/${t.id}/parts`,{parts:[number]});etag=await put(parts[0].url,blob,n=>{loaded.set(number,n);update();});break;}
    catch(error){loaded.delete(number);if(attempt===2)throw error;await new Promise(r=>setTimeout(r,1000*(attempt+1)));}
   }
   loaded.delete(number);t.parts.set(number,etag);update();
  }catch(error){failed=error;}}};
  await Promise.all([send(),send()]);if(failed)throw failed;
  await post(`/api/tracking/uploads/${t.id}/complete`,{parts:[...t.parts].sort((a,b)=>a[0]-b[0]).map(([PartNumber,ETag])=>({PartNumber,ETag}))});
 }
 async function pump(){if(running)return;running=true;try{while(pending.length){const t=pending.shift();t.state='업로드 중';render();try{await transfer(t);transfers.delete(t.key);signature='';await refresh();}catch(error){t.error=error.message;render();}}}finally{running=false;}}
 async function refresh(nextJobs){if(nextJobs)jobs=nextJobs;if(!enabled)return;const value=await api('/api/tracking/uploads');const nextSignature=JSON.stringify([value.uploads,jobs.map(j=>[j.id,j.status,j.deletedAt])]);if(nextSignature!==signature){uploads=value.uploads;signature=nextSignature;render();}}
 function add(files){for(const file of files){if(!/\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(file.name)||file.size>20*1024**3||!file.size){status(`${file.name}: 20GB 이하 영상 파일을 선택하세요.`,true);continue;}const key=crypto.randomUUID(),t={key,file,state:'대기',progress:0};transfers.set(key,t);pending.push(t);}render();void pump();}
 window.addEventListener('beforeunload',event=>{if(running||pending.length){event.preventDefault();event.returnValue='';}});
 return {add,refresh,enable(value){enabled=value;$('upload-library').hidden=!value;}};
}
