const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('../apps/web/node_modules/playwright-core');
const origin=process.env.FPC_QA_ORIGIN||'http://127.0.0.1:4354';assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const output=process.env.FPC_BASKETBALL_QA_OUTPUT||'/tmp/fpc-basketball-recovery-qa';fs.mkdirSync(output,{recursive:true});
const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',path='/admin/basketball/match/'+id;
let state={revision:0,events:[],lineups:{HOME:[{number:'7',name:'검증 선수'}],AWAY:[]},timer:{period:1,clock:'10:00'}},mode='ok';
const receipts=new Map(),packets=[],errors=[],cases=[];const pass=name=>{cases.push(name);console.log('PASS:',name);};let browser,page;
(async()=>{browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':chromium.executablePath()),headless:true});const c=await browser.newContext({serviceWorkers:'block',acceptDownloads:true,viewport:{width:1366,height:768}});
 await c.addCookies([{name:'live_admin_session',value:'synthetic',url:origin}]);
 await c.addInitScript(id=>{localStorage.setItem('fineplay.selectedSport','BASKETBALL');localStorage.setItem('fineplay.basketball.events.'+id,JSON.stringify([{id:'old-deleted',homeScoreAfter:99,awayScoreAfter:0}]));},id);
 await c.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue();
 if(u.pathname==='/api/session/me')return route.fulfill({json:{id:'basket-owner',name:'검증 관리자',role:'SUPERADMIN'}});
 if(u.pathname==='/api/matches/'+id)return route.fulfill({json:{id,sport:'BASKETBALL',name:'검증 경기',metadata:{home_team:'홈',away_team:'원정',period_minutes:10}}});
 if(u.pathname==='/api/recordings/matches/'+id)return route.fulfill({json:{recordings:[],receiver_ready:false}});
 if(u.pathname==='/api/matches/'+id+'/basketball-state'){
  if(route.request().method()==='GET')return route.fulfill({json:state});
  const p=route.request().postDataJSON();packets.push(p);
  if(mode==='conflict')return route.fulfill({status:409,json:{detail:'다른 창에서 기록을 변경했습니다.'}});
  if(!receipts.has(p.request_id)){assert.equal(p.revision,state.revision);const {request_id,revision,...delta}=p;state={...state,...delta,revision:revision+1};receipts.set(request_id,state.revision);}
  if(mode==='lost')return route.abort('failed');
  return route.fulfill({json:{ok:true,revision:receipts.get(p.request_id),current_revision:state.revision}});
 }return route.fulfill({json:[]});});
 try{page=await c.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto(origin+path);await page.getByLabel('농구 저장 상태').filter({hasText:'서버 저장됨'}).waitFor();
 assert.deepEqual(await page.locator('.basketball-score-team strong').allTextContents(),['0','0']);assert.equal(state.events.length,0);assert.equal(packets.length,0);
 pass('An authoritative empty server list never resurrects legacy local events or writes on load');
 mode='lost';await page.getByRole('button',{name:'Free Throw',exact:true}).click();await page.locator('.basketball-log-entry-row').getByRole('button',{name:'입력',exact:true}).first().click();
 await page.getByRole('button',{name:'저장 다시 시도',exact:true}).waitFor();assert.equal(state.events.length,1);const first=packets[0];
 await page.reload();await page.getByRole('button',{name:'저장 다시 시도',exact:true}).waitFor();assert.deepEqual(await page.locator('.basketball-score-team strong').allTextContents(),['1','0']);
 mode='ok';await page.getByRole('button',{name:'저장 다시 시도',exact:true}).click();await page.getByLabel('농구 저장 상태').filter({hasText:'서버 저장됨'}).waitFor();assert.deepEqual(packets[1],first);assert.equal(state.events.length,1);
 pass('A committed but lost response survives reload and retries the same event exactly once');
 mode='conflict';await page.getByRole('button',{name:'Free Throw',exact:true}).click();await page.locator('.basketball-log-entry-row').getByRole('button',{name:'입력',exact:true}).first().click();await page.getByRole('button',{name:'농구 기록 JSON 보관',exact:true}).waitFor();
 const dl=page.waitForEvent('download');await page.getByRole('button',{name:'농구 기록 JSON 보관',exact:true}).click();await(await dl).saveAs(output+'/pending.json');const data=JSON.parse(fs.readFileSync(output+'/pending.json'));assert.equal(data.value.events.length,2);assert.equal(state.events.length,1);
 pass('Competing revision keeps the new local event and exports it without overwriting server data');
 await page.screenshot({path:output+'/conflict.png'});assert.deepEqual(errors,[]);fs.writeFileSync(output+'/results.json',JSON.stringify({cases,errors},null,2));
 }catch(e){await page?.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
