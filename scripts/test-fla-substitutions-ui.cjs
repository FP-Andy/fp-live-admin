// Run only against the loopback preview_fla_video.py database, never production.
const {chromium}=require('../apps/web/node_modules/playwright-core');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const origin=process.env.FLA_TEST_URL||'http://127.0.0.1:54326';
assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1512,height:982}});page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.addInitScript(()=>localStorage.setItem('fineplay.selectedSport','FUTSAL'));
  await page.goto(origin+'/api/local-preview');
  const fixtures=await (await page.request.get(origin+'/api/futsal/fla-video/fixtures')).json();
  assert.equal(fixtures.uploads.length,1);assert.match(fixtures.uploads[0].name,/로컬 원본/);
  const fixture=fixtures.fixtures.find(f=>!f.video.configured)||fixtures.fixtures[0],id=fixture.match_id,base=origin+'/api/futsal/fla-video/matches/'+id;
  await page.goto(origin+'/admin/futsal/fla/video/'+id);
  await page.getByRole('heading',{name:'교체 타임로그',exact:true}).waitFor();
  assert(await page.getByRole('link',{name:'영상 기록',exact:true}).isVisible());
  assert.equal(await page.locator('iframe').count(),0,'Native recording uses one shared player');
  // Repeated runs reset only this isolated test fixture through its normal API.
  const before=await (await page.request.get(base)).json();
  if(before.state.started){
    const client=await page.evaluate(id=>sessionStorage.getItem('fla-video-client:'+id),id);
    // The previous test page has gone; retain its local writer for a clean rerun.
    const response=await page.request.post(base+'/reset',{data:{request_id:crypto.randomUUID(),client_id:client,version:before.state.version,kind:'recording'}});
    assert(response.ok(),await response.text());await page.reload();
  }
  const sourceSelect=page.getByRole('combobox',{name:'경기 영상 선택',exact:true});
  if(await sourceSelect.inputValue()!==fixtures.uploads[0].id)await sourceSelect.selectOption(fixtures.uploads[0].id);
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=1);
  await page.getByRole('textbox',{name:'경기 시작 영상 시각',exact:true}).fill('00:02.000');
  await page.getByRole('button',{name:'시작 시각 저장',exact:true}).click();
  const card=page.getByRole('region',{name:'교체 타임로그',exact:true});
  assert.equal(await card.getByRole('combobox',{name:'OUT 선수',exact:true}).count(),0);
  assert.equal(await card.getByRole('combobox',{name:'IN 선수',exact:true}).count(),0);
  await page.getByRole('button',{name:'경기 시작',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video').currentTime>=3.5);
  await card.getByRole('button',{name:'홈 교체 기록',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.fv-log-events article').length===1);
  await card.locator('.fv-log-history summary').click();
  const initial=await (await page.request.get(base)).json();
  assert.deepEqual(initial.substitutions.log.players,[]);
  assert.equal(initial.substitutions.log.substitutions[0].outId,undefined);
  await card.getByRole('button',{name:'홈 교체 기록',exact:true}).click();
  await card.getByRole('alert').waitFor();
  assert.equal(await card.locator('.fv-log-events article').count(),1,'Double clicking a paused marker cannot duplicate it');
  await page.getByRole('button',{name:'영상 재생 정지',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video').currentTime>=6);
  await card.getByRole('button',{name:'어웨이 교체 기록',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.fv-log-events article').length===2);
  const state=await (await page.request.get(base)).json();assert.equal(state.events.length,0);
  const log=state.substitutions.log,first=log.substitutions[0];
  assert.equal(log.video.from,2);assert.equal(log.schema,'fpa-substitution-log/v2');
  assert.deepEqual(log.substitutions.map(e=>e.team),['home','away']);
  const download=page.waitForEvent('download');await card.getByRole('button',{name:'JSON 백업',exact:true}).click();
  const saved=JSON.parse(fs.readFileSync(await (await download).path(),'utf8'));
  assert.equal(saved.substitutions.length,2);assert.deepEqual(saved.appearances,[]);
  assert.equal(saved.reviewWindows[0].boundary,'camera-bottom');assert.equal(saved.trackingApplied,false);
  await page.reload();await card.locator('.fv-log-history summary').click();await card.locator('.fv-log-events article').first().waitFor();
  assert.equal(await card.locator('.fv-log-events article').count(),2,'Time-only server state survives reload');
  await card.locator('.fv-log-events article').first().getByRole('button',{name:'수정',exact:true}).click();
  await card.getByRole('textbox',{name:'교체 메모',exact:true}).fill('Q W A S D 동시 교체');
  await card.getByRole('button',{name:'교체 수정 저장',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.fv-log-events').textContent.includes('동시 교체'));
  assert.equal((await (await page.request.get(base)).json()).events.length,0,'Text input cannot add attack events');
  await card.locator('.fv-log-events article').first().getByRole('button',{name:/경기/}).click();
  await page.waitForFunction(t=>Math.abs(document.querySelector('video').currentTime-t)<.01,first.time);
  await card.locator('.fv-log-events article').last().getByRole('button',{name:/경기/}).click();
  assert.match(await page.locator('.fv-notice').innerText(),/앞으로 이동/);
  const after=await (await page.request.get(base)).json();assert.deepEqual(after.possession,state.possession,'Review navigation never adds possession');
  await card.locator('.fv-log-events article').last().getByRole('button',{name:'삭제',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.fv-log-events article').length===1);
  const shell=await page.evaluate(()=>({height:document.documentElement.scrollHeight,viewport:innerHeight,video:document.querySelector('video').getBoundingClientRect().width,rail:document.querySelector('.fv-inputs').scrollHeight>document.querySelector('.fv-inputs').clientHeight}));
  assert(shell.height<=shell.viewport+1,'Only the existing input rail scrolls');assert(shell.video>400);assert(shell.rail);
  assert.deepEqual(errors,[]);
  console.log('PASS: FLA 영상 기록 navigation, single shared video, source/kickoff clocks, time-only markers without player inputs, server persistence, form hotkeys, pending export, reload, editing, forward-seek restriction and possession isolation.');
  console.log('Preview: '+origin+'/admin/futsal/fla/video/'+id);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
