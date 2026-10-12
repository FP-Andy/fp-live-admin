/* Isolated browser regression: synthetic match and intercepted API only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('../apps/web/node_modules/playwright-core');
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
   const writes=[],events=new Map();let failSample=true, failRefresh=false, loseShotAck=true;
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
     const body=route.request().postDataJSON();writes.push(body);
     if(events.has(body.event_id))assert.deepEqual(body,writes.find(row=>row.event_id===body.event_id));
     events.set(body.event_id,{...body,id:body.event_id,type:'XG',created_at:new Date().toISOString()});
     if(loseShotAck){loseShotAck=false;return route.abort();}
     failRefresh=true;
     return respond({ok:true,event_id:body.event_id});
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
   await pitch().click({position:{x:120,y:80}});
   await page.getByRole('button',{name:'슈팅 기록',exact:true}).click();
   await page.getByRole('button',{name:'원래 기록 재시도'}).waitFor();
   assert.equal(events.size,1);
   const original=writes[0];
   await page.reload();
   await page.getByRole('button',{name:'원래 기록 재시도'}).waitFor();
   await page.locator('.fla-possession-buttons .fla-home').waitFor();
   await page.waitForFunction(()=>document.querySelector('.fla-possession-buttons .fla-home')?.disabled===false);
   await page.getByRole('button',{name:'원래 기록 재시도'}).click();
   await page.getByText('슈팅을 기록했습니다. 기록 탭에서 확인할 수 있습니다.',{exact:true}).waitFor();
   assert.equal(events.size,1,'Lost acknowledgement retry must not create a second event');
   assert.deepEqual(writes[1],original,'Retry must retain ID, timestamp and complete payload');
   await page.waitForTimeout(300);
   assert.equal(await page.getByText('슈팅 기록을 저장하지 못했습니다. 입력은 유지됩니다. 다시 시도해 주세요.',{exact:true}).count(),0);
   assert.equal(await page.getByLabel('저장 확인 대기 슈팅').count(),0);
   await pitch().click({position:{x:140,y:90}});
   assert.equal(await page.getByRole('button',{name:'슈팅 기록',exact:true}).isEnabled(),true,'Refresh failure must not lock the next shot');
   assert.deepEqual(errors,[]);
   await page.screenshot({path:`${output}/${sport}.png`});
   results.push({sport,passed:true,cases:['reload elapsed time','sample error continuity','suspended performance clock','start latency','persisted shot retry','save/refresh separation'],originalShot:original.event_id,committedShots:events.size});
   await context.close();
  }
  console.log(JSON.stringify(results,null,2));
 }finally{fs.writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
