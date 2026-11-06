/* Isolated browser regression: synthetic match and intercepted API only.
 * Shots go through the local-first outbox (apps/web/lib/fla-input-outbox.ts): stored in localStorage
 * under fpc.fla-outbox.v1:<user>:<match>:<id>, re-sent automatically with the same event_id.
 * The xg mock mirrors apps/api post_xg: a known event_id with the same payload answers
 * {ok, idempotent, event_id}; a different payload answers 409. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || '../apps/web/node_modules/playwright-core');
const origin = process.env.FPC_QA_ORIGIN || 'http://127.0.0.1:4354';
assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const id='11111111-1111-4111-8111-111111111111';
const output=process.env.FPC_CLOCK_QA_OUTPUT||'/tmp/fpc-match-control-reliability';
fs.mkdirSync(output,{recursive:true});
const results=[];
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {
  for(const sport of ['FOOTBALL','FUTSAL']){
   let revision=0, state={clock_ms:10000,running:true,possession_team:'NONE',selected_team:'HOME',attack_lr:'L2R',clock_speed:1,sampled_at:new Date(Date.now()-30000).toISOString()};
   const writes=[],events=new Map(),inserts=[];let failSample=true, failRefresh=false;
   // Per-attempt plan for xg POSTs. 'lose': store, then drop the reply after 1.5s (lost ack).
   // 'lose-on-reload': store, then hold the reply until the page reloads (ack never arrives).
   // 'hold': wait for release() before the server handles it. Default: handle and reply.
   const shotPlan=[];let cut=()=>{},release=()=>{};const gate=set=>new Promise(r=>set(r));
   const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
   await context.addCookies([{name:'live_admin_session',value:'fixture-only',url:origin}]);
   await context.addInitScript(sport=>{localStorage.setItem('fineplay.selectedSport',sport);sessionStorage.setItem('fpc.sidebar.open','false');const now=performance.now.bind(performance);Object.defineProperty(performance,'now',{value:()=>window.__frozenPerf??now()});},sport);
   const returnedState=()=>({...state,server_now:new Date().toISOString()});
   await context.route('**/*',async route=>{
    const url=new URL(route.request().url()), path=url.pathname;
    if(url.origin!==origin)return route.abort();
    if(!path.startsWith('/api/'))return route.continue();
    const respond=json=>route.fulfill({json});
    if(path==='/api/session/me')return respond({id:'fixture-admin',role:'SUPERADMIN',name:'검증 관리자'});
    if(path==='/api/outbox')return respond([]);
    if(path===`/api/matches/${id}`)return respond({id,name:'합성 홈 vs 합성 원정',sport,archived:false,competition_class:'K3',first_half_minutes:45,metadata:{stream_mode:'MANUAL',fla_clock_revision:revision,home_team:'합성 홈',away_team:'합성 원정'}});
    if(path===`/api/matches/${id}/summary`){if(failRefresh)return route.abort();return respond({state:returnedState(),command_revision:revision,events:[...events.values()],markers:[],possession:{home_pct:0,away_pct:0},lanes:{home:{},away:{}}});}
    if(path===`/api/matches/${id}/dominance`)return respond({bins:[]});
    if(path===`/api/matches/${id}/highlights`)return respond({highlights:[]});
    if(path===`/api/matches/${id}/state`){
     const body=route.request().postDataJSON();
     if(body.update_kind==='sample'&&failSample){failSample=false;return route.abort();}
     if(body.command_revision!==revision)return respond({ok:true,ignored:true,state:returnedState(),command_revision:revision});
     if(body.update_kind==='command')await new Promise(r=>setTimeout(r,1300));
     state={...body,sampled_at:new Date().toISOString()};if(body.update_kind==='command')revision++;
     return respond({ok:true,state:returnedState(),command_revision:revision});
    }
    if(path===`/api/matches/${id}/events/xg`){
     const body=route.request().postDataJSON();const plan=shotPlan.shift()||'ack';
     if(plan==='hold')await gate(r=>{release=r;});
     writes.push(body);
     let reply;
     if(events.has(body.event_id)){
      const same=JSON.stringify(writes.find(row=>row.event_id===body.event_id))===JSON.stringify(body);
      reply=same?{json:{ok:true,idempotent:true,event_id:body.event_id}}:{status:409,json:{detail:'Request ID already belongs to a different match or payload'}};
     }else{
      inserts.push(body.event_id);
      events.set(body.event_id,{...body,id:body.event_id,type:'XG',created_at:new Date().toISOString()});
      reply={json:{ok:true,event_id:body.event_id}};
     }
     if(plan==='lose'){await new Promise(r=>setTimeout(r,1500));return route.abort().catch(()=>{});}
     if(plan==='lose-on-reload'){await gate(r=>{cut=r;});return route.abort().catch(()=>{});}
     return route.fulfill(reply).catch(()=>{});
    }
    throw Error(`Unexpected route ${path}`);
   });
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const seconds=async()=>{const label=await page.locator('.fla-clock-value').innerText();const m=label.match(/(\d+):(\d+)/);return Number(m[1])*60+Number(m[2]);};
   const pitch=()=>page.getByLabel(sport==='FUTSAL'?'풋살 슛 위치 입력 피치':'슈팅 위치 선택',{exact:true});
   await page.goto(origin+`/admin/match/${id}`);
   await page.locator('.fla-possession-buttons .fla-home').waitFor();
   await page.waitForFunction(()=>document.querySelector('.fla-possession-buttons .fla-home')?.disabled===false);
   const restored=await seconds();
   assert(restored>=40,`Reload must restore the 30 seconds since the saved state, got ${restored}`);
   const before=await seconds();await page.waitForTimeout(3800);
   assert(await seconds()>=before+3,'A failed sample must not rewind the clock');
   await page.evaluate(()=>{window.__frozenPerf=performance.now();});
   const frozen=await seconds();await page.waitForTimeout(2200);
   assert(await seconds()>=frozen+2,'Wall elapsed time must survive a suspended performance clock');
   await page.evaluate(()=>{delete window.__frozenPerf;});
   await page.getByRole('button',{name:'일시정지',exact:true}).click();await page.waitForTimeout(1600);
   const paused=await seconds();await page.waitForTimeout(1100);assert.equal(await seconds(),paused);
   await page.getByRole('button',{name:'경기 시작',exact:true}).click();await page.waitForTimeout(1600);
   assert(await seconds()>=paused+1,'Start must include response latency');
   const outboxKey=`fpc.fla-outbox.v1:fixture-admin:${id}:`;
   const stored=()=>page.evaluate(prefix=>Object.keys(localStorage).filter(k=>k.startsWith(prefix)).map(k=>JSON.parse(localStorage.getItem(k))),outboxKey);
   const records=page.locator('.fla-records .fla-record-list');
   const syncLabels=()=>records.locator('.fla-record-sync');
   const settled=()=>page.waitForFunction(prefix=>!Object.keys(localStorage).some(k=>k.startsWith(prefix))&&!document.querySelector('.fla-records .fla-record-sync'),outboxKey,{timeout:20000});
   const attemptsOf=eventId=>writes.filter(row=>row.event_id===eventId);
   const checkSameRequest=(eventId,item)=>{
    const tries=attemptsOf(eventId);
    tries.forEach(row=>assert.deepEqual(row,tries[0],'Every resend must carry the same event_id, timestamp and payload'));
    assert.equal(tries[0].clock_ms,item.clock_ms,'Resend must keep the pressed-at clock');
    assert.deepEqual(tries[0],{...item.body,event_id:item.id},'Resend must carry the complete stored payload');
    for(const key of ['team','xg','shot_x','shot_y','is_goal','is_on_target','is_own_goal','shot_pace_band'])assert(key in tries[0],`Payload is missing ${key}`);
    assert.equal(inserts.filter(x=>x===eventId).length,1,'Server must hold exactly one event for this event_id');
    return tries.length;
   };
   page.on('dialog',dialog=>dialog.accept().catch(()=>{}));
   // A. Lost acknowledgement: the server stored the shot but the reply is dropped. The outbox resends by itself.
   shotPlan.push('lose');
   await pitch().click({position:{x:120,y:80}});
   await page.getByRole('button',{name:'슈팅 기록',exact:true}).click();
   const [lostItem]=await stored();
   assert(lostItem&&lostItem.kind==='shot','Shot must be stored in localStorage as soon as it is pressed');
   await records.locator('.fla-record.shot',{has:page.locator('.fla-record-tag')}).first().waitFor();
   await syncLabels().filter({hasText:'저장 중'}).first().waitFor();
   await settled();
   const lostAttempts=checkSameRequest(lostItem.id,lostItem);
   assert(lostAttempts>=2,'Lost acknowledgement must be resent automatically');
   assert.equal(events.size,1,'Lost acknowledgement retry must not create a second event');
   assert.equal(await syncLabels().count(),0);
   assert.equal(await records.locator('.fla-record.shot').count(),1,'Lost-ack shot must appear once');
   // B. Reload while pending: the reply never arrives before reload; after reload the stored item is sent again.
   shotPlan.push('lose-on-reload','hold');
   await pitch().click({position:{x:130,y:85}});
   await page.getByRole('button',{name:'슈팅 기록',exact:true}).click();
   const pendingItem=(await stored())[0];
   assert(pendingItem&&pendingItem.id!==lostItem.id,'Second shot must be stored with a new event_id');
   await syncLabels().filter({hasText:'저장 중'}).first().waitFor();
   await new Promise(r=>{const t=setInterval(()=>{if(attemptsOf(pendingItem.id).length){clearInterval(t);r();}},50);});
   await page.reload();
   await page.locator('.fla-possession-buttons .fla-home').waitFor();
   await page.waitForFunction(()=>document.querySelector('.fla-possession-buttons .fla-home')?.disabled===false);
   cut();
   const afterReload=await stored();
   assert.deepEqual(afterReload,[pendingItem],'Pending shot must survive reload in localStorage unchanged');
   // The server already holds this event (its first attempt was stored), so the row comes from the
   // summary without a sync label; it must still be listed once, not twice.
   assert.equal(await records.locator('.fla-record.shot').count(),2,'Pending shot must not be listed twice after reload');
   for(let i=0;i<200&&shotPlan.length;i++)await page.waitForTimeout(50);
   assert.equal(shotPlan.length,0,'Outbox must resend the stored shot after reload');
   release();
   await settled();
   const reloadAttempts=checkSameRequest(pendingItem.id,pendingItem);
   assert(reloadAttempts>=2,'Pending shot must be sent again after reload');
   assert.equal(events.size,2,'Reload resend must not create a duplicate event');
   assert.equal(await records.locator('.fla-record.shot').count(),2,'Each shot must appear once after reload');
   // C. A summary refresh failure must not lock the next shot.
   failRefresh=true;
   await pitch().click({position:{x:140,y:90}});
   assert.equal(await page.getByRole('button',{name:'슈팅 기록',exact:true}).isEnabled(),true,'Refresh failure must not lock the next shot');
   await page.getByRole('button',{name:'슈팅 기록',exact:true}).click();
   await settled();
   assert.equal(events.size,3,'Shot during refresh failure must still be saved');
   assert.deepEqual(errors,[]);
   await page.screenshot({path:`${output}/${sport}.png`});
   results.push({sport,passed:true,cases:['reload elapsed time','sample error continuity','suspended performance clock','start latency','lost-ack auto resend','reload-while-pending resend','save/refresh separation'],lostAckShot:{event_id:lostItem.id,attempts:lostAttempts},reloadPendingShot:{event_id:pendingItem.id,attempts:reloadAttempts},serverEventIds:[...events.keys()],serverInserts:inserts.length});
   await context.close();
  }
  console.log(JSON.stringify(results,null,2));
 }finally{fs.writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
