// Content-free, approximate activity timing. It never controls the delivery clock.
import {currentTaskState} from './task-feedback.mjs';
import {trackedAction} from './button-usage.mjs';
const running=new Set(['running','queued','preparing','submitted','receiving']);
export function attentionState({paused,visible,focused,lastInput,now}){
 if(paused)return 'paused';if(!visible||!focused)return 'hidden';return now-lastInput<60000?'active':'idle';
}
export function mountWorkSession({host,caseId,stage,eventId}){
 const sessionId=crypto.randomUUID().replaceAll('-',''),endpoint=`/api/cases/${encodeURIComponent(caseId)}/work-sessions`;
 let paused=false,usageReady=false,lastInput=Date.now(),last=Date.now(),seq=0,actionSeq=0,current=null,error='',dropped=false,pending=[],pendingActions=[],inflight=new Set(),inflightActions=new Set();
 const counts={active:0,idle:0,hidden:0,paused:0,unobserved:0};let taskSeconds=0;
 const panel=document.createElement('details');panel.className='work-session';panel.innerHTML='<summary>작업 시간 기록 · 현재 화면 활동 추정 <b>0분</b></summary><div><button type="button" class="secondary pause">작업 잠시 멈춤</button><button type="button" class="secondary export">시간 기록 다운로드</button><span role="status"></span></div><small>최근 입력이 있는 전경 화면을 활동으로 추정합니다. 60초 무입력·다른 창·일시중지는 구분해 기록합니다. 영상 시청도 무입력으로 잡힐 수 있습니다. 납품 90분 시계는 계속 흐릅니다. 입력 내용·좌표는 저장하지 않습니다.</small>';
 host.append(panel);const label=panel.querySelector('b'),status=panel.querySelector('[role=status]'),pause=panel.querySelector('.pause');
 const usageNote=document.createElement('span');panel.querySelector('small').append(usageNote);
 // A browser can receive updated static files before the server is restarted.
 // Only send the extended format after that server explicitly advertises it.
 fetch(endpoint).then(r=>r.ok?r.json():null).then(data=>{if(data?.buttonCounts){usageReady=true;usageNote.textContent=' 주요 버튼의 누름 횟수도 기록합니다. 입력 내용과 작업자 신원은 기록하지 않습니다.';}}).catch(()=>{});
 if(!document.getElementById('work-session-style')){const style=document.createElement('style');style.id='work-session-style';style.textContent='.work-session{font-size:12px;color:#536073;margin:10px 0;border-top:1px solid #e2e5eb;padding-top:9px}.work-session summary{cursor:pointer}.work-session div{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0}.work-session button{font-size:12px;padding:6px 10px}.work-session small{display:block;line-height:1.6;max-width:900px}.work-session b{color:#132747}';document.head.append(style);}
 const snapshot=()=>({stage,eventId:eventId()||null,attention:attentionState({paused,visible:!document.hidden,focused:document.hasFocus(),lastInput,now:Date.now()}),taskBusy:running.has(currentTaskState())});
 let previous=snapshot();
 function seal(){if(current){pending.push(current);current=null;}}
 function record(start,end,state){
  while(start<end){const to=Math.min(end,start+60000),same=current&&current.stage===state.stage&&current.eventId===state.eventId&&current.attention===state.attention&&current.taskBusy===state.taskBusy&&current.endedAtMs===start&&to-current.startedAtMs<=60000;
   if(same)current.endedAtMs=to;else{seal();current={seq:seq++,startedAtMs:start,endedAtMs:to,...state};}
   counts[state.attention]+=(to-start)/1000;if(state.taskBusy)taskSeconds+=(to-start)/1000;start=to;
  }
 }
 function sample(){const now=Date.now(),gap=now-last;if(gap>0&&gap<=86400000)record(last,now,gap>5000?{...previous,attention:'unobserved',taskBusy:false}:previous);last=Math.max(last,now);previous=snapshot();render();}
 function render(){label.textContent=`${Math.floor(counts.active/60)}분${paused?' · 일시중지':''}`;status.textContent=error||`${dropped?'일부 미저장 시간 누락 · ':''}이 화면 활동 약 ${Math.round(counts.active)}초 · 무입력 ${Math.round(counts.idle)}초 · 화면 비활성 ${Math.round(counts.hidden)}초 · 일시중지 ${Math.round(counts.paused)}초 · 처리 대기/실행 ${Math.round(taskSeconds)}초`;}
 async function flush(){
  sample();seal();const fresh=pending.filter(r=>r.startedAtMs>Date.now()-86300000);if(fresh.length<pending.length||fresh.length>1200)dropped=true;pending=fresh.slice(-1200);const records=pending.filter(r=>!inflight.has(r.seq)).slice(0,120);if(!records.length)return;
  if(pendingActions.length>1200){pendingActions=pendingActions.slice(-1200);dropped=true;}
  const actions=pendingActions.filter(a=>!inflightActions.has(a.seq)).slice(0,120),ids=new Set(records.map(r=>r.seq)),actionIds=new Set(actions.map(a=>a.seq));for(const id of ids)inflight.add(id);for(const id of actionIds)inflightActions.add(id);
  try{const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,records,...(usageReady?{actions}: {})}),keepalive:true});if(!response.ok)throw Error('시간 기록 저장 대기 · 편집 작업은 계속할 수 있습니다.');pending=pending.filter(r=>!ids.has(r.seq));pendingActions=pendingActions.filter(a=>!actionIds.has(a.seq));error='';}
  catch{error='시간 기록 저장 대기 · 다음 주기에 재시도합니다.';}
  finally{for(const id of ids)inflight.delete(id);for(const id of actionIds)inflightActions.delete(id);render();}
 }
 const input=()=>{sample();lastInput=Date.now();previous=snapshot();};
 const buttonClick=event=>{if(!usageReady)return;const action=trackedAction(stage,event);if(action)pendingActions.push({seq:actionSeq++,stage,action});};
 document.addEventListener('click',buttonClick);
 for(const name of ['pointerdown','keydown','wheel','input'])document.addEventListener(name,input,{passive:true});
 const transition=()=>{sample();previous=snapshot();void flush();};
 document.addEventListener('visibilitychange',transition);window.addEventListener('blur',transition);window.addEventListener('focus',transition);window.addEventListener('pagehide',transition);
 pause.onclick=()=>{sample();paused=!paused;lastInput=Date.now();previous=snapshot();pause.textContent=paused?'작업 재개':'작업 잠시 멈춤';void flush();};
 panel.querySelector('.export').onclick=async()=>{try{await flush();const r=await fetch(endpoint+'?export=1');if(!r.ok)throw Error();const body=await r.json(),url=URL.createObjectURL(new Blob([JSON.stringify(body,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${caseId}-work-times.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch{error='시간 기록을 받지 못했습니다. 서버 연결을 확인하세요.';render();}};
 const tick=setInterval(sample,1000),heartbeat=setInterval(()=>void flush(),60000);render();
 return {flush,destroy(){clearInterval(tick);clearInterval(heartbeat);void flush();document.removeEventListener('click',buttonClick);for(const name of ['pointerdown','keydown','wheel','input'])document.removeEventListener(name,input);document.removeEventListener('visibilitychange',transition);for(const name of ['blur','focus','pagehide'])window.removeEventListener(name,transition);panel.remove();}};
}
