// Broadcast timestamps and track IDs are independent of the FPC stream.
export function broadcastSample(packet,time){
 if(!packet||!Number.isFinite(time)||time<packet.coverageSeconds[0]||time>=packet.coverageSeconds[1])return null;
 let best=null;for(const f of packet.frames)if(!best||Math.abs(f.t-time)<Math.abs(best.t-time))best=f;
 return best&&Math.abs(best.t-time)<=.055?best:null;
}
export function mountBroadcastTracking(video,canvas,summary,toggle,mapCanvas,mapNote){
 const ctx=canvas.getContext('2d'),mapCtx=mapCanvas.getContext('2d');let packet=null,generation=0,callback=null,clock=null,target=null,mapTarget=null,caseId=null,eventId=null;const images=new Map(),maps=new Map();
 function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);target=null;
  mapCtx.clearRect(0,0,mapCanvas.width,mapCanvas.height);mapTarget=null;mapNote.textContent='해당 프레임의 코트 좌표 없음';
  if(!packet){summary.textContent='중계뷰 추적 결과를 불러오는 중';return;}
  const time=clock??video.currentTime,row=broadcastSample(packet,time);
  if(!row){summary.textContent='이 구간은 추적 범위 밖입니다 · 실제 플레이 0–8초만 처리';return;}
  const count={player:0,referee:0,staff:0,unknown:0};row.boxes.forEach(b=>count[b.roleHint]=(count[b.roleHint]||0)+1);
  summary.textContent=`중계 · 선수 후보 ${count.player} · 심판 후보 ${count.referee} · 운영 후보 ${count.staff} · 미확정 ${count.unknown} | 공 후보 ${row.ballObjects?.length??row.ballCandidates.filter(b=>b.confidence>=.45).length}`;
  if(row.objectReview){
   const colors={player:'#32e3bf',referee:'#ff8f35',staff:'#b992ff',unknown:'#d0d5df',ball:'#ffe441'};
   if(toggle.checked){for(const b of row.boxes){const box=b.box.map((v,i)=>v*(i%2?1080:1920));ctx.strokeStyle=colors[b.roleHint];ctx.lineWidth=3;ctx.strokeRect(box[0],box[1],box[2]-box[0],box[3]-box[1]);}
    for(const b of row.ballObjects||[]){const [x1,y1,x2,y2]=b.pixelBox;ctx.strokeStyle=colors.ball;ctx.lineWidth=4;ctx.strokeRect(x1,y1,x2-x1,y2-y1);ctx.fillStyle=colors.ball;ctx.font='22px sans-serif';ctx.fillText('공',x1,y1-7);}}
   const w=mapCanvas.width,h=mapCanvas.height;mapCtx.fillStyle='#d6965b';mapCtx.fillRect(0,0,w,h);mapCtx.strokeStyle='white';mapCtx.lineWidth=2;mapCtx.strokeRect(12,12,w-24,h-24);mapCtx.beginPath();mapCtx.moveTo(w/2,12);mapCtx.lineTo(w/2,h-12);mapCtx.stroke();
   for(const p of row.floorPositions){mapCtx.fillStyle=colors[p.role];mapCtx.beginPath();mapCtx.arc(12+p.xy[0]/28*(w-24),12+p.xy[1]/15*(h-24),6,0,Math.PI*2);mapCtx.fill();}
   mapNote.textContent=`수동 보정 포함 ${row.floorPositions.length}명 · 공 태그는 영상 위치이며 3D 높이 미확정`;return;
  }
  if(row.court?.status==='provisional'){
   const key=`${generation}:${row.frameIndex}`;mapTarget=key;mapNote.textContent=`발 위치 후보 ${row.floorPositions.length}명 · 프레임별 코트 보정 · 실측 정확도 검수 전`;
   if(!maps.has(key)){const img=new Image();maps.set(key,img);img.onload=()=>{if(mapTarget===key)mapCtx.drawImage(img,0,0,mapCanvas.width,mapCanvas.height);};img.src=`/case-maps/${caseId}/${eventId}/${String(row.frameIndex).padStart(6,'0')}.png`;if(maps.size>12)maps.delete(maps.keys().next().value);}
   const img=maps.get(key);if(img.complete&&img.naturalWidth)mapCtx.drawImage(img,0,0,mapCanvas.width,mapCanvas.height);
  }
  if(!toggle.checked)return;
  const key=`${generation}:${row.frameIndex}`;target=key;
  if(!images.has(key)){
   const image=new Image();images.set(key,image);image.onload=()=>{if(target===key&&toggle.checked)ctx.drawImage(image,0,0,canvas.width,canvas.height);};image.onerror=()=>{if(target===key)summary.textContent='추적 오버레이를 불러오지 못했습니다.';};
   if(images.size>12)images.delete(images.keys().next().value);
   image.src=`/case-overlays/${caseId}/${eventId}/${String(row.frameIndex).padStart(6,'0')}.png`;
  }
  const image=images.get(key);if(image.complete&&image.naturalWidth)ctx.drawImage(image,0,0,canvas.width,canvas.height);
 }
 function watch(token){if(!video.requestVideoFrameCallback)return;callback=video.requestVideoFrameCallback((_,meta)=>{if(token!==generation)return;clock=meta.mediaTime;draw();watch(token);});}
 video.addEventListener('timeupdate',()=>{if(!video.requestVideoFrameCallback)draw();});
 video.addEventListener('seeking',()=>{clock=null;target=null;mapTarget=null;ctx.clearRect(0,0,canvas.width,canvas.height);mapCtx.clearRect(0,0,mapCanvas.width,mapCanvas.height);});
 video.addEventListener('seeked',()=>{clock=video.currentTime;draw();});toggle.onchange=draw;
 return async (nextCase,event)=>{
  const token=++generation;packet=null;clock=null;images.clear();maps.clear();caseId=nextCase;eventId=event.id;
  if(callback!==null)video.cancelVideoFrameCallback(callback);draw();watch(token);
  if(!event.broadcastTrackingReady){summary.textContent='중계뷰 자동 추적 준비 중';return;}
  try{const response=await fetch(`/api/cases/${caseId}/events/${eventId}/broadcast-tracking`);if(!response.ok)throw Error('중계 추적 결과를 불러오지 못했습니다.');const value=await response.json();if(token!==generation)return;if(value.inputSha256!==event.broadcast.sha256)throw Error('중계 원본과 추적 결과가 다릅니다.');packet=value;draw();}
  catch(error){if(token===generation)summary.textContent=error.message;}
 };
}
