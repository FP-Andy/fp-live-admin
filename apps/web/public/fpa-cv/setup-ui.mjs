import { GROUPS, clone, identityAt, personIdentity, label, clock, assign, boxesAt } from './core.mjs';
import { samplePatch, hex } from './colors.mjs';
import {classifyKit} from './keeper-context.mjs';
import { setupIssues } from './identity.mjs';
import { courtPosition } from './boundary.mjs';
import { uniformAt } from './integrity.mjs';

export function setupUI({getData,getReview,getWorking,getRecovery,commit,seek,time,selectTrack,message,video}) {
  const $=id=>document.getElementById(id);
  const node=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;};
  let picking=null,preferred=null,rosterNodes=new Map(),readyTime=null;
  const modeName=s=>s.mode==='checkpoint-tracklet'?'확인 장면을 포함한 연속 관측':s.mode==='checkpoint-retained'?'기존 연결 유지':s.mode==='checkpoint-agreement'?'앞뒤 확인 번호 일치':s.mode==='checkpoint-path'?'확인 장면에서 경로 연결':s.mode==='backward'?'이후 관측으로 앞 구간 복구':s.mode==='roster'?'명단의 유일한 미관측 선수':s.mode==='tracklet'?'연속 관측으로 장기 복귀 확인':s.mode==='continuity'?'중복 관측에서 신원 이어받음':s.mode==='touchline'?'경계 복귀':s.soleNearby?'마지막 위치 근처 단일 후보':'위치·색상 연결';
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  const personName=p=>`${GROUPS[p.group].label} ${p.jersey? p.group==='referee'?p.jersey:'No.'+p.jersey: '선수 '+p.id.split('-').at(-1)}${p.name?' · '+p.name:''}${p.position?' · '+p.position:''}`;
  function stopPick() {picking=null;$('pick-layer').hidden=true;$('pick-hint').hidden=true;$('crop').classList.remove('picking');}
  function choosePerson(personId) {
    preferred=personId;$('person').value=personId;
    const p=getReview()?.roster.find(p=>p.id===personId);
    $('jersey').disabled=personId==='ignore';$('jersey').value=p?.jersey||'';
    $('jersey').inputMode=p?.group==='referee'?'text':'numeric';
    $('jersey').focus();
  }
  function configuration() {
    const review=getReview();if(!review)return;
    const constraint=getData()?.detector.teamConstraint;
    const samePalette=constraint?.uniforms&&Object.keys(GROUPS).every(g=>JSON.stringify(constraint.uniforms[g])===JSON.stringify(review.uniforms[g]));
    $('tracking-colors').textContent=constraint?.enabled
      ? samePalette?'이 색상으로 BB 추적과 선수 재연결에 팀 제약을 적용했습니다.':'색상이 변경되었습니다. 검수 반영 시 선수 재연결에 적용되며, BB 추적에 반영하려면 작업 백업 후 재추적하세요.'
      :'색상은 선수 재연결에 적용됩니다. BB 추적에도 적용하려면 작업 백업 후 이 색상으로 재추적하세요.';
    readyTime=null;
    if(!review.setup&&review.roster.every(p=>p.jersey)&&Object.values(review.uniforms).every(s=>s.length)) {
      readyTime=getData().frames.find(f=>!setupIssues(review,getData(),Math.max(f.t,getData().video.clipStart)).length)?.t??null;
      if(readyTime!==null)readyTime=Math.max(readyTime,getData().video.clipStart);
    }
    const previous=$('person').value;
    $('person').replaceChildren();
    for(const p of review.roster){const o=node('option',personName(p));o.value=p.id;$('person').append(o);}
    const ignored=node('option','선수 아님 / 제외');ignored.value='ignore';$('person').append(ignored);
    if([...$('person').options].some(o=>o.value===previous))$('person').value=previous;
    const current=review.roster.find(p=>p.id===$('person').value);
    $('jersey').value=current?.jersey||'';$('jersey').disabled=$('person').value==='ignore';
    $('jersey').inputMode=current?.group==='referee'?'text':'numeric';
    $('auto-reconnect').checked=review.autoReconnect;
    const groups=$('uniforms');groups.replaceChildren();
    const board=$('roster-board');board.replaceChildren();rosterNodes=new Map();
    for(const [group,info] of Object.entries(GROUPS)) {
      const card=node('div','',`uniform-card group-${group}`),heading=node('div','', 'uniform-heading');
      heading.append(node('b',info.label),node('small',`${info.count}명`));card.append(heading);
      const samples=node('div','','swatches');
      review.uniforms[group].forEach((rgb,i)=>{
        const swatch=node('button','×');swatch.style.background=hex(rgb);swatch.title=`${info.label} 색상 ${hex(rgb)} 삭제`;swatch.setAttribute('aria-label',swatch.title);
        swatch.onclick=()=>{const next=clone(getReview());next.uniforms[group].splice(i,1);commit(next);};samples.append(swatch);
      });
      if(!review.uniforms[group].length)samples.append(node('small','색상 미설정'));
      card.append(samples);
      const pick=node('button',`⌾ ${info.label} 스포이드`,'pick-button');
      pick.onclick=()=>{if(video.readyState<2)return message('영상을 먼저 열어 주세요.',true);video.pause();picking=group;$('pick-layer').hidden=false;$('pick-hint').hidden=false;$('crop').classList.add('picking');$('pick-hint').textContent=`${info.label}: 영상 또는 선수 확대 화면의 유니폼 클릭 · Esc 취소`;$('stage').scrollIntoView({block:'center',behavior:'instant'});};
      card.append(pick);groups.append(card);
      const list=node('div','','roster-group');
      for(const p of review.roster.filter(p=>p.group===group)) {
        const b=node('button','','roster-person'),name=node('b',personName(p)),state=node('small','초기 미매칭');b.append(name,state);b.title='이 슬롯 선택 후 영상 BB와 번호를 지정하세요.';
        b.onclick=()=>{choosePerson(p.id);message(`${personName(p)} 슬롯 선택 · 영상에서 해당 사람의 BB를 클릭하세요.`);};list.append(b);rosterNodes.set(p.id,{b,state});
      }
      board.append(list);
    }
    renderQueue();
  }
  $('person').onchange=()=>choosePerson($('person').value);
  function savePixel(x,y) {
    if(x<0||y<0||x>=video.videoWidth||y>=video.videoHeight)throw Error('영상 내부의 유니폼을 클릭하세요.');
    canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);
    const rgb=samplePatch(ctx,x,y,canvas.width,canvas.height),group=picking,next=clone(getReview());
    next.uniforms[group]=[...next.uniforms[group],rgb].slice(-8);stopPick();commit(next);message(`${GROUPS[group].label} ${hex(rgb)} 저장 · 다른 밝기의 부분을 추가로 찍을 수 있습니다.`);
  }
  $('pick-layer').onclick=event=>{
    try {
      if(!picking||video.readyState<2)return;
      const rect=$('stage').getBoundingClientRect(),scale=Math.min(rect.width/video.videoWidth,rect.height/video.videoHeight);
      const x=(event.clientX-rect.left-(rect.width-video.videoWidth*scale)/2)/scale;
      const y=(event.clientY-rect.top-(rect.height-video.videoHeight*scale)/2)/scale;
      savePixel(x,y);
    }catch(error){message(error.message,true);}
  };
  $('crop').onclick=event=>{
    if(!picking||!$('crop').dataset.source)return;
    try {
      const crop=$('crop'),rect=crop.getBoundingClientRect(),ratio=Math.min(rect.width/crop.width,rect.height/crop.height);
      const cx=(event.clientX-rect.left-(rect.width-crop.width*ratio)/2)/ratio,cy=(event.clientY-rect.top-(rect.height-crop.height*ratio)/2)/ratio;
      const s=JSON.parse(crop.dataset.source),x=s.x+(cx-s.dx)/s.scale,y=s.y+(cy-s.dy)/s.scale;
      if(x<s.x||x>s.x+s.w||y<s.y||y>s.y+s.h)throw Error('확대 화면의 사람 내부를 클릭하세요.');
      savePixel(x,y);
    }catch(error){message(error.message,true);}
  };
  document.addEventListener('keydown',e=>{if(e.key==='Escape')stopPick();});
  $('auto-reconnect').onchange=()=>commit({...getReview(),autoReconnect:$('auto-reconnect').checked});
  $('anchor-frame').onclick=()=>{video.pause();seek(getReview()?.setup?.time??getData()?.video.clipStart??0);};
  $('finish-setup').onclick=()=>{
    video.pause();const review=getReview(),at=readyTime??time(),issues=setupIssues(review,getData(),at);
    if(issues.length)return message(issues.join(' · '),true);
    if(review.checkpoints?.some(c=>c.time<=at+1/(getData().detector.sampleFps*2)))return message('저장한 확인 장면보다 앞선 초기 장면을 선택하세요. 중간 장면은 장면 확인에서 추가할 수 있습니다.',true);
    commit({...review,setup:{time:at}});message(`${clock(at)}의 초기 13명을 확정했습니다. 검수 반영을 누르면 명단 재연결을 시작합니다.`);
  };
  function selected(id,identity,box) {
    let choice=identity?.personId||(identity?.team==='ignore'?'ignore':preferred);
    if(!choice) {
      const group=classifyKit(box,time(),getReview().uniforms,getRecovery()?.keeperContext).group;
      choice=getReview().roster.find(p=>(!group||p.group===group)&&!p.jersey)?.id||getReview().roster.find(p=>!group||p.group===group)?.id;
    }
    choosePerson(choice||'home-1');
  }
  function submitted() {
    const personId=$('person').value,next=clone(getReview());
    if(personId==='ignore')return {review:next,identity:{team:'ignore',jersey:''}};
    const p=next.roster.find(p=>p.id===personId);if(!p)throw Error('명단 선수를 선택하세요.');
    p.jersey=$('jersey').value.trim();
    if(p.group!=='referee'&& !/^\d{1,3}$/.test(p.jersey))throw Error('등번호를 0–999로 입력하세요.');
    if(p.group==='referee'&&!/^[\w가-힣-]{1,12}$/.test(p.jersey))throw Error('심판 표기를 1–12자로 입력하세요.');
    const team=GROUPS[p.group].team;
    if(team!=='referee'&&next.roster.some(other=>other.id!==p.id&&GROUPS[other.group].team===team&&other.jersey&&Number(other.jersey)===Number(p.jersey)))throw Error('같은 팀에 이미 있는 번호입니다. 해당 명단 슬롯을 선택하세요.');
    preferred=null;return {review:next,identity:{...personIdentity(next,p.id),source:'manual',locked:!!next.setup}};
  }
  function confirm(segment) {
    const next=assign(getReview(),getData(),segment.trackId,segment.from,segment.to,{personId:segment.personId,source:'manual',locked:true});commit(next);message('재연결을 작업자 확인으로 확정했습니다.');
  }
  function reject(segment) {commit({...getReview(),rejections:[...getReview().rejections,{trackId:segment.trackId,personId:segment.personId,from:segment.from,to:segment.to}]});message('이 구간의 재연결을 거절했습니다. 다른 후보를 검수해 주세요.');}
  function viewRecovery(trackId,at) {
    seek(at);selectTrack(trackId);
    $('player-inspector').open=true;
    $('stage').scrollIntoView({block:'center',behavior:'smooth'});
  }
  let queueLimit=50;
  $('reconnect-panel').addEventListener('toggle',()=>{queueLimit=50;renderQueue();});
  function renderQueue() {
    const recovery=getRecovery(),holder=$('reconnect-list');holder.replaceChildren();
    if(!recovery)return;
    if(recovery.status&&recovery.status!=='complete'&&!recovery.hasResult){
      $('reconnect-count').textContent=recovery.status==='pending'?'선수 연결 계산 중':'선수 연결 계산 대기';
      holder.append(node('p','위 진행 상태에서 계산 완료 여부를 확인하세요. 수동 선수 지정과 FPA 입력은 가능합니다.','muted'));return;
    }
    $('reconnect-count').textContent=`자동 ${recovery.segments.length}구간 · 보류 ${recovery.suggestions.length}트랙`;
    if(!$('reconnect-panel').open)return;
    const total=recovery.segments.length+recovery.suggestions.length+recovery.warnings.length;
    let remaining=queueLimit;
    for(const s of recovery.segments) {
      if(getReview().rejections.some(r=>r.trackId===s.trackId&&r.personId===s.personId&&r.from<s.to&&r.to>s.from)||getReview().segments.some(r=>r.locked&&r.trackId===s.trackId&&r.from<=s.from&&r.to>=s.to))continue;
      if(remaining--<=0)break;
      const row=node('div','','reconnect-row'),go=node('button',`영상 확인 · #${s.previousTrack} → #${s.trackId} · ${label(personIdentity(getReview(),s.personId),s.trackId)}`);
      // Browsers quantize media time. Seek inside the half-open interval,
      // at an observed frame, so a rounded-down boundary is not unassigned.
      go.onclick=()=>viewRecovery(s.trackId,Math.min(s.to-.0001,Math.max(s.from,s.time)+.0001));
      const desc=node('small',`${clock(s.from)}–${clock(s.to)} · ${modeName(s)} · ${Math.round(s.score*100)}점 · 공백 ${s.gap.toFixed(2)}초 · 색상 ${GROUPS[s.uniform].label}`);
      const accept=node('button','연결 확정'),no=node('button','거절');accept.onclick=()=>confirm(s);no.onclick=()=>reject(s);row.append(go,desc,accept,no);holder.append(row);
    }
    for(const s of recovery.suggestions) {
      if(remaining--<=0)break;
      const row=node('div','','reconnect-row pending'),go=node('button',`영상 확인 · #${s.trackId}`);go.onclick=()=>viewRecovery(s.trackId,s.time);
      row.append(go,node('small',s.reason));
      for(const candidate of s.options) {
        const b=node('button',`${label(personIdentity(getReview(),candidate.personId),s.trackId)} · ${Math.round(candidate.score*100)}점`);
        b.onclick=()=>{viewRecovery(s.trackId,candidate.time);choosePerson(candidate.personId);$('scope').value='after';message('후보를 선택했습니다. 영상을 확인한 뒤 선수 번호 적용을 눌러 주세요.');};row.append(b);
      }
      holder.append(row);
    }
    for(const warning of recovery.warnings){if(remaining--<=0)break;const b=node('button',`#${warning.trackId} · ${clock(warning.time)} · ${warning.reason}`,'reconnect-warning');b.onclick=()=>viewRecovery(warning.trackId,warning.time);holder.append(b);}
    if(total>queueLimit){const more=node('button',`50개 더 보기 · ${queueLimit} / ${total}`);more.onclick=()=>{queueLimit+=50;renderQueue();};holder.append(more);}
    if(!holder.children.length)holder.append(node('p',getReview()?.setup?'현재 설정에서 자동 재연결된 구간이 없습니다.':'색상 감시와 중복 처리는 동작 중입니다. 13명 확정 후 가림·이탈 재연결을 시작합니다.','muted'));
  }
  function live(boxes,selectedId) {
    const review=getReview(),working=getWorking();if(!review)return;
    const at=time(),visible=new Map();
    for(const b of boxes){const i=identityAt(working,b.id,at);if(i?.personId)visible.set(i.personId,i);}
    for(const [id,{b,state}] of rosterNodes) {
      const identity=visible.get(id);b.classList.toggle('present',!!identity);b.classList.toggle('missing',!!review.setup&&!identity);b.classList.toggle('suggested',identity?.source==='auto');b.classList.toggle('chosen',$('person').value===id);
      const waiting=getRecovery()?.waiting?.some(w=>w.personId===id&&w.from<=at&&at<w.to);
      state.textContent=identity?(identity.source==='auto'?'자동 재연결 · 검수':'추적 중'):waiting?'경계 재등장 대기':review.setup?'미검출 / 미연결':'초기 미매칭';
    }
    const issues=setupIssues(review,getData(),at),recovery=getRecovery();
    $('setup-count').textContent=`현재 ${visible.size} / 13`;$('finish-setup').disabled=issues.length>0&&readyTime===null;
    $('finish-setup').textContent=review.setup?'이 프레임으로 초기 설정 갱신':readyTime!==null?`${clock(readyTime)}의 13명 확정`:'초기 13명 확정';
    const legacy=review.segments.some(s=>!s.personId&&s.team!=='ignore');
    const colorCount=Object.values(review.uniforms).filter(s=>s.length).length;
    $('setup-help').textContent=`색상 감시 ${recovery.hasAppearance&&colorCount?'켜짐':'대기'} (${colorCount}/5그룹) · ${review.autoReconnect?'신원 이어받기 켜짐':'자동 번호 연결 꺼짐'} · `+(review.setup?`초기 ${clock(review.setup.time)} · ${recovery.issues.length?'설정 재확인: '+recovery.issues.join(' · '):'가림·이탈 재연결 켜짐'}`:readyTime!==null?`명단 입력 완료 · 위 버튼으로 ${clock(readyTime)}의 13명을 확정하면 가림·이탈도 재연결합니다.`:`가림·이탈 재연결 대기 · ${issues.slice(0,3).join(' · ')}`)+(legacy?' · 이전 팀 지정도 색상 충돌 감시 중':'');
    if(recovery.status&&recovery.status!=='complete')$('setup-help').textContent=recovery.status==='pending'?'제출한 검수 계산 중 · 새 수정은 다음 반영을 위해 저장합니다.':'수정 저장됨 · 위의 검수 반영으로 한 번에 재연결하세요.';
    const ignored=boxes.filter(b=>identityAt(working,b.id,at)?.team==='ignore').length;
    const data=getData(),outside=boxes.filter(b=>!identityAt(working,b.id,at)&&courtPosition(b.box,data.detector.roi,data.video.width/data.video.height)?.inside===false).length;
    const detected=boxes.length-ignored-outside;
    $('identity-status').textContent=`예상 13명 · 코트/명단 검출 ${detected}개 · 경계 후보 ${outside}개 · 식별 ${visible.size}명 · 미연결 ${13-visible.size}명${detected!==13?' · 인원 불일치 확인':''}`;
    $('identity-status').classList.toggle('mismatch',detected!==13);
    const detail=$('match-details'),identity=selectedId===null?null:identityAt(working,selectedId,at);detail.replaceChildren();detail.hidden=identity?.source!=='auto';
    const evidence=$('uniform-evidence'),box=boxesAt(getData(),at).find(b=>b.id===selectedId),raw=classifyKit(box,at,review.uniforms,recovery.keeperContext),stable=uniformAt(recovery.timeline,selectedId,at),detectedGroup=stable?.group||raw.group;
    evidence.hidden=selectedId===null;
    const held=recovery.masks.some(m=>m.trackId===selectedId&&m.from<=at&&at<m.to),duplicate=recovery.duplicates.find(d=>d.trackId===selectedId&&d.from<=at&&at<d.to);
    evidence.textContent=`유니폼: ${detectedGroup?GROUPS[detectedGroup].label:'판정 보류'}${raw.role&&raw.role!=='field'&&raw.role!=='keeper-unresolved'?' · 키퍼 위치·이동 이력':stable&&!raw.group?' · 최근 색상 유지':''}${held?' · 기존 팀 지정 충돌':''}${duplicate?` · #${duplicate.canonicalTrackId}와 중복 관측`:''}`;
    if(identity?.source==='auto') {
      detail.append(node('b',`자동 재연결 · ${Math.round(identity.score*100)}점`),node('p',`${modeName(identity)} · ${identity.mode==='backward'?'이후':'이전'} #${identity.previousTrack} · ${identity.gap.toFixed(2)}초 공백 · ${GROUPS[identity.group].label}`));
      const accept=node('button','이 연결 확정'),no=node('button','이 연결 거절');accept.onclick=()=>confirm(identity);no.onclick=()=>reject(identity);detail.append(accept,no);
    }
  }
  return {configuration,live,selected,submitted,stopPick};
}
