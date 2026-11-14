import {hitBoxes,hitJoint} from './frame-hit.mjs';
import {EditHistory,restoreObjects} from './edit-history.mjs';
import {mountFlow,flowUrl} from './review-flow.mjs';
import {focusCrop,focusToImage,imageToFocus} from './pose-focus.mjs';
import {mountManualCourt} from './manual-court.mjs';
const $=id=>document.getElementById(id),caseId=new URLSearchParams(location.search).get('id')||'',canvas=$('canvas'),ctx=canvas.getContext('2d');
const focusCanvas=$('focusCanvas'),focusCtx=focusCanvas.getContext('2d');
let focusedPersonId=null,focusRect=null;
let armEditor=null,armEditorLoading=false;
const joints=['코','왼눈','오른눈','왼귀','오른귀','왼어깨','오른어깨','왼팔꿈치','오른팔꿈치','왼손목','오른손목','왼골반','오른골반','왼무릎','오른무릎','왼발목','오른발목'];
const edges=[[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
const roles={player:'선수',referee:'심판',staff:'운영 인력',unknown:'미확정',ball:'공'},colors={player:'#32e3bf',referee:'#ff8f35',staff:'#b992ff',unknown:'#d0d5df',ball:'#ffe441'};
let data,event,record,result,photo,edits={},vis={},generation=0,busy=false,objectView,objects=[],dirty=new Set(),mode='joints',tool='select',drag=null,ignoreClick=false;
let sourcePhotos=new Map();
const imageSource=p=>p?.imageSource||'broadcast';
const activeSource=()=>imageSource(mode==='objects'?objectPerson():person());
const sameSource=p=>imageSource(p)===activeSource();
const personPhoto=p=>imageSource(p)==='wide'?sourcePhotos.get(p.sourceImageUrl):photo;
const stage=new URLSearchParams(location.search).get('stage')==='joints'?'joints':'objects';
mode=stage;let visDirty=false,flowBusy=false,attentionId=null;const editHistory=new EditHistory();
const overlayKey='kbl-review-overlays-v1';
let overlays={boxes:true,joints:true};
try{const saved=JSON.parse(localStorage.getItem(overlayKey)||'{}');for(const key of Object.keys(overlays))if(typeof saved[key]==='boolean')overlays[key]=saved[key];}catch{}
$('showBoxes').checked=overlays.boxes;$('showJoints').checked=overlays.joints;$('jointDisplay').hidden=stage!=='joints';
for(const [id,key] of [['showBoxes','boxes'],['showJoints','joints']])$(id).onchange=()=>{overlays[key]=$(id).checked;try{localStorage.setItem(overlayKey,JSON.stringify(overlays));}catch{}draw();controls();};
const msg=s=>$('status').textContent=s;
async function api(url,body){let r;try{r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}catch{throw Error('서버 응답이 끊겼습니다. 저장된 작업은 유지됩니다. 연결이 복구되면 자세 추정을 다시 눌러 상태를 확인하세요.');}const d=await r.json();if(!r.ok)throw Error(d.error||'처리 실패');return d;}
const courtHelp=document.createElement('div');courtHelp.hidden=stage!=='objects';
const courtButton=document.createElement('button');courtButton.type='button';courtButton.className='secondary';courtButton.textContent='발 접점이 배치되지 않나요? 코트 기준점 확인';
const courtPanel=document.createElement('section');courtPanel.hidden=true;courtHelp.append(courtButton,courtPanel);$('stageHint').after(courtHelp);
courtButton.onclick=async()=>{if(busy||flowBusy||dirty.size||drag){msg('코트 기준점을 확인하기 전에 객체 변경을 먼저 저장하세요.');return;}
 const selectedEvent=event, n=generation;courtButton.disabled=true;
 try{const packet=await api(endpoint('broadcast-tracking'));if(n!==generation)return;const index=objectView.frameIndex,frame=packet.frames.find(f=>f.frameIndex===index);if(!frame)throw Error('선택한 프레임의 코트 정보를 찾을 수 없습니다.');
  mountManualCourt(courtPanel,{caseId,event:selectedEvent,packet,frame,index,required:false,beforeSave:()=>{if(n!==generation||dirty.size||busy||flowBusy||drag)throw Error('객체 변경을 먼저 저장하고 코트 기준점을 다시 확인하세요.');}});
  courtPanel.querySelector('details').open=true;courtPanel.scrollIntoView({block:'start'});
 }catch(e){msg(e.message);}finally{courtButton.disabled=false;}};
const flow=mountFlow({stage,caseId,eventId:()=>event?.id,save:saveCurrent,isDirty:()=>dirty.size>0||Object.keys(edits).length>0||visDirty,isBusy:()=>busy||!!drag||armEditorLoading,onLock:value=>{flowBusy=value;controls();},onBlocked:e=>focusUnplaced(e.unresolvedSpatialIds),message:msg});
$('stageEyebrow').textContent=stage==='objects'?'01 / OBJECT REVIEW':'02 / JOINT REVIEW';
$('stageTitle').textContent=stage==='objects'?'인물과 공을 한 장면에서 확인하세요.':'장면 전체의 관절을 확인하세요.';
$('stageDescription').textContent=stage==='objects'?'놓친 인물·공을 추가하고 역할과 위치를 수정하세요. 모든 클립의 객체 확인이 끝나면 관절 단계로 이어집니다.':'전체 자세를 함께 보고 필요한 인물과 관절만 보정하세요. 객체별 완료 표시 없이 한 번에 확인합니다.';
 $('stageHint').textContent=stage==='objects'?'인물 또는 공 추가를 누르고 원본 위에 박스를 그리세요. 영상에서 인물·공을 클릭해 선택하세요. 겹친 곳은 같은 위치를 다시 클릭하면 다음 객체가 선택됩니다. 공은 영상 좌표로 저장됩니다.':'전체 화면에서 인물을 선택한 뒤 오른쪽 확대 화면에서 관절을 드래그하세요. 두 화면의 수정과 실행 취소는 함께 적용됩니다. 2D 보정은 추정 깊이를 유지하므로 3D 결과도 확인하세요.';
const endpoint=kind=>`/api/cases/${caseId}/events/${event.id}/${kind}`;
function controls(){
 const blocked=busy||flowBusy||!!drag||armEditorLoading;$('undo').disabled=blocked||!editHistory.past.length;$('redo').disabled=blocked||!editHistory.future.length;
 for(const id of ['infer','coordinate'])$(id).disabled=blocked||dirty.size>0||id!=='infer'&&(!person()||!overlays.joints);
 for(const id of ['addObject','addBall','redrawBox','setFoot','applyBox','applyFoot','objectRole','footEvidence','footNote','excludeObject','spatialExcluded','resetObjects'])$(id).disabled=blocked||!objectView;
 for(const id of ['addObject','addBall'])$(id).disabled=blocked||!objectView||activeSource()==='wide';
 $('resetObjects').disabled=blocked||!dirty.size;
 document.querySelectorAll('#events button').forEach(b=>b.disabled=blocked||dirty.size>0||Object.keys(edits).length>0||visDirty);
 for(const id of ['visibility','x','y'])$(id).disabled=blocked||!person()||!overlays.joints;$('objectPerson').disabled=blocked;$('person').disabled=blocked;$('joint').disabled=blocked;
 $('fitFocus').disabled=blocked||!(mode==='objects'?objectPerson():person());$('onlySelectedJoints').disabled=blocked;
 $('focusBox').disabled=blocked||!objectPerson();$('focusFoot').disabled=blocked||!objectPerson()||objectPerson().role==='ball';$('focusRole').disabled=blocked||!objectPerson();
 $('openArmEditor').disabled=blocked||armEditorLoading||!person()?.armRig||!person()?.meshKey||dirty.size>0||Object.keys(edits).length>0||visDirty;
 $('setFoot').disabled=blocked||!objectPerson()||objectPerson().role==='ball';$('infer').hidden=stage!=='joints';$('infer').disabled=blocked||!objectView||dirty.size>0||Object.keys(edits).length>0||visDirty;flow.update();
 $('reviewUnplaced').disabled=blocked;
 for(const id of ['boxX1','boxY1','boxX2','boxY2','footX','footY'])$(id).disabled=blocked||!objectPerson();
}
async function open(id){
 const n=++generation;courtPanel.replaceChildren();courtPanel.hidden=true;editHistory.clear();event=data.events.find(e=>e.id===id)||data.events[0];edits={};visDirty=false;dirty.clear();objects=[];result=null;record=null;photo=null;sourcePhotos=new Map();objectView=null;tool='select';attentionId=null;focusedPersonId=null;focusRect=null;drawFocus();controls();
 $('title').textContent=`판독 ${event.number} · ${event.quarter}Q ${event.gameClock}`;$('spatial').href=flowUrl(stage==='objects'?'joints':'spatial',caseId,event.id);$('spatial').hidden=true;
 $('events').replaceChildren(...data.events.map(e=>{const b=document.createElement('button');b.textContent=`판독 ${e.number}`;b.className=e.id===event.id?'active':'';b.onclick=()=>open(e.id).catch(fail);return b;}));
 history.replaceState(null,'',`?id=${caseId}&stage=${stage}#${event.id}`);await flow.refresh();if(n!==generation||!flow.available)return;
 const ov=await api(endpoint('objects'));if(n!==generation)return;objectView=ov;objects=structuredClone(ov.objects);objectOptions();
 const img=new Image();img.src=ov.frameUrl;await img.decode();if(n!==generation)return;photo=img;draw();
 sourcePhotos=new Map();
 for(const url of new Set(objects.filter(o=>o.imageSource==='wide').map(o=>o.sourceImageUrl))){
  if(!url)continue;const wide=new Image();wide.src=url;await wide.decode();if(n!==generation)return;sourcePhotos.set(url,wide);
 }
 draw();
 const d=await api(endpoint('pose')).catch(e=>({pose:null,error:e.message}));if(n!==generation)return;record=d.pose;
 if(record?.job.state==='complete')await display(record,n);
 else if(record&&['queued','running'].includes(record.job.state)){busy=true;controls();try{await poll(n);}finally{busy=false;controls();}}
 else {msg(record?.job.error||d.error||'저장된 자세가 없습니다. 관절 단계에서 자세 추정을 시작하세요.');}
 history.replaceState(null,'',`?id=${caseId}&stage=${stage}#${event.id}`);setMode(stage);await flow.refresh();controls();
 if(stage==='joints'&&!result&&!busy&&flow.available){await submit({});}else if(result)msg(stage==='objects'?'인물과 공을 확인하고 필요한 부분을 수정하세요.':'장면 전체의 관절을 확인하고 필요한 부분만 수정하세요.');
}
async function display(r,n=generation){
 if(n!==generation)return;record=r;result=structuredClone(r.job.result);vis={};
 for(const p of result.people)vis[p.id]=r.reviewedPeople?.[p.id]?.visibility?.slice()||p.scores.map((s,i)=>i<5?0:s>=.3?2:0);
 $('person').replaceChildren(...result.people.map(p=>new Option(`${roles[p.role]||'심판'} ${p.id}${p.imageSource==='wide'?' · 광각 보완':''}${p.spatialEligible===false?' · 2D 관절 / 공간 위치 미확정':p.accepted?'':' · 기본 자세'}`,p.id)));
 $('joint').replaceChildren(...joints.slice(5).map((name,i)=>new Option(name,String(i+5))));fields();draw();
 const count=result.people.filter(p=>p.accepted).length;$('meta').textContent=`중계 F${result.frameIndex} · 인물 ${objects.filter(o=>!o.excluded&&o.role!=='ball').length}명 · 공 후보·태그 ${objects.filter(o=>!o.excluded&&o.role==='ball').length}개 · 관절 ${result.people.length}명 · 3D 부분 적용 ${count}명 · ${result.totalSeconds.toFixed(1)}초 · 개정 ${result.revision}`;controls();
}
function person(){return result?.people.find(p=>p.id===$('person').value);}
function objectPerson(){return objects.find(p=>p.id===$('objectPerson').value);}
function objectOptions(selected=$('objectPerson').value){
 $('objectPerson').replaceChildren(...objects.map(o=>new Option(`${roles[o.role]} ${o.id.startsWith('new-')?(o.role==='ball'?'새 공':'새 인물'):o.id}${o.excluded?' · 제외':o.spatialExcluded?' · 영상에만 유지':o.added?' · 수동 추가':o.role==='ball'&&!o.manuallyReviewed?' · 검출 후보':o.role!=='ball'&&!o.hasFloorPosition?' · 공간 위치 확인':''}${o.imageSource==='wide'?' · 광각 보완':''}${dirty.has(o.id)?' *':''}`,o.id)));
 if(objects.some(o=>o.id===selected))$('objectPerson').value=selected;objectFields();
}
function objectFields(){
 const o=objectPerson();if(!o)return;
 controls();
 $('footControls').hidden=o.role==='ball';$('footEvidence').value=o.footpointEvidence||'manual-proxy';$('footNote').value=o.footpointNote||'';const off=o.footpointEvidence==='off-frame-estimate';$('footX').min=off?-480:0;$('footX').max=off?2880:1919;$('footY').min=off?-270:0;$('footY').max=off?1620:1079;$('ballNote').hidden=o.role!=='ball';
 $('objectRole').value=o.role;$('focusRole').value=o.role;$('excludeObject').checked=o.excluded;$('spatialExcluded').checked=!!o.spatialExcluded;$('spatialOption').hidden=o.role==='ball';
 ['boxX1','boxY1','boxX2','boxY2'].forEach((id,i)=>$(id).value=o.pixelBox[i].toFixed(1));$('footX').value=o.footpointPixels[0].toFixed(1);$('footY').value=o.footpointPixels[1].toFixed(1);
 $('objectNote').textContent=o.role==='ball'?`${o.added?'수동 추가':'검출 후보'} 공 · 중심 (${o.footpointPixels.map(v=>v.toFixed(1)).join(', ')}) · ${o.excluded?'제외':'영상 위치만 저장'}`:o.excluded?'제외할 객체입니다. 체크를 해제하면 다시 포함됩니다.':o.spatialExcluded?'영상의 박스·관절은 유지하고 2D 코트·3D 배치에서는 제외합니다. 발 접점을 지정하면 다시 배치할 수 있습니다.':`${o.added?'사용자가 추가한 인물':'검출된 인물'} · ${o.footpointManual?(o.frameEdgeEstimate?'발이 화면 밖이라 영상 경계를 임시 위치로 사용 · 실제 발 위치 아님 · 2D/광각에서 확인 필요':o.footpointEvidence==='off-frame-estimate'?'화면 밖 발 위치 추정 · 실제 관찰값 아님':'수동 발 접점'):'박스 아래 중앙을 발 접점으로 사용'}${o.hasFloorPosition?(o.boundaryAdjusted?` · 공간 경계로 ${o.boundaryAdjustmentMetres.toFixed(2)}m 보정 · 실제 투영 위치와 차이 있음`:' · 2D·3D 연결 가능'):objectView?.courtCalibrationRequired?' · 코트 좌표 보정 대기. 저장한 박스·발 접점은 유지됩니다.':' · 발 접점을 보정하거나 영상에만 유지를 선택하세요. 저장 후 공간 배치를 확인합니다.'}`;
}
function fields(){const p=person();if(!p)return;const i=Number($('joint').value);$('x').value=p.keypoints[i][0].toFixed(1);$('y').value=p.keypoints[i][1].toFixed(1);$('visibility').value=vis[p.id][i];$('confidence').textContent=`모델 점수 ${p.scores[i].toFixed(2)}${p.manualJoints?.[i]?' · 기존 수동 보정':''}${edits[p.id]?.joints?.[i]?' · 저장 전 수정':''}`;$('personPoseNote').textContent=p.spatialEligible===false?(objectView?.courtCalibrationRequired?'영상 위 관절을 확인·수정할 수 있습니다. 저장한 관절은 유지되며, 3D·가림 계산은 코트 좌표 보정 후 연결합니다.':'객체 단계의 인물과 연결된 2D 관절입니다. 코트 위치가 없어 3D·가림 계산에는 아직 배치하지 않습니다. 객체 단계에서 발 접점을 확인하세요.'):p.accepted?'추정된 관절 일부를 3D 인체에 적용했습니다.':'이 인물은 자세 신뢰도가 부족해 3D에서 기본 자세로 표시됩니다. 관절을 보정하고 공간 결과를 다시 확인하세요.';if(objects.find(o=>o.id===p.id)?.footpointEvidence==='off-frame-estimate')$('personPoseNote').textContent+=' 발은 화면 밖에 있어 위치를 추정했습니다. 아래쪽 관절과 시야는 직접 관찰한 값이 아닙니다.';}
function setMode(next){
 if(next==='objects'&&Object.keys(edits).length)return msg('관절 보정을 먼저 저장한 뒤 객체를 수정하세요.');
 if(next==='joints'&&dirty.size)return msg('객체 보정을 저장하거나 저장 전 변경을 취소하세요.');
 mode=next;tool='select';drag=null;focusRect=null;focusedPersonId=null;
 const focusPanel=document.querySelector('.pose-focus');$('objectSelectField').hidden=next!=='objects';$('jointSelectField').hidden=next!=='joints';
 $('focusObjectActions').hidden=next!=='objects';$('focusRoleField').hidden=next!=='objects';$('fitFocus').hidden=next==='objects';$('onlySelectedJoints').closest('label').hidden=next==='objects';
 focusPanel.querySelector('strong').textContent=next==='objects'?'선택 객체 확대':'선택 인물 확대';
 focusPanel.setAttribute('aria-label',next==='objects'?'선택 객체 확대 편집':'선택 인물 관절 확대 편집');
 focusCanvas.setAttribute('aria-label',next==='objects'?'선택 객체의 박스와 발 접점을 수정하는 확대 화면':'선택 인물의 관절을 드래그해 보정하는 확대 화면');
 $('objectEditor').hidden=next!=='objects';$('objectTools').hidden=next!=='objects';$('jointEditor').hidden=next!=='joints';
 $('editorHint').textContent=next==='objects'?'인물·공 박스를 클릭해 수정하세요. 저장과 전체 확인은 이 장면의 모든 객체에 적용됩니다.':'영상의 관절 점을 잡아 드래그하세요. 클릭은 선택만 하며, ⌘Z로 한 번의 드래그를 되돌립니다.';draw();controls();
}
function drawFocus(){
 const p=mode==='objects'?objectPerson():person(),w=focusCanvas.width,h=focusCanvas.height;focusCtx.clearRect(0,0,w,h);
 const source=personPhoto(p);
 if(!p||!source){$('focusHint').textContent=mode==='objects'?'객체를 선택하면 확대해서 수정할 수 있습니다.':'인물을 선택하면 관절을 확대해서 조정할 수 있습니다.';return;}
 if(p.id!==focusedPersonId||!focusRect){focusedPersonId=p.id;focusRect=focusCrop(p);}
 if(!focusRect)return;
 const r=focusRect,to=q=>imageToFocus(q,r,w,h);
 focusCtx.drawImage(source,r.x,r.y,r.width,r.height,0,0,w,h);
 if(mode==='objects'){
  const a=to(p.pixelBox.slice(0,2)),b=to(p.pixelBox.slice(2,4));
  focusCtx.strokeStyle='#ff7139';focusCtx.lineWidth=3;focusCtx.setLineDash([]);focusCtx.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);
  if(p.role!=='ball'&&p.footpointPixels){const q=to(p.footpointPixels);focusCtx.fillStyle='#ffdf58';focusCtx.beginPath();focusCtx.arc(q[0],q[1],6,0,Math.PI*2);focusCtx.fill();}
  if(drag?.kind==='box'&&drag.surface===focusCanvas){const a=to(drag.start),b=to(drag.end);focusCtx.setLineDash([8,5]);focusCtx.strokeStyle='#fff';focusCtx.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);focusCtx.setLineDash([]);}
  $('focusHint').textContent=tool==='box'?'확대 화면에서 객체를 감싸도록 드래그하세요.':tool==='foot'?'확대 화면에서 발 접점을 클릭하세요.':p.role==='ball'?`${roles[p.role]} ${p.id} · 박스를 확대 화면에서 수정하세요.`:`${roles[p.role]} ${p.id} · 박스 또는 발 접점을 확대 화면에서 수정하세요.`;
  return;
 }
 $('focusHint').textContent=overlays.joints?`${roles[p.role]} ${p.id} · ${joints[Number($('joint').value)]} · 점을 드래그해 조정 · ⌘Z 실행 취소`:'관절 표시를 켜면 확대 화면에서 수정할 수 있습니다.';
 if(!overlays.joints)return;
 focusCtx.lineWidth=2.8;
 for(const [a,b] of edges){const supported=p.scores[a]>=.3&&p.scores[b]>=.3;focusCtx.strokeStyle=supported?'#48f5b0':'#ffb550';focusCtx.setLineDash(supported?[]:[6,4]);focusCtx.beginPath();focusCtx.moveTo(...to(p.keypoints[a]));focusCtx.lineTo(...to(p.keypoints[b]));focusCtx.stroke();}
 focusCtx.setLineDash([]);
 for(let i=5;i<17;i++){const q=to(p.keypoints[i]),selected=i===Number($('joint').value);focusCtx.fillStyle=selected?'#ff6029':'#32e4b8';focusCtx.strokeStyle='#142439';focusCtx.lineWidth=2;focusCtx.beginPath();focusCtx.arc(...q,selected?8:5.5,0,Math.PI*2);focusCtx.fill();focusCtx.stroke();}
}
$('fitFocus').onclick=()=>{focusRect=null;drawFocus();};
$('focusBox').onclick=()=>{ $('redrawBox').click();drawFocus(); };
$('focusFoot').onclick=()=>{ $('setFoot').click();drawFocus(); };
$('onlySelectedJoints').onchange=()=>draw();
$('openArmEditor').onclick=async()=>{
 if(busy||flowBusy||drag||armEditorLoading||Object.keys(edits).length||visDirty)return msg('현재 관절 수정을 먼저 저장한 뒤 3D 팔을 보정하세요.');
 const selected=person();if(!selected?.armRig||!selected.meshKey)return msg('코트 배치와 3D 인체를 만든 뒤 팔을 보정할 수 있습니다.');
 armEditorLoading=true;controls();
 try{
  const [{installPoseEditor},meshes]=await Promise.all([import('./pose-editor.mjs'),import('./mesh-human.mjs')]);
  await meshes.loadHumanMeshes();meshes.appendHumanMeshes(await api(result.meshUrl));
  armEditor??=installPoseEditor({save:async(frame,changes,progress)=>{
   const savedVis=structuredClone(vis),id=$('person').value;progress('변경한 인물의 3D 자세를 다시 계산합니다.');
   await submit({parentId:frame.jobId,edits:changes});
   record=await api(endpoint('pose/review'),{jobId:result.jobId,people:result.people.map(p=>({personId:p.id,visibility:savedVis[p.id]||vis[p.id],reviewed:false}))});
   vis=savedVis;editHistory.clear();$('person').value=id;fields();draw();controls();
  }});
  await armEditor.open({...result,people:result.people.filter(p=>p.armRig&&p.meshKey)},selected.id);
 }catch(e){msg(e.message);}finally{armEditorLoading=false;controls();}
};
function draw(){
 drawFocus();
 if(mode==='joints')$('editorHint').textContent=overlays.joints?'영상의 관절 점을 잡아 드래그하세요. 클릭은 선택만 하며, ⌘Z로 한 번의 드래그를 되돌립니다.':'관절 표시를 다시 켜면 원본 위에서 관절을 보정할 수 있습니다.';
 $('displayHint').textContent=!overlays.boxes&&(mode==='objects'||!overlays.joints)?'원본 보기 · 저장된 객체·관절 정보는 유지됩니다.':!overlays.boxes?'박스·이름표 숨김 · 관절만 표시합니다.':mode==='joints'&&!overlays.joints?'관절 숨김 · 박스만 표시합니다.':'표시 설정은 저장된 분석 결과에 영향을 주지 않습니다.';
 const selected=mode==='objects'?objectPerson():person();$('selectionHint').textContent=selected?`선택: ${roles[selected.role]||selected.role} ${selected.id}${mode==='joints'?' · '+joints[Number($('joint').value)]:''}`:'영상에서 객체를 선택하세요.';
 const eligible=objects.filter(o=>!o.excluded&&['player','referee'].includes(o.role)),imageOnly=result?.people.filter(p=>p.spatialEligible===false).length||0;
 const unresolved=eligible.filter(o=>!o.hasFloorPosition&&!o.spatialExcluded),placed=eligible.filter(o=>o.hasFloorPosition&&!o.spatialExcluded).length;
 const courtPending=objectView?.courtCalibrationRequired;
 $('reviewUnplaced').hidden=mode!=='objects'||!unresolved.length||courtPending;$('reviewUnplaced').textContent=`위치 미확인 ${unresolved.length}명 찾기`;
 $('handoffSummary').textContent=mode==='objects'?(courtPending?`선수·심판 ${eligible.length}명 · 코트 좌표 보정 대기. 객체 지정과 발 접점 수정은 저장됩니다. 객체 확인 후 다음 클립으로 이동하세요. 2D·3D 배치에는 별도 코트 보정이 필요합니다.`:`선수·심판 ${eligible.length}명 · 공간 배치 ${placed}명 · 영상에만 유지 ${eligible.filter(o=>o.spatialExcluded).length}명 · 발 위치 미확인 ${unresolved.length}명${dirty.size?' (저장 후 배치 재확인)':''}. 객체를 확인하고 다음 클립으로 이동할 수 있으며, 위치는 2D·3D에서 보정합니다.`):`객체 개정 ${objectView?.revision??0} 연결 · 선수·심판 ${eligible.length}명 중 관절 ${result?.people.length??0}명${imageOnly?` · ${imageOnly}명은 코트 위치 미확정으로 2D 관절만 표시`:''} · 운영 인력·미확정·공은 박스만 유지합니다.`;
 $('spatialQueue').replaceChildren(...(mode==='objects'&&!courtPending?unresolved:[]).map(o=>{const b=document.createElement('button');b.className='secondary';b.textContent=`${roles[o.role]} ${o.id} · 발 위치 확인`;b.disabled=busy||flowBusy;b.onclick=()=>msg(focusUnplaced([o.id]));return b;}));
 $('meta').textContent=`중계 F${objectView?.frameIndex??'—'} · 인물 ${objects.filter(o=>!o.excluded&&o.role!=='ball').length}명 · 공 후보·태그 ${objects.filter(o=>!o.excluded&&o.role==='ball').length}개${result?` · 관절 ${result.people.length}명 / 부분 자세 ${result.people.filter(p=>p.accepted).length}명`:' · 자세 재계산 필요'}${dirty.size?' · 저장 전 변경':''}`;
 if(objectView?.wideAssistance?.message)$('handoffSummary').textContent+=' · '+objectView.wideAssistance.message;
 if(activeSource()==='wide')$('selectionHint').textContent+=' · 광각 자동 보완 화면';
 ctx.clearRect(0,0,1920,1080);const source=personPhoto(selected);if(!source)return;ctx.drawImage(source,0,0,1920,1080);
 if(mode==='objects'){
  if(!overlays.boxes&&attentionId){const o=objects.find(o=>o.id===attentionId);if(o&&!o.excluded){const [x1,y1,x2,y2]=o.pixelBox;ctx.strokeStyle='#ff4820';ctx.lineWidth=6;ctx.strokeRect(x1,y1,x2-x1,y2-y1);}}
  for(const o of overlays.boxes?objects.filter(sameSource):[]){const [x1,y1,x2,y2]=o.pixelBox,selected=o.id===$('objectPerson').value;ctx.strokeStyle=o.excluded?'#aaa':colors[o.role];ctx.lineWidth=selected?6:2;ctx.setLineDash(o.excluded?[10,8]:[]);ctx.strokeRect(x1,y1,x2-x1,y2-y1);ctx.setLineDash([]);ctx.font=`${selected?'bold ':''}21px sans-serif`;const label=`${roles[o.role]} ${o.id.replace(/^manual-/, 'M-').replace(/^new-.*/, '새 인물')}${o.excluded?' (제외)':''}`;const width=ctx.measureText(label).width;ctx.fillStyle='rgba(12,20,43,.85)';ctx.fillRect(x1,Math.max(0,y1-29),width+12,29);ctx.fillStyle='white';ctx.fillText(label,x1+6,Math.max(23,y1-7));
   if(selected&&!o.excluded){const [x,y]=o.footpointPixels;ctx.strokeStyle='#ff4820';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(x-12,y);ctx.lineTo(x+12,y);ctx.moveTo(x,y-12);ctx.lineTo(x,y+12);ctx.stroke();}
  }
  if(drag){ctx.strokeStyle='#ff8538';ctx.lineWidth=5;ctx.setLineDash([12,7]);ctx.strokeRect(drag.start[0],drag.start[1],drag.end[0]-drag.start[0],drag.end[1]-drag.start[1]);ctx.setLineDash([]);}return;
 }
 const poseIds=new Set((result?.people||[]).map(p=>p.id));
 for(const o of objects.filter(o=>sameSource(o)&&overlays.boxes&&!o.excluded&&!poseIds.has(o.id))){const [x1,y1,x2,y2]=o.pixelBox;ctx.strokeStyle=colors[o.role];ctx.lineWidth=2;ctx.setLineDash([7,5]);ctx.strokeRect(x1,y1,x2-x1,y2-y1);ctx.setLineDash([]);ctx.font='20px sans-serif';ctx.fillStyle=colors[o.role];ctx.fillText(`${roles[o.role]} · 관절 대상 아님`,x1,Math.max(22,y1-6));}
 for(const p of (result?.people||[]).filter(sameSource)){
 const selected=p.id===$('person').value;ctx.globalAlpha=selected?1:.55;const [x1,y1,x2,y2]=p.pixelBox;
 if(overlays.boxes){ctx.strokeStyle=selected?'#ff8f35':colors[p.role];ctx.lineWidth=selected?4:2;ctx.strokeRect(x1,y1,x2-x1,y2-y1);}
 if(!overlays.joints||$('onlySelectedJoints').checked&&!selected)continue;
 for(const [a,b] of edges){ctx.strokeStyle=p.scores[a]>=.3&&p.scores[b]>=.3?'#4af1ad':'#ffa840';ctx.setLineDash(p.scores[a]>=.3&&p.scores[b]>=.3?[]:[8,5]);ctx.beginPath();ctx.moveTo(...p.keypoints[a]);ctx.lineTo(...p.keypoints[b]);ctx.stroke();}ctx.setLineDash([]);
 for(let i=5;i<17;i++){ctx.fillStyle=selected&&i===Number($('joint').value)?'#ff4820':'#37f4c4';ctx.beginPath();ctx.arc(...p.keypoints[i],selected&&i===Number($('joint').value)?10:5,0,Math.PI*2);ctx.fill();if(selected){ctx.fillStyle='white';ctx.font='19px sans-serif';ctx.fillText(String(i),p.keypoints[i][0]+9,p.keypoints[i][1]-8);}}
 }ctx.globalAlpha=1;
}
function focusUnplaced(ids){
 const candidates=objects.filter(o=>!o.excluded&&['player','referee'].includes(o.role)&&!o.hasFloorPosition&&!o.spatialExcluded);
 const target=ids?.length?candidates.find(o=>ids.includes(o.id)):candidates[0];
 if(!target)return '저장한 객체의 공간 위치를 다시 확인하세요.';
 attentionId=target.id;$('objectPerson').value=target.id;tool='select';objectFields();draw();
 const text=`${roles[target.role]} ${target.id}: ${dirty.has(target.id)?'저장 전 변경이 있으며, ':''}코트 위 발 위치가 미확정입니다. 발 접점을 보정하거나, 판단이 어려우면 ‘공간 위치 판단 불가 · 영상에만 유지’를 선택한 뒤 클립 확인을 누르세요.`;
 $('selectionHint').textContent=text;$('canvasWrap').scrollIntoView({block:'center',behavior:'smooth'});return text;
}
$('reviewUnplaced').onclick=()=>msg(focusUnplaced());
function change(x,y,recordHistory=true){const p=person(),i=Number($('joint').value);if(!p||busy||flowBusy||![x,y].every(Number.isFinite)||x<0||x>1919||y<0||y>1079)return;if(p.keypoints[i][0]===x&&p.keypoints[i][1]===y)return;if(recordHistory)remember();p.keypoints[i]=[x,y];edits[p.id]??={joints:{}};edits[p.id].joints[i]=[x,y];fields();draw();controls();msg(result?.poseSource==='image-only-inferred'?'수정한 영상 관절을 저장하세요. 3D·가림 계산에는 코트 좌표 보정 후 반영합니다.':'수정한 관절을 저장하면 3D와 가림 계산용 메시를 다시 만듭니다.');}
function markObject(o){dirty.add(o.id);objectOptions(o.id);draw();controls();msg(`객체 ${dirty.size}개 변경 · 현재 상태 저장으로 보관하세요.`);}
function editBox(b){const o=objectPerson();if(!o)return;if(!b.every(Number.isFinite)||b[0]<0||b[1]<0||b[2]>1920||b[3]>1080||b[2]-b[0]<(o.role==='ball'?2:4)||b[3]-b[1]<(o.role==='ball'?2:8))return msg('인물 전체를 포함하는 유효한 박스를 지정하세요.');remember();o.pixelBox=b;o.footpointPixels=[(b[0]+b[2])/2,o.role==='ball'?(b[1]+b[3])/2:Math.min(1079,b[3])];o.footpointManual=false;markObject(o);}
function editFoot(x,y){const o=objectPerson();const off=o?.footpointEvidence==='off-frame-estimate';if(!o||![x,y].every(Number.isFinite)||x<(off?-480:0)||x>(off?2880:1919)||y<(off?-270:0)||y>(off?1620:1079))return msg('영상 안의 발 접점을 지정하세요.');remember();o.footpointPixels=[x,y];o.footpointManual=true;o.spatialExcluded=false;markObject(o);}
function point(e,surface=canvas){const b=surface.getBoundingClientRect();const q=surface===focusCanvas&&focusRect?focusToImage([e.clientX-b.left,e.clientY-b.top],focusRect,b.width,b.height):[(e.clientX-b.left)/b.width*1920,(e.clientY-b.top)/b.height*1080];return [Math.min(1919,Math.max(0,q[0])),Math.min(1079,Math.max(0,q[1]))];}
let lastPick=null;
function jointHitAt(p,surface=canvas){const b=surface.getBoundingClientRect(),focus=surface===focusCanvas;const people=focus||$('onlySelectedJoints').checked?(person()?[person()]:[]):(result?.people||[]).filter(sameSource);return overlays.joints?hitJoint(people,p,b.width/(focus?focusRect?.width:1920),b.height/(focus?focusRect?.height:1080),$('person').value):null;}
function selectAt(p){
 const hits=hitBoxes((mode==='objects'?objects:result?.people||[]).filter(sameSource),p);
 if(!hits.length){lastPick=null;return;}
 const signature=hits.map(h=>h.id).join('|'),rect=canvas.getBoundingClientRect();
 const repeated=lastPick?.signature===signature&&Math.hypot((lastPick.point[0]-p[0])*rect.width/1920,(lastPick.point[1]-p[1])*rect.height/1080)<8;
 const index=repeated?(lastPick.index+1)%hits.length:0,hit=hits[index];lastPick={signature,point:p,index};
 if(mode==='objects'){$('objectPerson').value=hit.id;objectFields();}else{$('person').value=hit.id;fields();}
 draw();msg(`${roles[hit.role]} ${hit.id} 선택${hits.length>1?` · 겹친 객체 ${index+1}/${hits.length} · 같은 곳을 다시 클릭하면 다음 객체를 선택합니다.`:''}`);
}
function pointerDown(e,surface=canvas){
 if(busy||flowBusy||drag||e.button!==0)return;
 ignoreClick=false;const p=point(e,surface);
 if(mode==='joints'){
  const hit=jointHitAt(p,surface);if(!hit)return;
  $('person').value=hit.personId;$('joint').value=String(hit.joint);fields();draw();
  drag={kind:'joint',surface,pointerId:e.pointerId,start:p,origin:person().keypoints[hit.joint].slice(),before:snapshot(),moved:false};
  surface.style.cursor='grabbing';msg(`${roles[person().role]} ${hit.personId} · ${joints[hit.joint]} 선택 — 드래그로 이동하세요.`);
 }else if((surface===canvas&&['add','ball','box'].includes(tool))||(surface===focusCanvas&&focusRect&&tool==='box')){drag={kind:'box',surface,pointerId:e.pointerId,start:p,end:p};}
 else return;
 e.preventDefault();surface.setPointerCapture(e.pointerId);controls();
}
canvas.onpointerdown=e=>pointerDown(e,canvas);focusCanvas.onpointerdown=e=>pointerDown(e,focusCanvas);
function moveDrag(e){
 if(!drag||e.pointerId!==drag.pointerId)return;
 const p=point(e,drag.surface);
 if(drag.kind==='joint'){
  const rect=drag.surface.getBoundingClientRect(),focus=drag.surface===focusCanvas;
  if(!drag.moved&&Math.hypot((p[0]-drag.start[0])*rect.width/(focus?focusRect.width:1920),(p[1]-drag.start[1])*rect.height/(focus?focusRect.height:1080))<2)return;
  drag.moved=true;
  change(Math.max(0,Math.min(1919,drag.origin[0]+p[0]-drag.start[0])),Math.max(0,Math.min(1079,drag.origin[1]+p[1]-drag.start[1])),false);
 }else{drag.end=p;draw();}
}
canvas.onpointermove=e=>{if(drag){moveDrag(e);return;}const p=point(e);canvas.style.cursor=mode==='joints'&&jointHitAt(p)?'grab':mode==='objects'&&tool!=='select'?'crosshair':hitBoxes(mode==='objects'?objects:result?.people||[],p).length?'pointer':'default';};
focusCanvas.onpointermove=e=>{if(drag){moveDrag(e);return;}focusCanvas.style.cursor=mode==='objects'&&['box','foot'].includes(tool)?'crosshair':mode==='joints'&&focusRect&&jointHitAt(point(e,focusCanvas),focusCanvas)?'grab':'default';};
function cancelDrag(){const old=drag;if(!old)return;drag=null;ignoreClick=true;if(old.surface.hasPointerCapture(old.pointerId))old.surface.releasePointerCapture(old.pointerId);if(old.kind==='joint'&&old.moved)restore(old.before);draw();controls();msg('드래그를 취소했습니다.');old.surface.style.cursor='default';}
canvas.onpointercancel=cancelDrag;canvas.onlostpointercapture=()=>{if(drag)cancelDrag();};
focusCanvas.onpointercancel=cancelDrag;focusCanvas.onlostpointercapture=()=>{if(drag?.surface===focusCanvas)cancelDrag();};
function pointerUp(e){
 if(!drag||e.pointerId!==drag.pointerId)return;
 moveDrag(e);const old=drag;drag=null;ignoreClick=true;old.surface.releasePointerCapture(e.pointerId);old.surface.style.cursor='default';
 if(old.kind==='joint'){
  if(old.moved&&JSON.stringify(snapshot())!==JSON.stringify(old.before)){editHistory.push(old.before);msg('관절 이동 완료 · ⌘Z로 되돌릴 수 있습니다. 현재 상태 저장 시 3D·가림 계산에 반영됩니다.');}
  else if(old.moved)restore(old.before);
  controls();draw();return;
 }
 const end=point(e,old.surface),b=[Math.min(old.start[0],end[0]),Math.min(old.start[1],end[1]),Math.max(old.start[0],end[0]),Math.max(old.start[1],end[1])];
 controls();if(b[2]-b[0]<(tool==='ball'?2:4)||b[3]-b[1]<(tool==='ball'?2:8)){draw();return msg('드래그로 객체 전체를 감싸 주세요.');}
 if(tool==='add'||tool==='ball'){const id='new-'+crypto.randomUUID();remember();objects.push({id,role:tool==='ball'?'ball':'player',pixelBox:b,footpointPixels:[(b[0]+b[2])/2,tool==='ball'?(b[1]+b[3])/2:b[3]],footpointManual:false,excluded:false,spatialExcluded:false,added:true,hasFloorPosition:false});objectOptions(id);markObject(objectPerson());}else editBox(b);tool='select';drawFocus();
}
canvas.onpointerup=pointerUp;focusCanvas.onpointerup=pointerUp;
focusCanvas.onclick=e=>{if(ignoreClick){ignoreClick=false;return;}if(busy||flowBusy||drag)return;if(mode==='objects'&&tool==='foot'&&focusRect){editFoot(...point(e,focusCanvas));tool='select';draw();}};
canvas.onclick=e=>{
 if(ignoreClick){ignoreClick=false;return;}if(busy||flowBusy||drag)return;
 const p=point(e);if(mode==='objects'&&tool==='foot'){editFoot(...p);tool='select';return;}
 if(mode==='objects'&&tool!=='select')return;
 selectAt(p);
};
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&drag){e.preventDefault();cancelDrag();}});

$('objectPerson').onchange=()=>{tool='select';attentionId=null;objectFields();draw();};function changeObjectRole(role){const o=objectPerson();if(o&&o.role!==role){remember();o.role=role;if(o.role==='ball'){o.footpointPixels=[(o.pixelBox[0]+o.pixelBox[2])/2,(o.pixelBox[1]+o.pixelBox[3])/2];o.footpointManual=false;o.spatialExcluded=false;}markObject(o);}}
$('objectRole').onchange=e=>changeObjectRole(e.target.value);$('focusRole').onchange=e=>changeObjectRole(e.target.value);$('excludeObject').onchange=()=>{const o=objectPerson();if(o){remember();o.excluded=$('excludeObject').checked;markObject(o);}};
$('spatialExcluded').onchange=()=>{const o=objectPerson();if(o){remember();o.spatialExcluded=$('spatialExcluded').checked;markObject(o);}};
 $('footEvidence').onchange=()=>{const o=objectPerson();if(o){remember();o.footpointEvidence=$('footEvidence').value;markObject(o);}};
$('footNote').onchange=()=>{const o=objectPerson();if(o){remember();o.footpointNote=$('footNote').value;markObject(o);}};
$('addBall').onclick=()=>{tool='ball';msg('공을 감싸도록 드래그하세요. 공 중심과 박스가 이 프레임에 저장됩니다.');};
$('addObject').onclick=()=>{tool='add';msg('놓친 인물의 머리부터 발까지 드래그해 박스를 그리세요. 그다음 역할과 발 접점을 확인하세요.');};$('redrawBox').onclick=()=>{tool='box';msg('선택한 인물의 박스를 원본 위에 다시 드래그하세요.');};$('setFoot').onclick=()=>{tool='foot';msg('선택한 인물의 발이 코트에 닿는 위치를 클릭하세요. 가려져 있다면 위치 추정이므로 3D에서 다시 확인하세요.');};
$('applyBox').onclick=()=>editBox(['boxX1','boxY1','boxX2','boxY2'].map(id=>Number($(id).value)));$('applyFoot').onclick=()=>editFoot(Number($('footX').value),Number($('footY').value));
$('resetObjects').onclick=()=>{remember();objects=structuredClone(objectView.objects);dirty.clear();tool='select';objectOptions();draw();controls();msg('저장 전 객체 변경을 취소했습니다.');};
async function saveCurrent(){
 if(stage==='objects'){
  if(!dirty.size)return;
  busy=true;controls();try{const selected=$('objectPerson').value;objectView=await api(endpoint('objects'),{...Object.fromEntries(['selectionRevision','datasetId','inputSha256','frameIndex','revision'].map(k=>[k,objectView[k]])),updates:objects.filter(o=>dirty.has(o.id)).map(({id,role,pixelBox,footpointPixels,footpointManual,footpointEvidence,footpointNote,excluded,spatialExcluded})=>({id,role,pixelBox,footpointPixels,footpointManual,footpointEvidence:footpointEvidence||'manual-proxy',footpointNote:footpointNote||'',excluded,spatialExcluded:!!spatialExcluded}))});editHistory.remap(objectView.assignedIds||{});objects=structuredClone(objectView.objects);dirty.clear();result=null;record=null;objectOptions(objectView.assignedIds?.[selected]||selected);draw();msg('객체 상태 저장 완료. 장면 전체 확인 후 관절 단계에서 재계산합니다.');}finally{busy=false;controls();}
 }else{
  const savedVis=structuredClone(vis),hasEdits=Object.keys(edits).length>0;
  if(hasEdits){visDirty=true;await submit({parentId:result.jobId,edits});}
  if(!result)throw Error('자세 추정을 먼저 완료하세요.');
  if(hasEdits||visDirty){busy=true;controls();try{vis=savedVis;record=await api(endpoint('pose/review'),{jobId:result.jobId,people:result.people.map(p=>({personId:p.id,visibility:savedVis[p.id]||vis[p.id],reviewed:false}))});vis=savedVis;visDirty=false;fields();draw();}finally{busy=false;controls();}}
 }
}
$('coordinate').onclick=()=>change(Number($('x').value),Number($('y').value));$('person').onchange=$('joint').onchange=()=>{fields();draw();};$('visibility').onchange=()=>{const p=person();if(p){remember();vis[p.id][Number($('joint').value)]=Number($('visibility').value);visDirty=true;controls();}};
function snapshot(){return stage==='objects'?{objects:structuredClone(objects)}:{people:(result?.people||[]).map(p=>({id:p.id,keypoints:structuredClone(p.keypoints)})),vis:structuredClone(vis)};}
function remember(){editHistory.push(snapshot());}
function restore(snapshot){
 if(stage==='objects'){const state=restoreObjects(snapshot.objects,objectView.objects);objects=state.objects;dirty=state.dirty;tool='select';objectOptions();}
 else{
  const base=new Map((record?.job.result.people||[]).map(p=>[p.id,p]));edits={};
  for(const old of snapshot.people){const p=result.people.find(p=>p.id===old.id),original=base.get(old.id);if(!p||!original)continue;p.keypoints=structuredClone(old.keypoints);for(let i=5;i<17;i++)if(JSON.stringify(p.keypoints[i])!==JSON.stringify(original.keypoints[i])){edits[p.id]??={joints:{}};edits[p.id].joints[i]=p.keypoints[i];}}
  vis=structuredClone(snapshot.vis);visDirty=result.people.some(p=>JSON.stringify(vis[p.id])!==JSON.stringify(record.reviewedPeople?.[p.id]?.visibility||p.scores.map((s,i)=>i<5?0:s>=.3?2:0)));fields();
 }
 draw();controls();msg('편집 기록을 복원했습니다. 현재 상태 저장으로 반영하세요.');
}
function undo(){if(busy||flowBusy||drag)return;const state=editHistory.undo(snapshot());if(state)restore(state);}
function redo(){if(busy||flowBusy||drag)return;const state=editHistory.redo(snapshot());if(state)restore(state);}
$('undo').onclick=undo;$('redo').onclick=redo;
window.addEventListener('keydown',e=>{
 if(armEditor?.isOpen()||!(e.metaKey||e.ctrlKey)||e.altKey||e.target.isContentEditable||e.target.tagName==='TEXTAREA'||(e.target.tagName==='INPUT'&&!['checkbox','radio','button'].includes(e.target.type)))return;
 if(e.key.toLowerCase()==='z'){e.preventDefault();if(e.shiftKey)redo();else undo();}
 else if(e.ctrlKey&&e.key.toLowerCase()==='y'){e.preventDefault();redo();}
});
async function poll(n){
 while(n===generation){const d=await api(endpoint('pose'));if(n!==generation)return;record=d.pose;if(!record)throw Error('객체 또는 자세가 변경됐습니다. 자세 추정을 다시 실행하세요.');msg(record.job.stage);
 if(['running','queued'].includes(record.job.state)){await new Promise(resolve=>setTimeout(resolve,1000));continue;}
 if(record.job.state==='failed'||record.job.state==='interrupted')throw Error(record.job.error||'연결이 중단됐습니다. 자세 추정을 다시 누르면 저장된 작업을 이어받습니다.');edits={};await display(record,n);msg(result.poseSource==='image-only-inferred'?'영상 관절 준비 완료. 관절 확인·수정 후 다음 클립으로 진행하세요. 2D·3D 공간 배치는 코트 보정이 필요합니다.':'자세 준비 완료. 장면 전체를 확인하고 다음 단계로 진행하세요.');return;
 }
}
function fail(e){busy=false;controls();msg(e.message);}
async function submit(body){busy=true;controls();try{record=await api(endpoint('pose'),{selectionRevision:data.revision,datasetId:objectView?.datasetId,...body});await poll(generation);await flow.refresh();}finally{busy=false;controls();}}
$('infer').onclick=()=>submit({}).catch(fail);
window.addEventListener('beforeunload',e=>{if(dirty.size||Object.keys(edits).length||visDirty||armEditor?.isDirty()){e.preventDefault();e.returnValue='';}});
try{msg('저장된 장면과 단계 상태를 불러오는 중입니다…');data=await api(`/api/cases/${caseId}`);await open(location.hash.slice(1));}catch(e){fail(e);}
