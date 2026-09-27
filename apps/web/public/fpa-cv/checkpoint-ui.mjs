import {GROUPS,checkpointFrame,saveCheckpoint,identityAt,personIdentity,clock} from './core.mjs';

export function checkpointUI({getData,getReview,getWorking,getRecovery,commit,seek,time,video,message,apply,onChange,isPending}){
  const $=id=>document.getElementById(id),node=(tag,value,cls)=>{const n=document.createElement(tag);n.textContent=value;if(cls)n.className=cls;return n;};
  let datasetId=null,draft=null,selected=null,dirty=false;
  const name=p=>`${GROUPS[p.group].label} ${p.jersey}${p.name?' '+p.name:''}${p.position?' · '+p.position:''}`;
  const guard=fn=>()=>{try{fn();}catch(e){message(e.message,true);}};
  function begin(at){
    const data=getData();if(!data)return;
    if(video.readyState<2){message('영상이 준비된 뒤 장면을 확인할 수 있습니다.',true);return false;}
    const {frame}=checkpointFrame(data,at);
    if(dirty&&draft?.time!==frame.t){message('현재 장면을 저장하거나 취소한 뒤 이동하세요.',true);return false;}
    if(dirty&&draft?.time===frame.t){video.pause();seek(frame.t+.00001);return true;}
    video.pause();seek(frame.t+.00001);
    const saved=getReview().checkpoints?.find(c=>Math.abs(c.time-frame.t)<1e-6);
    draft={time:frame.t,assignments:(saved?.assignments||[]).map(a=>({...a}))};selected=null;dirty=false;render();onChange();return true;
  }
  function bind(personId){
    if(!draft||selected===null)return message('영상에서 해당 선수의 BB를 먼저 선택하세요.',true);
    draft.assignments=draft.assignments.filter(a=>a.trackId!==selected&&a.personId!==personId);
    draft.assignments.push({trackId:selected,personId});dirty=true;render();onChange();
  }
  function suggestions(){
    if(!draft)return [];
    const {frame}=checkpointFrame(getData(),draft.time),items=frame.boxes.map(b=>({trackId:b.id,personId:identityAt(getWorking(),b.id,frame.t)?.personId})).filter(a=>a.personId);
    return items.filter(a=>items.filter(b=>b.personId===a.personId).length===1);
  }
  function render(){
    const data=getData(),review=getReview();if(!data||!review)return;
    if(datasetId!==data.datasetId){datasetId=data.datasetId;draft=null;selected=null;dirty=false;}
    const saved=review.checkpoints||[],budget=review.checkpointBudget||5,recovery=getRecovery();
    $('checkpoint-budget').value=String(budget);
    $('checkpoint-count').textContent=`누적 ${saved.length}장면`;
    $('checkpoint-apply').disabled=!isPending()||recovery?.status==='pending';
    $('checkpoint-note').textContent=recovery?.status==='pending'?'연결 계산 중 · 추가 장면은 저장 후 한 번에 반영할 수 있습니다.':isPending()?'저장된 확인을 반영하면 앞뒤 번호 연결을 다시 계산합니다.':`${(review.batch?.round||0)+1}차 결과 기준 · 개선 우선순위순입니다. 확실한 번호를 저장하고 반영하면 남은 구간에서 다시 추천합니다.`;
    const list=$('checkpoint-recommendations');list.replaceChildren();
    const plan=recovery?.checkpointPlan;
    const recommendations=recovery?.status==='complete'&&!isPending()?(plan?.recommendations||[]).slice(0,budget):[];
    for(const [i,c] of recommendations.entries()){
      const b=node('button','','checkpoint-scene');b.append(node('b',`우선 ${i+1} · ${clock(c.time)}`),node('small',c.reason));b.title='미연결 시간은 회복 보장량이 아닙니다. 선수 번호는 직접 확인하세요.';b.onclick=guard(()=>begin(c.time));list.append(b);
    }
    if(!recommendations.length)list.append(node('p',recovery?.status==='pending'?'계산이 끝나면 확인할 장면을 추천합니다.':isPending()?'저장한 검수를 반영하면 다음 장면을 추천합니다.':recovery?.status==='complete'?'추천할 장면이 없습니다. 현재 장면을 직접 확인할 수 있습니다.':'연결 계산을 완료하면 확인할 장면을 추천합니다.','muted'));
    const done=$('checkpoint-saved');done.replaceChildren();
    for(const c of saved){
      const row=node('div','','checkpoint-saved-row'),go=node('button',`${clock(c.time)} · ${c.assignments.length}명 확인`),remove=node('button','삭제','subtle');
      go.onclick=guard(()=>begin(c.time));remove.setAttribute('aria-label',`${clock(c.time)} 확인 장면 삭제`);
      remove.onclick=()=>{if(draft?.time===c.time){draft=null;dirty=false;selected=null;}commit({...getReview(),checkpoints:getReview().checkpoints.filter(s=>s.time!==c.time)},false);render();onChange();};
      row.append(go,remove);done.append(row);
    }
    $('checkpoint-editor').hidden=!draft;
    if(!draft)return;
    $('checkpoint-time').textContent=clock(draft.time);
    $('checkpoint-selection').textContent=selected===null?'영상 BB 선택 → 선수 번호 선택':`TRACK #${selected} → 번호 선택`;
    const roster=$('checkpoint-roster');roster.replaceChildren();const hints=suggestions();
    for(const group of ['home_gk','home','away_gk','away','referee']){
      const info=GROUPS[group],section=node('div','',`checkpoint-group checkpoint-${group}`);section.append(node('h3',info.label));
      for(const p of review.roster.filter(p=>p.group===group)){
        const assigned=draft.assignments.find(a=>a.personId===p.id),hint=hints.find(a=>a.personId===p.id);
        const b=node('button','','checkpoint-person');b.append(node('strong',p.group==='referee'?p.jersey:`No.${p.jersey}`),node('small',assigned?`✓ #${assigned.trackId}`:hint?`예상 #${hint.trackId}`:'미확인'));
        if(p.name||p.position)b.append(node('small',[p.name,p.position].filter(Boolean).join(' · ')));b.classList.toggle('confirmed',!!assigned);b.classList.toggle('selected',!!assigned&&assigned.trackId===selected);b.title=`${name(p)} 연결`;b.setAttribute('aria-label',`${name(p)} · ${assigned?'확인 #'+assigned.trackId:hint?'예상 #'+hint.trackId:'미확인'}`);b.onclick=()=>bind(p.id);section.append(b);
      }
      roster.append(section);
    }
    $('checkpoint-save').textContent=`${draft.assignments.length}명 확인 저장`;$('checkpoint-save').disabled=!draft.assignments.length;
    $('checkpoint-confirm-visible').disabled=!hints.length;
    $('checkpoint-unlink').disabled=selected===null||!draft.assignments.some(a=>a.trackId===selected);
    paint();
  }
  function paint(){
    const canvas=$('checkpoint-crop'),ctx=canvas.getContext('2d');
    if(draft&&Math.abs(time()-draft.time)>1/getData().detector.sampleFps)return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if(!draft||selected===null||video.readyState<2)return;
    const b=checkpointFrame(getData(),draft.time).frame.boxes.find(b=>b.id===selected);if(!b)return;
    const [x,y,x2,y2]=b.box,w=(x2-x)*video.videoWidth,h=(y2-y)*video.videoHeight,scale=Math.min(canvas.width/w,canvas.height/h);
    ctx.drawImage(video,x*video.videoWidth,y*video.videoHeight,w,h,(canvas.width-w*scale)/2,(canvas.height-h*scale)/2,w*scale,h*scale);
  }
  $('checkpoint-current').onclick=guard(()=>begin(time()));
  $('checkpoint-budget').onchange=()=>{commit({...getReview(),checkpointBudget:Number($('checkpoint-budget').value)},false);render();};
  $('checkpoint-confirm-visible').onclick=()=>{
    for(const a of suggestions())if(!draft.assignments.some(b=>b.personId===a.personId||b.trackId===a.trackId))draft.assignments.push(a);
    dirty=true;render();onChange();
  };
  $('checkpoint-unlink').onclick=()=>{draft.assignments=draft.assignments.filter(a=>a.trackId!==selected);dirty=true;render();onChange();};
  $('checkpoint-cancel').onclick=()=>{draft=null;selected=null;dirty=false;render();onChange();};
  $('checkpoint-save').onclick=guard(()=>{
    if(!draft)return;
    const next=saveCheckpoint(getReview(),getData(),draft.time,draft.assignments),savedTime=draft.time;
    draft=null;selected=null;dirty=false;commit(next,false);message(`${clock(savedTime)} 확인 저장 · 장면을 모아 반영하세요.`);render();onChange();
  });
  $('checkpoint-apply').onclick=()=>{if(dirty)return message('현재 장면을 먼저 저장하세요.',true);message('');apply();};
  return {render,paint,hasUnsaved:()=>dirty,selectTrack(id){
    const current=checkpointFrame(getData(),time()).frame;
    if(!draft||Math.abs(draft.time-current.t)>1e-6){if(!begin(time()))return;}
    selected=id;render();
  },identity(id,at){
    if(!draft||Math.abs(at-draft.time)>1/getData().detector.sampleFps)return null;
    const a=draft.assignments.find(a=>a.trackId===id);return a?{...personIdentity(getReview(),a.personId),checkpoint:true}:null;
  }};
}
