// One operator-selected evidence frame; no inferred points are accepted silently.
const points = [[0,0,0],[1,0,.9],[2,0,5.05],[3,0,9.95],[4,0,14.1],[5,0,15],
 [9,5.8,5.05],[10,5.8,7.5],[11,5.8,9.95],[12,8.3,0],[14,8.3,15],
 [15,14,0],[16,14,7.5],[17,14,15],[18,19.7,0],[20,19.7,15],
 [21,22.2,5.05],[22,22.2,7.5],[23,22.2,9.95],[27,28,0],[28,28,.9],
 [29,28,5.05],[30,28,9.95],[31,28,14.1],[32,28,15]];
const NS='http://www.w3.org/2000/svg';
const node=(tag,text)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;return x;};
const svgNode=(tag,attrs)=>{const x=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))x.setAttribute(k,String(v));return x;};

export function mountManualCourt(root,{caseId,event,packet,frame,index,required,beforeSave=()=>{}}) {
 root.replaceChildren();root.hidden=false;
 const title=node('h2','코트 기준점 보정');
 const explain=node('p','아래 코트 그림에서 기준점을 고른 뒤, 같은 지점을 중계 원본에서 클릭하세요. 서로 다른 기준점 6개 이상이 필요합니다. 그림의 왼쪽·오른쪽 골대가 영상의 같은 골대인지 먼저 확인해 주세요.');
 const details=node('details');details.open=required;const summary=node('summary',required?'기준점 지정하기 · 보정 필요':'기준점 다시 지정하기');details.append(summary);
 const info=node('p','저장한 객체·2D 관절 검수는 보존됩니다. 이전 2D·3D 배치와 리포트 이미지는 코트가 달라지면 다시 확인해야 합니다. 코트 좌표는 수동 추정이며 실제 측량값이 아닙니다.');
 const diagram=svgNode('svg',{viewBox:'-30 -30 650 360',role:'group','aria-label':'코트 기준점 선택',style:'width:min(100%,720px);background:#fff;border:1px solid #ddd'});
 const X=x=>20*x+10,Y=y=>20*y+10;
 const line=(x1,y1,x2,y2)=>diagram.append(svgNode('line',{x1:X(x1),y1:Y(y1),x2:X(x2),y2:Y(y2),stroke:'#607887','stroke-width':2}));
 for(const [a,b,c,d] of [[0,0,28,0],[0,15,28,15],[0,0,0,15],[28,0,28,15],[14,0,14,15],[0,5.05,5.8,5.05],[0,9.95,5.8,9.95],[5.8,5.05,5.8,9.95],[28,5.05,22.2,5.05],[28,9.95,22.2,9.95],[22.2,5.05,22.2,9.95]])line(a,b,c,d);
 const canvas=node('canvas');canvas.width=packet.width;canvas.height=packet.height;canvas.style.cssText='width:100%;max-width:1100px;height:auto;border:1px solid #aab;cursor:crosshair';canvas.setAttribute('aria-label','중계 기준 프레임의 코트 기준점 지정');
 const video=node('video');video.muted=true;video.playsInline=true;video.preload='auto';video.hidden=true;
 const status=node('p','중계 기준 프레임을 불러오는 중입니다.');status.setAttribute('role','status');
 const selected=node('p','코트 그림의 번호를 먼저 선택하세요.');selected.setAttribute('role','status');
 const confirmLabel=node('label');const confirm=node('input');confirm.type='checkbox';confirmLabel.append(confirm,document.createTextNode(' 같은 골대와 각 점의 대응을 원본 영상에서 확인했습니다.'));
 const save=node('button','코트 보정 저장');save.type='button';save.disabled=true;
 const cancel=node('button','취소');cancel.type='button';cancel.className='secondary';
 const remove=node('button','선택한 점 지우기');remove.type='button';remove.className='secondary';
 const count=node('span');const placed=new Map();const buttons=new Map();let active=null,ready=false,busy=false;
 const draftKey=`manual-court:${caseId}:${event.id}:${index}:${packet.datasetId}:${frame?.courtRevision??''}`;
 const manual=frame?.court?.provenance?.method==='operator-frame-landmarks';
 const rejected=manual&&Array.isArray(frame.court.rejectedLandmarks)?frame.court.rejectedLandmarks:[];
 const savedPoints=manual?[...(frame.court.landmarks||[]),...rejected]:[];
 if(manual&&Number.isFinite(frame.court.reprojectionRMSEPixels))info.append(document.createTextNode(` 수동 기준점 전체의 평균 제곱근 차이 ${frame.court.reprojectionRMSEPixels.toFixed(1)}px · 최대 ${frame.court.reprojectionMaxPixels.toFixed(1)}px. 모든 점을 정확히 동시에 통과하는 변환은 아닙니다. 원본과 배치를 비교하세요.`));
 if(manual&&frame.court.cameraCalibrationError)info.append(document.createTextNode(' 3D 카메라 추정은 아직 불안정해 영상 생성 또는 3D 자세 추정이 제한될 수 있습니다.'));
 if(rejected.length)info.append(document.createTextNode(` 기존 보정에서 제외된 점 ${rejected.length}개도 표시합니다. 위치를 다시 확인하거나 지운 뒤 저장하세요.`));
 let draft=[];try{draft=JSON.parse(sessionStorage.getItem(draftKey)||'[]');}catch{}
 for(const p of (Array.isArray(draft)&&draft.length?draft:savedPoints))if(points.some(x=>x[0]===p.class_id)&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<packet.width&&p.y>=0&&p.y<packet.height)placed.set(p.class_id,{x:p.x,y:p.y});
 function storeDraft(){try{sessionStorage.setItem(draftKey,JSON.stringify([...placed].map(([class_id,p])=>({class_id,...p}))));}catch{}}
 function update(){count.textContent=`지정 ${placed.size}개 / 최소 6개`;save.disabled=busy||!ready||placed.size<6||!confirm.checked;for(const [id,g] of buttons){g.querySelector('circle').setAttribute('fill',id===active?'#e87431':placed.has(id)?'#138055':'#fff');}render();}
 function render(){if(!ready)return;const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0,canvas.width,canvas.height);for(const [id,p] of placed){ctx.fillStyle=id===active?'#ff7a36':'#00a267';ctx.beginPath();ctx.arc(p.x,p.y,9,0,Math.PI*2);ctx.fill();ctx.font='bold 30px sans-serif';ctx.lineWidth=5;ctx.strokeStyle='#fff';ctx.strokeText(String(id),p.x+12,p.y-8);ctx.fillStyle='#14253a';ctx.fillText(String(id),p.x+12,p.y-8);}}
 for(const [id,x,y] of points){const g=svgNode('g',{tabindex:0,role:'button','aria-label':`코트 기준점 ${id}`});g.append(svgNode('circle',{cx:X(x),cy:Y(y),r:9,fill:'#fff',stroke:'#263e4d','stroke-width':2}));const t=svgNode('text',{x:X(x)+10,y:Y(y)-8,'font-size':12,fill:'#192d3b'});t.textContent=id;g.append(t);const choose=()=>{active=id;selected.textContent=`${id}번 선택됨 · 원본 영상에서 같은 점을 클릭하세요.`;update();};g.addEventListener('click',choose);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}});buttons.set(id,g);diagram.append(g);}
 canvas.addEventListener('click',e=>{if(!ready||busy||active===null){selected.textContent='코트 그림에서 번호를 먼저 선택하세요.';return;}const box=canvas.getBoundingClientRect();placed.set(active,{x:(e.clientX-box.left)*canvas.width/box.width,y:(e.clientY-box.top)*canvas.height/box.height});storeDraft();confirm.checked=false;selected.textContent=`${active}번을 지정했습니다. 다른 번호를 선택하거나 원본을 다시 눌러 수정하세요.`;update();});
 remove.addEventListener('click',()=>{if(active!==null){placed.delete(active);storeDraft();confirm.checked=false;update();}});
 cancel.addEventListener('click',()=>{if(busy)return;placed.clear();try{sessionStorage.removeItem(draftKey);}catch{}confirm.checked=false;active=null;details.open=false;status.textContent='저장하지 않고 취소했습니다.';update();});
 confirm.addEventListener('change',update);
 save.addEventListener('click',async()=>{if(save.disabled)return;busy=true;update();status.textContent='코트 기준점을 검증하고 있습니다…';try{
  await beforeSave();
  const body={frameIndex:index,datasetId:packet.datasetId,inputSha256:packet.inputSha256,previousRevision:frame?.courtRevision??null,confirmed:confirm.checked,landmarks:[...placed].map(([class_id,p])=>({class_id,...p}))};
  const response=await fetch(`/api/cases/${encodeURIComponent(caseId)}/events/${encodeURIComponent(event.id)}/manual-court`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error||`HTTP ${response.status}`);
  try{sessionStorage.removeItem(draftKey);}catch{}status.textContent='저장했습니다. 2D·3D를 다시 불러옵니다. 위치와 방향을 원본과 대조해 주세요.';location.reload();
 }catch(error){status.textContent=error.message||'저장에 실패했습니다. 지정한 점은 유지됩니다.';busy=false;update();}});
 video.addEventListener('loadedmetadata',()=>{video.currentTime=(index+.1)/packet.fps;});video.addEventListener('seeked',()=>{ready=true;status.textContent=`중계 F${index} · 같은 순간의 코트 선을 확인하세요.`;update();});video.addEventListener('error',()=>{status.textContent='중계 원본 프레임을 불러오지 못했습니다. 원본 영상 연결을 확인하세요.';});
 video.src=`/case-assets/${encodeURIComponent(caseId)}/broadcast/${encodeURIComponent(event.broadcast.file)}`;
 details.append(info,diagram,selected,video,canvas,node('p','번호를 고른 뒤 원본의 같은 지점을 클릭하세요.'),remove,count,node('br'),confirmLabel,node('br'),save,cancel,status);root.append(title,explain,details);update();
}
