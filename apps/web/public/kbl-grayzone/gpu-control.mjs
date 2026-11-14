// The power-on button is always an explicit operator action. It never resumes work.
export function mountGpuControl(anchor){
 const box=document.createElement('section');box.className='gpu-control';box.hidden=true;box.setAttribute('aria-label','T4 전원 상태');
 const title=document.createElement('strong');title.textContent='T4 작업 준비';
 const state=document.createElement('p');state.setAttribute('role','status');
 const button=document.createElement('button');button.type='button';button.textContent='기존 T4 켜기';
 const note=document.createElement('p');note.className='gpu-note';note.textContent='기존 T4만 시작하며 실행 중 비용이 발생합니다. 작업을 마친 뒤 중지해 주세요.';
 box.append(title,state,button,note);anchor.before(box);
 let reading=false,timer=null,shown=false;
 async function call(path,body){const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error(v.error||'T4 상태를 확인하세요.');return v;}
 function display(v){
  clearTimeout(timer);const running=v.state==='running',pending=v.state==='pending',stopped=v.state==='stopped';
  button.disabled=running||pending;button.textContent=running?'T4 실행 중':pending?'T4 켜는 중…':'기존 T4 켜기';
  state.textContent=running?'T4가 실행 중입니다. 연결 준비 후 ‘중단된 작업 이어받기’를 눌러 주세요.':pending?'T4가 켜지고 있습니다. 실행 상태를 확인하는 중입니다.':stopped?'T4가 중지되어 있습니다. 버튼을 눌러 기존 T4를 켤 수 있습니다.':`현재 T4 상태: ${v.state}. 정지가 끝난 뒤 다시 시도하세요.`;
  if(pending)timer=setTimeout(refresh,5000);
 }
 async function refresh(){if(reading)return;reading=true;try{display(await call('/api/gpu/status'));}catch(e){state.textContent=e.message;button.disabled=false;button.textContent='기존 T4 켜기';}finally{reading=false;}}
 button.onclick=async()=>{button.disabled=true;state.textContent='기존 T4에 시작 요청을 보내는 중입니다…';try{display(await call('/api/gpu/start',{action:'start'}));}catch(e){state.textContent=e.message;button.disabled=false;}};
 return {show(){box.hidden=false;if(!shown){shown=true;refresh();}}};
}
