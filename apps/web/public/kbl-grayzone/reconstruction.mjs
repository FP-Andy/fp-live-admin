import {setCourtPosition,validCourtPosition,proposeGroundPosition} from './ground-position.mjs';
import {dragStarted,positionDragPoint,positionTargets,placementTarget} from './map-interaction.mjs';
import {mountWideReference} from './wide-reference.mjs';
import {createWidePositionMode} from './wide-position-mode.mjs';
import {mountManualCourt} from './manual-court.mjs';
import {createSceneDraft} from './scene-draft.mjs';
import {mountReviewVideos} from './review-videos.mjs';
import {analyzeCrew,crewObservers} from './crew-analysis.mjs';
import {reconcileScene} from './scene-handoff.mjs';
import {loadCourtAsset} from './court-asset.mjs';
import {drawSceneMap,drawCrewMap,mapPoint,mapCourt,directionHandle} from './scene-map.mjs';
import {EditHistory} from './edit-history.mjs';
import {reviewPoint,reviewTarget} from './review-point.mjs';
import {resolveBodyDirection,describeDirection,wrapAngle} from './body-direction.mjs';
import {mountFlow,flowUrl} from './review-flow.mjs';
import {CourtRenderer,courtLines} from './renderer.mjs';
import {loadHumanMeshes,appendHumanMeshes} from './mesh-human.mjs';
import {DEFAULTS,visibility,bearing} from './geometry.mjs';
const $=id=>document.getElementById(id),caseId=new URLSearchParams(location.search).get('id')||'';
const automaticToken=new URLSearchParams(location.search).get('autoPrepare');
function autoMessage(type,extra={}){if(automaticToken&&window.parent!==window)window.parent.postMessage({type,token:automaticToken,caseId,...extra},location.origin);}
window.addEventListener('message',async e=>{
 if(!automaticToken||e.origin!==location.origin||e.source!==window.parent||e.data?.type!=='kbl-auto-pose-start'||e.data?.token!==automaticToken)return;
 try{const previousCaptureId=currentCapture?.captureId;if(!previousCaptureId||!event)throw Error('저장된 공간 장면을 찾을 수 없습니다.');
  await applySharedPose(true,true);autoMessage('kbl-auto-pose-complete',{eventId:event.id,previousCaptureId,captureId:currentCapture?.captureId});
 }catch(error){autoMessage('kbl-auto-pose-error',{error:error.message||'자동 자세 보정에 실패했습니다.'});}
});
const roleNames={player:'선수',referee:'심판',staff:'운영',unknown:'미확정'},colors={player:'#2797ba',referee:'#ed873f',staff:'#7c5e9b',unknown:'#969ba4'};
let poseResult=null,basePoseResult=null,poseVariantId=null,lastModel=null,mapDrag=null,aimMode=false,pointMode=false,moveMode=false,partialPick=null,groundProposal=null;const mapHistory=new EditHistory();
let placementId='',dragPaint=null,dragPointer=null;
let data,event,packet,frame,state,overview,eye,meshSha256,busy=false,token=0,dirtyScene=false,wideReferencePanel=null,currentCapture=null;
let sceneDraft=null,draftTimer=null,draftTracking=false,draftPending=false,draftBaseline='';
mountReviewVideos({caseId,getEvent:()=>event?.id,hasUnsaved:()=>dirtyScene||draftPending||!!wideReferencePanel?.dirty,isBusy:()=>busy,ensureSharedPose:()=>applySharedPose(true)});
const draftNotice=document.createElement('section');draftNotice.hidden=true;draftNotice.setAttribute('role','status');draftNotice.className='crew-section';
const draftText=document.createElement('p');draftText.textContent='이 장면에 저장하지 않은 임시 수정이 있습니다. 복원해 확인하거나 삭제할 수 있습니다.';
const draftRestore=document.createElement('button');draftRestore.type='button';draftRestore.textContent='임시 수정 복원';
const draftDiscard=document.createElement('button');draftDiscard.type='button';draftDiscard.className='secondary';draftDiscard.textContent='임시 수정 삭제';
draftNotice.append(draftText,draftRestore,draftDiscard);$('manualCourt').before(draftNotice);
function draftIdentity(){return [location.pathname,caseId,event.id,data.revision,frame.frameIndex,packet.datasetId,packet.inputSha256,frame.courtRevision||null,frame.sceneEvidence?.sha256||null,packet.uniforms?.revision||null,poseResult?.jobId||null,currentCapture?.captureId||null,frame.boxes.map(b=>[b.id,b.roleHint,b.spatialExcluded===true])];}
function configureDraft(show=true){try{sceneDraft=createSceneDraft(sessionStorage,draftIdentity());draftPending=Boolean(show&&sceneDraft.read());draftNotice.hidden=!draftPending;}catch{sceneDraft=null;draftPending=false;draftNotice.hidden=true;}}
function preserveDraft(){if(draftTracking&&!draftPending&&dirtyScene&&sceneDraft&&state)sceneDraft.write(state);}
function scheduleDraft(){if(!draftTracking)return;clearTimeout(draftTimer);draftTimer=setTimeout(preserveDraft,150);}
draftRestore.onclick=()=>{const saved=sceneDraft?.read();if(!saved||busy)return;if(JSON.stringify(state)!==draftBaseline){message('현재 화면에서 수정한 내용을 먼저 저장하거나 되돌린 후 임시 수정을 복원하세요.');return;}mapHistory.clear();state=reconcileScene(frame,saved.state,state);dirtyScene=true;draftPending=false;draftNotice.hidden=true;syncTeams();options();render();flow.update();message('임시 수정을 복원했습니다. 내용을 확인한 뒤 현재 상태 저장을 눌러 주세요.');};
draftDiscard.onclick=()=>{if(busy)return;sceneDraft?.clear();draftPending=false;draftNotice.hidden=true;preserveDraft();message('이전 임시 수정만 삭제했습니다. 저장된 검수는 유지됩니다.');};
const widePositionMode=createWidePositionMode(validCourtPosition);
const wideOverlay=document.createElement('canvas');wideOverlay.width=1280;wideOverlay.height=800;wideOverlay.setAttribute('aria-label','광각 심판 임시 위치');wideOverlay.setAttribute('aria-hidden','true');wideOverlay.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
const mapWrapper=document.createElement('div'),mapCanvas=$('map');mapWrapper.style.cssText='position:relative;width:100%';mapCanvas.replaceWith(mapWrapper);mapWrapper.append(mapCanvas,wideOverlay);
function drawWidePreview(){const x=wideOverlay.getContext('2d');x.clearRect(0,0,1280,800);const p=widePositionMode.preview;if(!p)return;const [cx,cy]=mapPoint(p);x.save();x.beginPath();x.arc(cx,cy,16,0,2*Math.PI);x.fillStyle='#ff8a21';x.fill();x.lineWidth=4;x.setLineDash([5,4]);x.strokeStyle='#101633';x.stroke();x.setLineDash([]);x.font='bold 22px sans-serif';x.lineWidth=5;x.strokeStyle='#fff';x.strokeText('새 광각 심판 · 저장 전',cx+20,cy-16);x.fillStyle='#101633';x.fillText('새 광각 심판 · 저장 전',cx+20,cy-16);x.restore();}
const message=s=>$('status').textContent=s;
const flow=mountFlow({stage:'spatial',caseId,eventId:()=>event?.id,save:async()=>{setBusy(true);try{await save();dirtyScene=false;}finally{setBusy(false);}},isDirty:()=>dirtyScene||!!wideReferencePanel?.dirty,isBusy:()=>busy||!!mapDrag,message});
async function json(url,options){const r=await fetch(url,options);const d=await r.json();if(!r.ok){if(options?.method==='POST'&&url.endsWith('/reconstruction')&&d.error?.includes('공간 편집 화면이 업데이트'))throw Error('마네킹 모델을 저장하려면 현재 화면을 열어 둔 채 로컬 서버를 다시 시작한 다음 다시 저장하세요.');throw Error(d.error||`HTTP ${r.status}`);}return d;}
const nextPaint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
function fill(select,items,value){select.replaceChildren(...items.map(e=>new Option(`${roleNames[e.role]} ${e.id}`,e.id)));select.value=value;}
function selectPlacement(id){
 const next=placementTarget(frame?.boxes||[],id);
 if(placementId!==next){groundProposal=null;partialPick=null;$('acceptProposal').hidden=true;$('proposalStatus').textContent='';}
 placementId=next;$('partialPerson').value=next;
}
function placementControls(){for(const id of ['placePartial','proposePosition'])$(id).disabled=busy||!!mapDrag||!placementId;}
function options(){
 const candidates=state.entities.filter(e=>e.role==='referee'&&!e.positionOnly);
 if(!candidates.some(e=>e.id===state.observerId))state.observerId=candidates[0]?.id;
 const targets=state.entities.filter(e=>e.id!==state.observerId&&!e.positionOnly);
 if(!targets.some(e=>e.id===state.targetId))state.targetId=targets.find(e=>e.role==='player')?.id||targets[0]?.id;
 fill($('observer'),candidates,state.observerId);fill($('target'),targets,state.targetId);
 const editId=state.entities.some(e=>e.id===$('editPerson').value)?$('editPerson').value:state.entities[0]?.id;
 fill($('editPerson'),state.entities,editId);selectPlacement(editId);const viewers=state.entities.filter(e=>!e.positionOnly);state.viewpointId=viewers.some(e=>e.id===state.viewpointId)?state.viewpointId:state.observerId;fill($('viewpoint'),viewers,state.viewpointId);editFields();
}
function matchingPose(e){return poseResult?.people.find(p=>p.id===e.id&&p.role===e.role&&(e.positionSource==='manual'||Math.hypot(p.x-e.x,p.y-e.y)<.001));}
function directionFor(e,p){return poseVariantId&&Number.isFinite(e.bodyHeading)?{heading:e.bodyHeading,status:e.bodyDirectionSource==='manual'?'manual':'estimated',source:'saved-map'}:resolveBodyDirection(e,p);}
function editFields(){
 const e=state?.entities.find(e=>e.id===$('editPerson').value);if(!e)return;
 const p=matchingPose(e),d=directionFor(e,p);
 $('editRole').value=e.role;$('editRole').disabled=true;$('editX').value=e.x.toFixed(2);$('editY').value=e.y.toFixed(2);$('bodyAngle').value=Math.round(d.heading*180/Math.PI);
 $('editTeam').value=e.teamSource==='manual'?e.team||'unknown':'auto';$('editTeam').disabled=e.role!=='player'||busy;const box=frame.boxes.find(b=>b.id===e.id);$('teamEvidence').textContent=e.role==='player'?`팀: ${e.team==='home'?data.home:e.team==='away'?data.away:'미확정'} · ${e.teamSource==='manual'?'수동 지정':'유니폼 색상 제안'}${e.teamSource!=='manual'&&box?.teamConfidence?' · 색상 비교 기반, 검수 필요':''}`:'심판·운영 인력은 홈·어웨이를 지정하지 않습니다.';
 for(const team of ['home','away'])$('editTeam').querySelector(`option[value="${team}"]`).textContent=`${team==='home'?'홈':'어웨이'} · ${data[team]}`;
 $('teamSwatch').hidden=e.role!=='player';$('teamSwatch').style.background=['home','away'].includes(e.team)?packet.uniforms[e.team]:colors.player;
 $('positionEvidence').textContent=e.positionOnly?'광각 관측 위치만 보관 · 시선·자세 미확인':e.positionEvidence?.method==='height-plane-proposal'?'상체·신장 기반 추정 후 적용':e.positionSource==='manual'?'작업자가 직접 지정한 추정 위치 · 실제 발 접점 미확인':frame.boxes.find(b=>b.id===e.id)?.footpointFrameEdge?'발이 화면 밖이라 화면 경계에 둔 임시 추정 · 2D/광각에서 위치 확인 필요':'발 접점의 코트 투영';
 for(const id of ['aimMap','turnBody','bodyAngle','applyEdit','flipBody'])$(id).disabled=busy||!!e.positionOnly;
 $('bodyEvidence').textContent=e.positionOnly?'광각 위치만 관측 · 몸 방향과 시선은 미확인':describeDirection(e,p,poseResult?.camera);$('autoBody').disabled=busy||!p?.bodyDirection;
}
function model(){
 const roleCounts={};const palette=packet.uniforms;const bodies=state.entities.map(e=>{
  const p=matchingPose(e),direction=directionFor(e,p);
  roleCounts[e.role]=(roleCounts[e.role]||0)+1;const label=(e.role==='referee'?'R':e.role==='player'?'P':'S')+roleCounts[e.role],color=e.role==='player'&&['home','away'].includes(e.team)?palette[e.team]:colors[e.role];
  return {...e,label,heading:direction.heading,viewHeading:Number.isFinite(e.viewHeading)?e.viewHeading:direction.heading,bodyHeading:direction.heading,bodyDirection:direction,color,height:e.role==='staff'?1.75:undefined,...(p?.accepted&&!(poseVariantId&&e.role==='referee')?{meshKey:p.meshKey,eyeLocal:p.eyeLocal,poseBodyHeading:p.meshBodyHeading??p.bodyHeading}:{})};
 });
 const observer=bodies.find(e=>e.id===state.observerId),target=reviewTarget(state,bodies);
 if(observer&&state.headingMode==='target-assumption')state.heading=bearing(observer,target);
 if(observer){observer.heading=state.heading;observer.viewHeading=state.heading;}
 const config={...DEFAULTS,hfov:state.hfov,vfov:state.vfov};
 return {bodies,observer,target,config,result:visibility(observer,target,bodies.filter(e=>!e.positionOnly),config)};
}
function syncTeams(){
 for(const e of state.entities){const p=frame.floorPositions.find(p=>p.id===e.id);if(p?.status?.startsWith('manual-floor')&&e.positionSource!=='manual')e.positionSource='manual-footpoint-proxy';const b=frame.boxes.find(b=>b.id===e.id);if(e.role!=='player'){e.team='unknown';e.teamSource='not-player';}else if(e.teamSource!=='manual'){e.team=b?.team||'unknown';e.teamSource=b?.teamSource||'unresolved';}}
 for(const team of ['home','away']){const label=$(team+'Legend');label.replaceChildren();const chip=document.createElement('i');chip.style.background=packet.uniforms[team];label.append(chip,document.createTextNode(`${team==='home'?'홈':'어웨이'} · ${data[team]}`));}
}
function previewObserver(m){const selected=m.bodies.find(e=>e.id===state.viewpointId&&!e.positionOnly)||m.observer;return selected?.id===m.observer?.id?m.observer:selected?{...selected,heading:selected.viewHeading}:null;}
function drawEye(m){const viewer=previewObserver(m);eye.update(m.bodies,m.target,viewer,m.result,{...m.config,showLabels:false},false);$('eye').classList.toggle('unavailable',!viewer);$('eyeTitle').textContent=`04 / ${viewer?roleNames[viewer.role]+' '+viewer.label:'인물'} 눈높이`;$('eyeNote').textContent=viewer?.id===m.observer?.id?'설정한 심판 시야 · PDF에 사용':'선수·인물 시점 미리보기 · PDF는 심판 시점으로 저장';}
function render(){
 if(!state)return;$('crewSummary').textContent='배치·방향을 수정한 뒤 비교 갱신 또는 현재 상태 저장을 누르세요.';const m=model();overview.update(m.bodies,m.target,m.observer,m.result,{...m.config,labelMode:$('overviewMode').value==='scene'?'referees':'selected'},true);drawEye(m);lastModel=m;drawSceneMap($('map'),m,$('editPerson').value,data);drawWidePreview();const selected=m.bodies.find(e=>e.id===$('editPerson').value);$('mapSelection').textContent=selected?`${roleNames[selected.role]} ${selected.label} · ${selected.id} 선택 — ${selected.positionOnly?'위치만 관측 · 시선과 자세 미확인':'인물 표식은 위치, 남색 손잡이는 방향 조정'} · ⌘Z로 되돌립니다.`:'';$('mapUndo').disabled=busy||!!mapDrag||!mapHistory.past.length;
 const placed=new Set(state.entities.map(e=>e.id)),missing=frame.boxes.filter(b=>!placed.has(b.id));
 const unplaced=$('unplaced');unplaced.replaceChildren(document.createTextNode(missing.length?`영상에 유지 ${missing.length}명 · 발 위치가 확인되지 않아 코트에 자동 배치하지 않았습니다. 하단 점수판이나 화면 밖에 가려진 발은 원본 또는 광각을 확인한 뒤 추정 위치를 직접 지정하세요. `:'검토 객체가 모두 공간에 배치되어 있습니다. '));
 for(const b of missing.filter(b=>['player','referee'].includes(b.roleHint))){
  const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=`${roleNames[b.roleHint]} ${b.id} 위치 지정`;
  button.onclick=()=>{document.querySelector('.partial-placement').open=true;selectPlacement(b.id);render();$('partialPerson').focus();message('선택한 인물이 맞는지 확인하고, 코트에서 직접 위치 찍기를 누르세요. 보이지 않는 발의 위치는 추정입니다.');};unplaced.append(button,document.createTextNode(' '));
 }
 const partialOptions=frame.boxes.filter(b=>['player','referee'].includes(b.roleHint));$('partialPerson').replaceChildren(new Option('배치할 인물을 선택하세요',''),...partialOptions.map(b=>new Option(`${roleNames[b.roleHint]} ${b.id}${placed.has(b.id)?' · 배치됨':b.spatialExcluded?' · 영상만 유지 중':' · 위치 미확정'}`,b.id)));$('partialPerson').value=placementId;placementControls();
 $('moveMap').setAttribute('aria-pressed',String(moveMode));
 $('reviewX').value=m.target.x.toFixed(2);$('reviewY').value=m.target.y.toFixed(2);
 $('pointStatus').textContent=pointMode?'코트에서 판독할 지점을 클릭하세요. Esc로 취소합니다.':state.reviewPoint?'★ 직접 지정한 지점 · 별표를 끌어 조정할 수 있습니다.':'★ 대상 인물의 위치 · 별표 찍기로 접촉·공·라인 등 원하는 지점을 지정하세요.';
 $('markPoint').setAttribute('aria-pressed',String(pointMode));$('map').style.cursor=mapDrag?'grabbing':pointMode||partialPick||moveMode||aimMode?'crosshair':'grab';
 $('angle').value=state.heading*180/Math.PI;$('angleValue').textContent=`${Math.round(state.heading*180/Math.PI)}°`;$('angle').disabled=state.headingMode==='target-assumption';$('fovValue').textContent=`${state.hfov}°`;
 $('evidence').textContent=`${frame.objectReview?'검토 객체':packet.selectedFrameProcessing?'선택 프레임 검출':'추적'} ${frame.boxes.length}명${frame.objectReview?` (수동 추가 ${frame.objectReview.manualAdded}명)`:''} 중 ${state.entities.length}명 배치 · 발 가림/잘림 등 ${missing.length}명은 영상에 유지 · 코트 직접 지정 ${state.entities.filter(e=>e.positionSource==='manual'&&!e.positionOnly).length}명 (추정) · 광각 보완 ${frame.sceneEvidence?.supplementalReferees?.length||0}명 · ${frame.objectReview?'역할 분류와 수동 보정 적용':packet.roleClassifier?'학습한 역할 분류기 적용':'공개 모델 역할 초안'} · 공 태그 ${frame.ballObjects?.length??0}개 (영상 위치) · 화면 밖 발 위치 추정 ${frame.boxes.filter(b=>b.footpointEvidence==='off-frame-estimate').length}명 · 카메라 정합/공 3D 위치 미확정 · 방향: ${state.headingMode==='target-assumption'?'대상 방향 가정':'수동 설정 가정'} · 같은 인체 메시로 가림 참고선 계산`;
 const uncertain=m.bodies.filter(e=>['uncertain','unresolved'].includes(e.bodyDirection.status)).length;$('bodySummary').textContent=`몸 방향 ${m.bodies.length-uncertain}명 추정·설정 / ${uncertain}명 확인 필요 · 실선 화살표: 추정·수동 / 점선: 임시 방향`;$('download').hidden=true;scheduleDraft();
}
async function open(id){
 draftTracking=false;clearTimeout(draftTimer);sceneDraft=null;draftNotice.hidden=true;clearDragPaint();mapHistory.clear();mapDrag=null;aimMode=false;pointMode=false;moveMode=false;partialPick=null;groundProposal=null;placementId='';$('acceptProposal').hidden=true;$('proposalStatus').textContent='';const current=++token,nextEvent=data.events.find(e=>e.id===id)||data.events[0];
 event=nextEvent;await flow.refresh();if(!flow.available)return;
 const nextPacket=await json(`/api/cases/${caseId}/events/${nextEvent.id}/broadcast-tracking`);if(current!==token)return;
 const index=nextEvent.selectedBroadcastFrame??Math.round((nextEvent.selectedFrame/nextEvent.wide.fps-nextEvent.sync.wideAtBroadcastZero)*nextPacket.fps);
 const nextFrame=nextPacket.frames.find(f=>f.frameIndex===index);
 mountManualCourt($('manualCourt'),{caseId,event:nextEvent,packet:nextPacket,frame:nextFrame,index,required:!nextFrame?.floorPositions?.length});
 if(!nextFrame?.floorPositions?.length)throw Error('코트 기준점을 직접 확인해 보정하세요. 기존 객체·관절 검수는 보존됩니다.');
 const saved=(await json(`/api/cases/${caseId}/events/${nextEvent.id}/reconstruction`)).saved;if(current!==token)return;
 currentCapture=saved;
 const pose=(await json(`/api/cases/${caseId}/events/${nextEvent.id}/pose`)).pose;if(current!==token)return;
 poseResult=pose?.job.state==='complete'?pose.job.result:null;
 basePoseResult=poseResult;
 poseVariantId=saved?.poseVariantId||null;
 if(poseVariantId){poseResult=(await json(`/api/cases/${caseId}/events/${nextEvent.id}/pose-variants/${poseVariantId}`)).pose;if(current!==token)return;}
 if(poseResult){const meshes=await json(poseResult.meshUrl);if(current!==token)return;appendHumanMeshes(meshes);}
 $('frameReview').href=`./workflow.html?case=${caseId}#${nextEvent.id}`;
 $('objectRoleLink').href=flowUrl('objects',caseId,nextEvent.id);
 $('poseReview').href=flowUrl('joints',caseId,nextEvent.id);$('poseReview').textContent='← 관절 단계';
 $('poseState').textContent=poseResult?.poseSource==='image-only-inferred'?'저장된 2D 관절 유지 · 3D는 기본 인체 자세':poseResult?`중계 화면 관절 ${poseResult.people.length}명 · 부분 자세 ${poseResult.people.filter(p=>p.accepted).length}명 · 개정 ${poseResult.revision}`:'MPFB 인체 · 기본 자세';
 event=nextEvent;packet=nextPacket;frame=nextFrame;
 $('courtState').textContent=frame.courtRevision?`코트 복구 · ${frame.court.provenance?.label||'기준점 보정'} · 원본 선 대조 완료 · 위치는 추정값`:frame.court?.requiresVisualReview?'코트 자동 복구 · 원본의 코트 선과 배치를 확인하세요.':'코트 모델 기반 배치 · 위치는 추정값';
 if(frame.court?.provenance?.method==='operator-frame-landmarks'&&Number.isFinite(frame.court.reprojectionRMSEPixels))$('courtState').textContent+=` · 기준점과 계산선 차이 RMS ${frame.court.reprojectionRMSEPixels.toFixed(1)}px, 최대 ${frame.court.reprojectionMaxPixels.toFixed(1)}px`;
 if(frame.court?.cameraCalibrationError)$('courtState').textContent+=' · 3D 카메라 추정 불안정: 영상 생성과 3D 자세 추정에 제한이 있습니다.';
 const entities=frame.floorPositions.map(p=>({id:p.id,role:p.role,x:p.xy[0],y:p.xy[1],bodyHeading:0,positionSource:'bbox-footpoint-proxy',roleSource:'model'}));
 const refs=entities.filter(e=>e.role==='referee'),players=entities.filter(e=>e.role==='player');
 const cx=players.reduce((s,e)=>s+e.x,0)/Math.max(1,players.length),cy=players.reduce((s,e)=>s+e.y,0)/Math.max(1,players.length);
 // Unknown body orientation stays a labelled placeholder; never point everybody
 // toward the player cluster or a basket as if it were an observation.
 const target=[...players].sort((a,b)=>Math.hypot(a.x-cx,a.y-cy)-Math.hypot(b.x-cx,b.y-cy))[0]||entities[1];
 state=reconcileScene(frame,saved?.state||packet.objectReview?.sceneDraft,{observerId:(refs[0]||entities[0]).id,targetId:target?.id,headingMode:'target-assumption',heading:0,hfov:100,vfov:70,targetHeight:1.1});
 // Keep the existing broadcast referee labels stable when a new wide-view
 // observation is appended. The actual IDs and stored coordinates are intact.
 state.entities=[...state.entities.filter(e=>!e.id.startsWith('wide-ref-')),...state.entities.filter(e=>e.id.startsWith('wide-ref-'))];
 if(poseResult&&!poseResult.people.every(p=>p.spatialEligible===false||state.entities.some(e=>e.id===p.id&&e.role===p.role&&(e.positionSource==='manual'||Math.hypot(p.x-e.x,p.y-e.y)<.001)))){poseResult=null;$('poseState').textContent='위치·역할 변경 · 자세 재추정 필요';}
 syncTeams();options();$('headingMode').value=state.headingMode;$('fov').value=state.hfov;$('targetHeight').value=state.targetHeight;
 $('events').replaceChildren(...data.events.map(e=>{const b=document.createElement('button');b.textContent=`판독 ${e.number} · ${e.quarter}Q ${e.gameClock}`;b.className=e.id===event.id?'active':'';b.disabled=busy;b.onclick=()=>{if(dirtyScene||wideReferencePanel?.dirty){message('현재 공간 상태와 광각 보완을 저장한 뒤 다른 장면으로 이동하세요.');return;}open(e.id).catch(e=>message(e.message));};return b;}));
 $('sceneMeta').textContent=`${data.title} · ${event.quarter}Q ${event.gameClock} · 중계사 기록: ${event.recordedDecision}`;
 $('frameLabel').textContent=`중계 F${index} / ${frame.t.toFixed(3)}초 ${event.wide?`· FPC F${event.selectedFrame} 근사 정합`:"· 중계뷰 단독"}`;
 const video=$('source');video.src=`/case-assets/${caseId}/broadcast/${event.broadcast.file}`;video.onloadedmetadata=()=>{if(current!==token)return;video.currentTime=(index+.1)/nextPacket.fps;video.pause();};video.load();
 dirtyScene=Boolean(saved?.targetSamplingStale||saved?.poseStale||saved?.uniformStale||saved?.rendererStale||saved?.objectStale||saved?.evidenceStale||saved?.courtStale);configureDraft();overview.setMode($('overviewMode').value);eye.setMode('eye');render();draftBaseline=JSON.stringify(state);draftTracking=true;await flow.refresh();history.replaceState(null,'',`?id=${caseId}#${event.id}`);
 await refreshCrew();
 wideReferencePanel?.dispose();widePositionMode.cancel();drawWidePreview();wideReferencePanel=mountWideReference($('wideReferencePanel'),{caseId,eventId:event.id,onDirty:()=>flow.update(),beforeChange:async()=>{if(dirtyScene)await save(true);},onChanged:async()=>{widePositionMode.cancel();drawWidePreview();dirtyScene=false;await open(event.id);dirtyScene=true;flow.update();message('광각 심판 보완을 반영했습니다. 현재 공간 이미지를 저장해 3심 화면과 리포트를 갱신하세요.');},onCancelPosition:()=>{widePositionMode.cancel();drawWidePreview();},onPickPosition:callback=>{cancelMapDrag();aimMode=false;pointMode=false;moveMode=false;partialPick=null;widePositionMode.begin(callback);render();message('새 광각 심판 위치 지정 중입니다. 코트를 누르면 주황색 임시 표식이 표시되며 다시 눌러 옮길 수 있습니다.');$('map').scrollIntoView({block:'center'});}});
 message(!refs.length?'심판 역할이 확정된 인물이 없습니다. 객체 단계에서 심판 역할을 확인하세요. 지정 전에는 심판 시야나 PDF를 저장할 수 없습니다.':saved?'저장된 공간 장면을 불러왔습니다.':'초기 재구성입니다. 심판·대상과 방향을 확인한 뒤 저장하세요.');
}
function setBusy(value){busy=value;$('refreshCrew').disabled=value;$('saveAll').hidden=!flow.current?.stages?.spatial?.complete;for(const id of ['save','saveAll','pdf'])$(id).disabled=value;document.querySelectorAll('#events button,.controls input,.controls select,.controls button,.map-tools input,.map-tools button,.map-tools select').forEach(b=>b.disabled=value);if(!value){$('angle').disabled=state?.headingMode==='target-assumption';editFields();$('mapUndo').disabled=!mapHistory.past.length;}placementControls();flow.update();}
async function save(allowWideDraft=false){
 if(draftPending)throw Error('이전 임시 수정을 복원하거나 삭제한 뒤 저장하세요.');
 if(!allowWideDraft&&wideReferencePanel?.dirty)throw Error('광각 보완의 ‘누락 심판 보완 저장’을 먼저 눌러 주세요.');
 if(!state.entities.some(e=>e.id===state.observerId&&e.role==='referee'))throw Error('심판 역할을 확인하고 심판 후보를 선택하세요.');
 const height=Number($('targetHeight').value);if(!Number.isFinite(height)||height<.1||height>2.5)throw Error('대상 높이는 0.1~2.5m로 입력하세요.');state.targetHeight=height;
 for(const e of state.entities){const d=directionFor(e,matchingPose(e));e.bodyHeading=d.heading;if(!poseVariantId)e.bodyDirectionSource=d.status==='manual'?'manual':d.status==='estimated'?'pose-estimated':'unresolved';}
 render();await document.fonts.ready;await nextPaint();const m=model();
 const crew=await refreshCrew();eye.update(m.bodies,m.target,m.observer,m.result,{...m.config,showLabels:false},false);const eyeImage=eye.capture(2);drawEye(m);
 const saved=await json(`/api/cases/${caseId}/events/${event.id}/reconstruction`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rendererVersion:'crew-visibility-v5-mannequin',mapLayout:'apron-v2',uniformRevision:packet.uniforms.revision,selectionRevision:data.revision,frameIndex:frame.frameIndex,courtRevision:frame.courtRevision||null,datasetId:packet.datasetId,inputSha256:packet.inputSha256,meshSha256,sceneEvidenceSha256:frame.sceneEvidence?.sha256||null,poseJobId:poseResult?.jobId||null,poseVariantId,state,crewAnalysis:crew.analysis,images:{map:$('map').toDataURL('image/jpeg',.96),overview:overview.capture(2),eye:eyeImage,...crew.images}})});
 clearTimeout(draftTimer);sceneDraft?.clear();currentCapture=saved;dirtyScene=false;configureDraft(false);flow.update();message(`판독 ${event.number}: 2D·3D·심판 눈높이 이미지 저장 완료 (${saved.captureId.slice(0,8)})`);return saved;
}
async function applySharedPose(keepExisting=false,forceRefresh=false){
 if(busy||dirtyScene||draftPending||wideReferencePanel?.dirty)throw Error('현재 수정 사항을 저장한 뒤 보정 자세를 적용하세요.');
 if(keepExisting&&poseVariantId&&!forceRefresh)return;
 if(!currentCapture?.captureId||!poseResult?.jobId)throw Error('현재 장면과 자세를 먼저 저장하세요.');
 setBusy(true);$('applySharedPose').disabled=true;message('2D 방향을 유지하며 자세를 보정하고 있습니다.');
 try{
  const result=await json(`/api/cases/${caseId}/events/${event.id}/pose-variants`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureId:currentCapture.captureId})});
  const meshes=await json(result.pose.meshUrl);appendHumanMeshes(meshes);poseResult=result.pose;poseVariantId=result.variantId;dirtyScene=true;render();await save();
  message(`보정 자세 ${result.selectedCount}명 적용 · 시야와 공간 장면을 다시 저장했습니다. 리포트 코멘트를 확인하세요.`);
 }finally{$('applySharedPose').disabled=false;setBusy(false);}
}
$('applySharedPose').onclick=async()=>{try{await applySharedPose();}catch(e){message(e.message||'보정 자세를 적용하지 못했습니다.');}};
$('clearSharedPose').onclick=async()=>{
 if(busy||!poseVariantId)return;
 try{if(basePoseResult?.meshUrl)appendHumanMeshes(await json(basePoseResult.meshUrl));poseVariantId=null;poseResult=basePoseResult;dirtyScene=true;render();flow.update();message('공유 보정을 해제했습니다. 배치·방향을 수정하고 저장한 뒤 다시 보정할 수 있습니다.');}
 catch(e){message(e.message||'기존 자세를 불러오지 못했습니다.');}
};
async function refreshCrew(){
 const m=model(),analysis=analyzeCrew(m,state,frame),observers=crewObservers(m,state),images={};
 drawCrewMap($('crewMap'),m,state,data,analysis);images.crewMap=$('crewMap').toDataURL('image/jpeg',.96);
 $('crewViews').replaceChildren();
 for(let i=0;i<3;i++){
  const observer=observers[i],row=analysis.rows[i];
  if(observer){eye.update(m.bodies,m.target,observer,visibility(observer,m.target,m.bodies.filter(e=>!e.positionOnly),m.config),{...m.config,showLabels:false},false);images['eye'+(i+1)]=eye.capture(2);}
  else{const c=document.createElement('canvas');c.width=1000;c.height=600;const x=c.getContext('2d');x.fillStyle='#f4f6f9';x.fillRect(0,0,1000,600);x.fillStyle='#626b7b';x.font='32px "KBL Jump",sans-serif';x.textAlign='center';x.fillText('심판 위치 미확인 · 시점 미생성',500,285);x.font='23px "KBL Jump",sans-serif';x.fillText('원본 또는 광각뷰에서 위치 확인이 필요합니다.',500,335);images['eye'+(i+1)]=c.toDataURL('image/jpeg',.95);}
  const card=document.createElement('article'),title=document.createElement('h3'),img=document.createElement('img'),note=document.createElement('p');
  const identity=frame.sceneEvidence?.identities?.[row?.id],official=data.referees?.find(r=>r.number===identity?.number);title.textContent=row?`${row.label} · ${official?'#'+official.number+' '+official.name:row.id}${row.id.startsWith('wide-ref-')?' · 광각 근사':''}`:`R${i+1} · 위치 미확인`;img.src=images['eye'+(i+1)];img.alt=title.textContent+'의 간접 시야';
  note.textContent=row?`가시 ${row.counts.visible}/9 · 가림 ${row.counts.blocked}/9 · 시야 밖 ${row.counts.outside}/9 · 대상 거리 ${row.distance.toFixed(1)}m · ${row.headingSource==='target-assumption'?'대상 방향 가정':'수동 방향 가정'}`:'이 시점을 추정해 채우지 않습니다. 세 심판 공동 사각지대는 미확정입니다.';
  card.append(title,img,note);$('crewViews').append(card);await nextPaint();
 }
 drawEye(m);
 const best=analysis.rows.filter(r=>analysis.leaders.includes(r.id)).map(r=>r.label).join(' · ');
 $('crewSummary').textContent=`시야 가정 가능 심판 ${analysis.rows.length}/3명${analysis.positionOnlyReferees?` · 위치만 관측 ${analysis.positionOnlyReferees}명은 시야 분석 제외`:''} · 모델상 가시 비율 최대 ${best||'미확인'}${analysis.leaders.length>1?' (동률)':''} · ${analysis.hfov}° 가정${analysis.conclusion==='unresolved'?' · 누락·정합·자세 검수 항목으로 공동 사각지대 결론 보류':' · 현재 배치와 방향에 한정한 비교'}`;
 return {analysis,images};
}
$('refreshCrew').onclick=async()=>{setBusy(true);try{await refreshCrew();}catch(e){message(e.message);}finally{setBusy(false);}};
$('save').onclick=async()=>{setBusy(true);try{await save();}catch(e){message(e.message);}finally{setBusy(false);}};
$('saveAll').onclick=async()=>{if(dirtyScene||wideReferencePanel?.dirty){message('현재 수정 내용을 저장한 뒤 일괄 갱신하세요.');return;}const previous=event.id;let done=0,changed=0;setBusy(true);try{for(const e of data.events){await open(e.id);if(!currentCapture||dirtyScene){await save();changed++;}done++;message(`공간 이미지 ${done}/${data.events.length} · ${changed}개 갱신`);$('saveAll').textContent=`공간 이미지 ${done}/${data.events.length}`;}await open(previous);message(`${data.events.length}개 장면 확인 · 변경된 ${changed}개 장면의 2D·3심 이미지를 갱신했습니다.`);}catch(e){message(e.message);}finally{$('saveAll').textContent='변경 장면 이미지 일괄 갱신';setBusy(false);}};
$('pdf').onclick=async()=>{setBusy(true);try{await save();message('공간 이미지를 포함한 PDF 생성 중…');const result=await json(`/api/cases/${caseId}/report`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:data.revision})});$('download').href=result.pdf;$('download').hidden=false;message(`${result.pageCount}페이지 PDF 생성 완료`);}catch(e){message(e.message);}finally{setBusy(false);}};
for(const [id,key] of [['observer','observerId'],['target','targetId'],['headingMode','headingMode']])$(id).onchange=()=>{rememberMap();dirtyScene=true;flow.update();state[key]=$(id).value;if(id==='target')delete state.reviewPoint;options();render();};
$('angle').oninput=()=>{dirtyScene=true;flow.update();state.heading=Number($('angle').value)*Math.PI/180;render();};$('fov').oninput=()=>{dirtyScene=true;flow.update();state.hfov=Number($('fov').value);render();};const updateTargetHeight=()=>{const v=Number($('targetHeight').value);if(v>=.1&&v<=2.5){dirtyScene=true;flow.update();state.targetHeight=v;render();}};$('targetHeight').oninput=updateTargetHeight;$('targetHeight').onchange=updateTargetHeight;
$('editPerson').onchange=()=>selectMap($('editPerson').value);
$('applyEdit').onclick=()=>{
 const e=state.entities.find(e=>e.id===$('editPerson').value),inputX=Number($('editX').value),inputY=Number($('editY').value),a=Number($('bodyAngle').value),role=e.role;
 if(![inputX,inputY,a].every(Number.isFinite)||!validCourtPosition({x:inputX,y:inputY})||a< -180||a>180)return message('좌표와 몸 방향 범위를 확인하세요.');
 // Display rounding is not a position edit: rotating a body must retain its pose.
 const x=inputX===Number(e.x.toFixed(2))?e.x:inputX,y=inputY===Number(e.y.toFixed(2))?e.y:inputY;
 const moved=Math.hypot(e.x-x,e.y-y)>.001,roleChanged=e.role!==role;
 rememberMap();
 if(moved)setCourtPosition(e,{x,y});
 dirtyScene=true;Object.assign(e,{role,x,y,bodyHeading:a*Math.PI/180,bodyDirectionSource:'manual',...(moved?{positionSource:'manual'}:{}),...(roleChanged?{roleSource:'manual'}:{})});
 const team=$('editTeam').value;if(role==='player'&&team!=='auto'){e.team=team;e.teamSource='manual';}else{e.teamSource='uniform-colour';}syncTeams();options();render();flow.update();message('보정을 2D·3D·가림 참고선에 적용했습니다. 이미지 저장 시 PDF에도 반영됩니다.');
};

$('flipBody').onclick=()=>{
 const e=state.entities.find(e=>e.id===$('editPerson').value);if(!e||busy)return;
 const d=resolveBodyDirection(e,matchingPose(e));e.bodyHeading=wrapAngle(d.heading+Math.PI);e.bodyDirectionSource='manual';
 dirtyScene=true;editFields();render();flow.update();message('몸 방향을 180° 뒤집었습니다. 현재 상태 저장 시 2D·3D·가림 계산과 리포트 이미지에 반영됩니다.');
};
$('autoBody').onclick=()=>{
 const e=state.entities.find(e=>e.id===$('editPerson').value),p=matchingPose(e);if(!p?.bodyDirection||busy)return;
 if(Number.isFinite(p.manualBodyHeading))return message('자세 편집에 수동 몸 방향이 저장되어 있습니다. 해당 수동 설정을 먼저 해제하세요.');
 e.bodyDirectionSource='pose-estimated';e.bodyHeading=p.bodyDirection.heading;dirtyScene=true;editFields();render();flow.update();message('관절 기반 몸 방향으로 돌아왔습니다. 추정 근거와 불확실성을 확인하세요.');
};

function rememberMap(){mapHistory.push(structuredClone(state));}
function selectMap(id){$('editPerson').value=id;const person=state.entities.find(e=>e.id===id);if(!person?.positionOnly){state.viewpointId=id;$('viewpoint').value=id;}selectPlacement(id);editFields();render();}
function mapPixel(e){const r=$('map').getBoundingClientRect();return [(e.clientX-r.left)/r.width*1280,(e.clientY-r.top)/r.height*800];}
function setReviewPoint(x,y){state.reviewPoint=reviewPoint(x,y);dirtyScene=true;render();flow.update();}
function placePoint(x,y){try{const point=reviewPoint(x,y);rememberMap();pointMode=false;aimMode=false;setReviewPoint(point.x,point.y);message('별표 지점을 2D·3D와 가림 계산에 적용했습니다. 현재 상태 저장 후 스텝 4에서 해설을 작성하세요.');}catch(e){message(e.message);}}
$('markPoint').onclick=()=>{pointMode=!pointMode;aimMode=false;moveMode=false;partialPick=null;render();};
$('applyPoint').onclick=()=>placePoint(Number($('reviewX').value),Number($('reviewY').value));
$('resetPoint').onclick=()=>{if(!state.reviewPoint)return;rememberMap();delete state.reviewPoint;pointMode=false;dirtyScene=true;render();flow.update();message('별표를 대상 인물의 위치로 되돌렸습니다.');};
function setMapDirection(p){const e=state.entities.find(e=>e.id===$('editPerson').value);if(!e||e.positionOnly)return;const to=mapCourt(p);if(Math.hypot(to.x-e.x,to.y-e.y)<.12)return;const a=Math.atan2(to.y-e.y,to.x-e.x);e.viewHeading=a;e.viewDirectionSource='manual';if($('turnBody').checked){e.bodyHeading=a;e.bodyDirectionSource='manual';}if(e.id===state.observerId){state.headingMode='manual-assumption';state.heading=a;$('headingMode').value=state.headingMode;}dirtyScene=true;editFields();render();flow.update();}
$('map').onpointerdown=e=>{
 if(widePositionMode.active&&!busy){if(e.button!==0)return;try{widePositionMode.choose(mapCourt(mapPixel(e)));drawWidePreview();e.preventDefault();}catch(err){message(err.message);}return;}
 if(busy||mapDrag||e.button!==0||!lastModel)return;const p=mapPixel(e),r=$('map').getBoundingClientRect(),selected=lastModel.bodies.find(b=>b.id===$('editPerson').value);
 if(partialPick){const id=partialPick;try{const q=mapCourt(p);if(!validCourtPosition(q))throw Error('코트 주변의 표시 영역 안에서 선택하세요.');rememberMap();placePerson(id,q);partialPick=null;render();}catch(err){message(err.message);}return;}
 if(pointMode){const point=mapCourt(p);placePoint(point.x,point.y);return;}
 if(aimMode){rememberMap();setMapDirection(p);aimMode=false;message('2D에서 지정한 방향을 3D 시점과 가림 계산에 적용했습니다.');return;}
 const targets=positionTargets(lastModel.bodies,p,r.width/1280,$('editPerson').value);
 // People are drawn over the star; their visible marker must remain draggable.
 if(targets){selectMap(targets.dragId);const body=state.entities.find(b=>b.id===targets.dragId),q=mapCourt(p);beginMapDrag(e,{kind:'position',id:body.id,clickId:targets.clickId,offset:{x:body.x-q.x,y:body.y-q.y}});return;}
 if(moveMode&&selected){try{const q=mapCourt(p);if(!validCourtPosition(q))throw Error('코트 주변의 표시 영역 안에서 선택하세요.');rememberMap();setPosition(selected.id,q);moveMode=false;render();}catch(err){message(err.message);}return;}
 if(selected&&!selected.positionOnly&&Math.hypot(...directionHandle(selected).map((v,i)=>(v-p[i])*r.width/1280))<14){beginMapDrag(e,{kind:'direction'});return;}
 if(state.reviewPoint&&Math.hypot(...mapPoint(lastModel.target).map((v,i)=>(v-p[i])*r.width/1280))<14){beginMapDrag(e,{kind:'point'});return;}
};
function beginMapDrag(e,details){mapDrag={...details,pointerId:e.pointerId,startClient:[e.clientX,e.clientY],moved:false,before:structuredClone(state),wasDirty:dirtyScene};$('map').setPointerCapture(e.pointerId);e.preventDefault();$('map').style.cursor='grabbing';placementControls();flow.update();}
function clearDragPaint(){if(dragPaint!==null)cancelAnimationFrame(dragPaint);dragPaint=null;dragPointer=null;}
function updateMapDrag(e){if(!mapDrag||!dragStarted(mapDrag,e))return;mapDrag.moved=true;if(mapDrag.kind==='position'){setPosition(mapDrag.id,positionDragPoint(mapDrag,mapPixel(e)));}else if(mapDrag.kind==='point'){const p=mapCourt(mapPixel(e));setReviewPoint(Math.max(-4,Math.min(32,p.x)),Math.max(-3,Math.min(19,p.y)));}else setMapDirection(mapPixel(e));}
$('map').onpointermove=e=>{if(!mapDrag||e.pointerId!==mapDrag.pointerId)return;dragPointer={clientX:e.clientX,clientY:e.clientY};if(dragPaint===null)dragPaint=requestAnimationFrame(()=>{dragPaint=null;const pointer=dragPointer;dragPointer=null;if(mapDrag&&pointer)updateMapDrag(pointer);});};
$('map').onpointerup=e=>{if(!mapDrag||e.pointerId!==mapDrag.pointerId)return;clearDragPaint();updateMapDrag(e);const old=mapDrag;mapDrag=null;if($('map').hasPointerCapture(e.pointerId))$('map').releasePointerCapture(e.pointerId);if(!old.moved){if(old.clickId)selectMap(old.clickId);render();flow.update();return;}if(JSON.stringify(old.before)!==JSON.stringify(state))mapHistory.push(old.before);render();flow.update();message(`${old.kind==='point'?'별표 위치':old.kind==='position'?'인물 위치':'방향'} 수정 완료 · 현재 상태 저장 시 리포트 이미지에도 반영됩니다.`);};
function cancelMapDrag(){clearDragPaint();if(!mapDrag)return;const old=mapDrag;mapDrag=null;state=old.before;dirtyScene=old.wasDirty;if($('map').hasPointerCapture(old.pointerId))$('map').releasePointerCapture(old.pointerId);options();render();flow.update();}
$('map').onpointercancel=cancelMapDrag;$('map').onlostpointercapture=()=>{if(mapDrag)cancelMapDrag();};
$('aimMap').onclick=()=>{aimMode=true;pointMode=false;moveMode=false;partialPick=null;render();message('2D 코트에서 선택 인물이 바라볼 방향을 클릭하세요.');};
function undoMap(){if(busy||mapDrag)return;const old=mapHistory.undo(state);if(!old)return;state=old;dirtyScene=true;pointMode=false;aimMode=false;options();render();flow.update();message('위치·별표·방향·팀 설정을 되돌렸습니다.');}
$('mapUndo').onclick=undoMap;
window.addEventListener('keydown',e=>{if(e.key==='Escape'){if(widePositionMode.active)wideReferencePanel?.cancelPosition();aimMode=false;pointMode=false;moveMode=false;partialPick=null;cancelMapDrag();render();}if(!e.defaultPrevented&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!e.target.isContentEditable&&!['INPUT','TEXTAREA'].includes(e.target.tagName)){e.preventDefault();undoMap();}});
function setPosition(id,p,evidence=null){const e=state.entities.find(e=>e.id===id);if(!e)return;setCourtPosition(e,{x:Math.round(p.x*100)/100,y:Math.round(p.y*100)/100},evidence);dirtyScene=true;editFields();render();flow.update();}
function placePerson(id,p,evidence=null){
 const b=frame.boxes.find(b=>b.id===id);if(!b)throw Error('현재 영상에서 공간 배치 가능한 인물을 선택하세요.');
 let e=state.entities.find(e=>e.id===id);if(!e&&b.roleHint==='referee'&&state.entities.filter(e=>e.role==='referee').length>=3)throw Error('이미 심판 3명이 배치되어 있습니다. 광각 보완과 같은 심판인지 확인하세요.');if(!e){e={id,role:b.roleHint,roleSource:b.roleSource||'model',bodyHeading:0,bodyDirectionSource:'unresolved'};state.entities.push(e);}
 setCourtPosition(e,p,evidence);if(b.spatialExcluded)e.spatialOverride=true;syncTeams();options();selectMap(id);dirtyScene=true;flow.update();
 message('위치를 2D·3D에 적용했습니다. 기존 검수 자세는 유지하고, 새로 배치한 부분 인물은 기본 자세를 사용합니다. 현재 상태 저장 시 가림 계산과 PDF에도 반영됩니다.');
}
$('moveMap').onclick=()=>{moveMode=!moveMode;aimMode=false;pointMode=false;partialPick=null;render();message(moveMode?'선택 인물의 새 위치를 코트에서 클릭하세요. 인물 표식은 버튼 없이도 바로 끌어 옮길 수 있습니다.':'인물 표식을 끌어 위치를 옮기세요.');};
$('applyPosition').onclick=()=>{try{const p={x:Number($('editX').value),y:Number($('editY').value)};if(!validCourtPosition(p))throw Error('좌표 범위를 확인하세요.');rememberMap();setPosition($('editPerson').value,p);message('코트 위치를 적용했습니다. 검수한 관절은 유지됩니다. 현재 상태 저장으로 리포트도 갱신하세요.');}catch(e){message(e.message);}};
$('placePartial').onclick=()=>{partialPick=$('partialPerson').value;if(!partialPick)return;aimMode=false;pointMode=false;moveMode=false;render();message('선택 인물의 발이 닿을 코트 위치를 클릭하세요. Esc로 취소합니다.');};
$('proposePosition').onclick=()=>{
 const id=$('partialPerson').value,p=poseResult?.people.find(p=>p.id===id),proposal=proposeGroundPosition(p,poseResult?.camera,Number($('assumedHeight').value));groundProposal=proposal?{id,...proposal}:null;$('acceptProposal').hidden=!proposal;
 $('proposalStatus').textContent=proposal?`${proposal.evidence.anchor==='shoulders'?'어깨':'골반'} 위치와 신장 ${proposal.evidence.assumedHeight.toFixed(2)}m 가정 → X ${proposal.x.toFixed(2)}, Y ${proposal.y.toFixed(2)}m. 신장 ±12cm 변화에 따른 위치 차이 약 ${proposal.evidence.heightSensitivityMetres.toFixed(2)}m. 숙임·점프·카메라 오차는 별도이므로 원본과 비교 후 적용하세요.`:'신뢰할 수 있는 어깨/골반 관절 또는 코트 카메라가 부족합니다. 코트에서 직접 위치를 지정하세요.';
};
$('partialPerson').onchange=()=>{const id=$('partialPerson').value;selectPlacement(id);if(state.entities.some(e=>e.id===id))selectMap(id);else{render();if(id)message('아직 배치되지 않은 인물입니다. 코트에서 직접 위치 찍기 또는 상체 관절로 위치 제안을 사용하세요.');}};
$('acceptProposal').onclick=()=>{if(!groundProposal)return;rememberMap();placePerson(groundProposal.id,groundProposal,groundProposal.evidence);groundProposal=null;$('acceptProposal').hidden=true;};
$('editTeam').onchange=()=>{const e=state.entities.find(e=>e.id===$('editPerson').value),team=$('editTeam').value;if(!e||e.role!=='player'||busy||team===(e.teamSource==='manual'?e.team||'unknown':'auto'))return;rememberMap();e.team=team;e.teamSource=team==='auto'?'uniform-colour':'manual';dirtyScene=true;syncTeams();editFields();render();flow.update();message(`${e.id} · ${e.team==='home'?'홈 '+data.home:e.team==='away'?'어웨이 '+data.away:'팀 미확정'} 적용. 현재 상태 저장 시 리포트 이미지에도 반영됩니다.`);};
$('overviewMode').onchange=()=>{overview.setMode($('overviewMode').value);render();};
$('viewpoint').onchange=()=>selectMap($('viewpoint').value);
$('refereeView').onclick=()=>selectMap(state.observerId);
window.addEventListener('beforeunload',e=>{if(dirtyScene||wideReferencePanel?.dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',preserveDraft);
try{
 data=await json(`/api/cases/${caseId}`);event=data.events.find(e=>e.id===location.hash.slice(1))||data.events[0];await flow.refresh();
 if(flow.available){
 await Promise.all([loadHumanMeshes(),loadCourtAsset()]);const meshBytes=await (await fetch('./assets/humans/mpfb-court-v1.json')).arrayBuffer();meshSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',meshBytes)),b=>b.toString(16).padStart(2,'0')).join('');
 overview=new CourtRenderer($('overview'),id=>{if(busy)return;selectMap(id);});eye=new CourtRenderer($('eye'),()=>{});
 await document.fonts.ready;await open(event.id);setBusy(false);autoMessage('kbl-auto-pose-ready',{eventId:event.id});
 }else{autoMessage('kbl-auto-pose-error',{error:'공간 검수의 앞 단계를 확인하세요.'});
 }
}catch(e){message(e.message);console.error(e);autoMessage('kbl-auto-pose-error',{error:e.message||'장면을 불러오지 못했습니다.'});}

$('targetPreset').onchange=()=>{const v=Number($('targetPreset').value);if(!Number.isFinite(v))return;$('targetHeight').value=v;$('targetHeight').dispatchEvent(new Event('change'));};
