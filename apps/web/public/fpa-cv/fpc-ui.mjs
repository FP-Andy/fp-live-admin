import {clone,parseTime} from './core.mjs';
import {eventId,fpaDocument,withDocument,matchableIdentity} from './fpa-events.mjs';

// The parent owns video/review storage and shared controls. FPC owns event editing.
export function fpaUI({getData,getReview,getWorking,commit,saveDraft,seek,time,pause,message,undo}) {
  const frame=document.getElementById('fpc-editor'),channel='fpa-cv/fpc-v1';
  let ready=false,session='',role='actor',lastContext='',pendingLinks=[],alignInitialTime=false;
  const send=payload=>{
    if(ready&&getData())frame.contentWindow.postMessage({channel,datasetId:getData().datasetId,session,...payload},location.origin);
  };
  const roster=()=>getReview()?.roster.map(p=>({...p,personId:p.id,team:p.group.startsWith('home')?'home':p.group.startsWith('away')?'away':'referee'}))||[];
  function reset() {
    if(!ready||!getData())return;
    session=crypto.randomUUID();pendingLinks=[];lastContext='';
    document.getElementById('fpa-global-controls').disabled=true;
    const review=getReview();
    alignInitialTime=!review.fpa?.editorDraft&&!review.events.length;
    send({type:'init',document:fpaDocument(review),draft:review.fpa?.editorDraft,time:time(),offsets:review.offsets,roster:roster()});
  }
  function refresh() {
    if(!ready||!getData())return;
    const context=JSON.stringify({roster:roster(),offsets:getReview().offsets});
    if(context!==lastContext){lastContext=context;send({type:'context',...JSON.parse(context)});}
  }
  window.addEventListener('message',event=>{
    if(event.source!==frame.contentWindow||event.origin!==location.origin||event.data?.channel!==channel)return;
    const msg=event.data;
    if(msg.type==='ready'){ready=true;reset();return;}
    if(msg.datasetId!==getData()?.datasetId||msg.session!==session)return;
    try {
      if(msg.type==='height'){frame.style.height=`${Math.max(400,Math.min(30000,Number(msg.height)||400))}px`;return;}
      if(msg.type==='mode'){role=msg.role;return;}
      if(msg.type==='controls'){
        document.getElementById('fpa-global-controls').disabled=!!msg.busy;
        for(const key of ['team','direction'])document.querySelectorAll(`[data-fpa-${key}]`).forEach(button=>button.setAttribute('aria-pressed',String(button.dataset[key==='team'?'fpaTeam':'fpaDirection']===msg[key])));
        document.getElementById('fpa-half').value=msg.half;
        document.getElementById('fpa-time-sync').checked=msg.timeSync;
        document.getElementById('fpa-clock-state').textContent=msg.clockLocked?'기록 수정 · 시간 고정':'';
        return;
      }
      if(msg.type==='pause'){pause();return;}
      if(msg.type==='seek'||msg.type==='step-time'){
        const seconds=msg.type==='step-time'?Number(msg.deltaSeconds):parseTime(msg.timeline);
        if(seconds===null||!Number.isFinite(seconds))throw Error('경기 시각을 확인하세요.');
        const target=msg.type==='step-time'?time()+seconds:seconds+(getReview().offsets[msg.half]||0),video=getData().video;
        if(target<video.clipStart||target>video.clipEnd)throw Error('이 로그 시각은 분석 영상 범위 밖입니다. 피리어드 시작 시각을 확인하세요.');
        pause();seek(target);send({type:'time',time:time()});return;
      }
      if(msg.type==='get-time'){send({type:'time',time:time(),apply:!!msg.apply,requestId:msg.requestId});return;}
      if(msg.type==='offsets'){commit({...getReview(),offsets:msg.offsets});return;}
      if(msg.type==='undo'){undo();return;}
      if(msg.type==='linked'){pendingLinks.push(msg);return;}
      if(msg.type==='state'){
        const review=getReview(),changed=JSON.stringify(fpaDocument(review))!==JSON.stringify(msg.document);
        let next=changed?withDocument(review,msg.document):clone(review);
        next.fpa={...next.fpa,editorDraft:msg.draft};
        let linked=false;
        for(const item of pendingLinks){
          const event=next.events.find(e=>eventId(e)===item.eventId),identity=item.identity;
          const field=item.role==='actor'?'Player':'Receiver';
          if(event&&event.row.Team===identity.team&&String(event.row[field])===identity.jersey){
            (next.links[event.index]??={})[item.role]={trackId:identity.trackId,time:identity.time,team:identity.team,jersey:identity.jersey,confirmed:true};linked=true;
          }
        }
        pendingLinks=[];
        if(changed||linked)commit(next);else saveDraft(next);
      }
    }catch(error){message(error.message||String(error),true);if(msg.type==='seek'||msg.type==='step-time')send({type:'clock-error',error:error.message||String(error)});}
  });
  const requestReady=()=>frame.contentWindow.postMessage({channel,type:'request-ready'},location.origin);
  frame.addEventListener('load',requestReady);
  requestReady();
  fetch('/api/fpa/workbench/capabilities').then(r=>{if(!r.ok)throw Error();return r.json();}).then(()=>{
    document.getElementById('fpa-service').textContent='FPA 연결됨';
  }).catch(()=>{document.getElementById('fpa-service').textContent='FPA 서버 연결 필요';});
  const setup=document.getElementById('tracking-setup'),setupButton=document.getElementById('toggle-setup');
  setupButton.addEventListener('click',()=>{setup.open=!setup.open;});
  setup.addEventListener('toggle',()=>setupButton.setAttribute('aria-expanded',String(setup.open)));
  for(const key of ['team','direction'])document.querySelectorAll(`[data-fpa-${key}]`).forEach(button=>button.addEventListener('click',()=>send({type:'controls',[key]:button.dataset[key==='team'?'fpaTeam':'fpaDirection']})));
  document.getElementById('fpa-half').addEventListener('change',event=>send({type:'controls',half:event.target.value}));
  document.getElementById('fpa-time-sync').addEventListener('change',event=>send({type:'controls',timeSync:event.target.checked}));
  let lastSync=-1;
  const video=document.getElementById('video');
  const syncTime=()=>{const now=time();if(now!==lastSync){lastSync=now;send({type:'time',time:now});}};
  for(const event of ['timeupdate','seeked','loadedmetadata'])video.addEventListener(event,syncTime);
  // Follow displayed video frames; seek/timeupdate also cover paused frame steps.
  if(video.requestVideoFrameCallback){const onFrame=()=>{syncTime();video.requestVideoFrameCallback(onFrame);};video.requestVideoFrameCallback(onFrame);}
  return {refresh,reset,reloadSelection:reset,matching:()=>!!role,
    alignNewTime:()=>{send({type:'time',time:time(),apply:alignInitialTime});alignInitialTime=false;},
    selectPlayer:(trackId,at)=>{
      if(!role||!ready)return;
      try {const identity=matchableIdentity(getWorking(),trackId,at);pause();send({type:'identity',identity:{...identity,trackId,time:at}});}
      catch(error){message(error.message,true);}
    },
  };
}
