/* Actual tagging/import/wasm extraction UI with isolated synthetic API fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { chromium } = require('../apps/web/node_modules/playwright-core');
const origin = process.env.FPC_QA_ORIGIN || 'http://127.0.0.1:4354';
assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const output = process.env.FPC_LOG_QA_OUTPUT || '/tmp/fpc-highlight-log-qa';
fs.mkdirSync(output,{recursive:true});
const media = output+'/source.mp4';
execFileSync(process.env.FFMPEG || 'ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=10',
  '-c:v','libx264','-threads','1','-pix_fmt','yuv420p',media]);
const evidence=[],errors=[],unexpected=[],uploaded=[];
let browser, queued=false, polls=0, savedLog=false, mergeBody;
const pass = name => { evidence.push(name); console.log('PASS:',name); };
async function context() {
  const c=await browser.newContext({acceptDownloads:true,viewport:{width:1366,height:900},serviceWorkers:'block'});
  await c.addCookies([{name:'live_admin_session',value:'fixture',url:origin}]);
  await c.addInitScript(()=>localStorage.setItem('fineplay.selectedSport','FOOTBALL'));
  await c.route('**/*',async route=>{
    const u=new URL(route.request().url()), method=route.request().method();
    if(u.origin!==origin)return route.abort();
    if(!u.pathname.startsWith('/api/'))return route.continue();
    const send=data=>route.fulfill({json:data});
    if(u.pathname==='/api/session/me')return send({id:'fixture-admin',name:'Fixture',role:'SUPERADMIN'});
    if(u.pathname==='/api/highlight/card-templates')return send({templates:[],default:'fineplay'});
    if(u.pathname.includes('/card-preview'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>'});
    if(u.pathname==='/api/highlight/manual-jobs' && method==='POST')return send({job_id:'fixture-log-job'});
    if(u.pathname==='/api/highlight/manual-jobs/fixture-log-job/log' && method==='PUT') {
      savedLog=route.request().postDataBuffer().includes(Buffer.from('fpc-highlight-log'));return send({ok:true});
    }
    if(u.pathname==='/api/highlight/manual-jobs/fixture-log-job/clips' && method==='POST') {
      const body=route.request().postDataBuffer().toString('latin1');
      const field=name=>body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
      uploaded.push({index:field('index'),kind:field('kind'),before:field('score_before'),after:field('score_after'),start:field('requested_start'),end:field('requested_end')});
      return send({name:'clip.mp4'});
    }
    if(u.pathname==='/api/highlight/manual-jobs/fixture-log-job/merge') {
      assert(savedLog);mergeBody=route.request().postDataJSON();queued=true;
      return send({status:'render_queued',render_queue:{position:2}});
    }
    if(u.pathname==='/api/highlight/jobs/fixture-log-job') {
      polls++;
      return send({id:'fixture-log-job',status:polls<3?'render_queued':polls<4?'merging':'done',
        render_queue:polls<3?{position:2,status:'queued'}:null,job_metadata:{progress:{detail:'합치기 검증'}}});
    }
    if(u.pathname==='/api/highlight/jobs')return send([{id:'fixture-log-job',status:'render_queued',original_filename:'source.mp4',created_at:new Date().toISOString(),
      render_queue:{position:2,status:'queued'},job_metadata:{highlight_log:{tag_count:3},clip_info:[{name:'clip_002.mp4',requested_start:3,requested_end:5,kind:'substitution'}]}}]);
    unexpected.push({path:u.pathname,method});return route.fulfill({status:404,json:{detail:'No fixture'}});
  });
  return c;
}
async function open(c) {
  const page=await c.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/admin/highlight/manual');
  await page.locator('input[type=file]').first().setInputFiles(media);
  await page.getByRole('button',{name:/＋ 태깅/}).waitFor();
  await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
  return page;
}
async function exportLog(page,name) {
  const event=page.waitForEvent('download');
  await page.getByRole('button',{name:'하이라이트 로그 JSON 다운로드',exact:true}).click();
  await (await event).saveAs(output+'/'+name);
  return JSON.parse(fs.readFileSync(output+'/'+name,'utf8'));
}
async function tag(page,time,name) {
  await page.locator('video').evaluate((v,time)=>{v.currentTime=time;v.dispatchEvent(new Event('timeupdate'));},time);
  await page.getByRole('button',{name,exact:true}).click();
}
(async()=>{
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const first=await context(),page=await open(first);
  await tag(page,2,'Q 홈 골');await tag(page,4,'C 교체');await tag(page,6,'W 홈 장면');
  const original=await exportLog(page,'before-merge.json');
  assert.equal(original.work.tags[1].kind,'substitution');assert.equal(uploaded.length,0);assert(!queued);
  pass('Goal/highlight/substitution JSON is downloadable before any extraction or server merge');
  // Set short clip ranges in the portable log, retaining original tag times.
  original.work.padBefore=1;original.work.padAfter=1;
  original.work.cards.enabled=false;original.work.watermark.enabled=false;
  original.work.clipTransition=false;
  fs.writeFileSync(output+'/import.json',JSON.stringify(original));
  const second=await context(),restored=await open(second);
  await restored.getByLabel('수동 태깅 복구 파일').setInputFiles(output+'/import.json');
  await restored.getByRole('button',{name:'로그로 하이라이트 제작',exact:true}).waitFor();
  const roundtrip=await exportLog(restored,'roundtrip.json');
  assert.deepEqual(roundtrip.work,original.work);
  pass('Fresh browser restores exact tags, clip ranges and output settings from JSON');
  await restored.getByRole('button',{name:'로그로 하이라이트 제작',exact:true}).click();
  await restored.getByText(/합치기 대기 2번째/).first().waitFor({timeout:120000});
  assert(savedLog);assert(queued);assert.equal(uploaded.length,3);
  uploaded.sort((a,b)=>Number(a.index)-Number(b.index));
  assert.deepEqual(uploaded.map(v=>v.kind),['home_goal','substitution','home']);
  assert.equal(uploaded[1].before,uploaded[1].after);
  assert.deepEqual(uploaded.map(v=>[Number(v.start),Number(v.end)]),[[1,3],[3,5],[5,7]]);
  assert.equal(mergeBody.clip_xfade_sec,0);
  pass('Imported log runs actual browser clip extraction, saves JSON on server and enqueues once; substitution keeps score unchanged');
  await restored.screenshot({path:output+'/queued-from-json.png',fullPage:true});
  await restored.getByText('완료되었습니다.',{exact:true}).waitFor({timeout:30000});
  pass('Queued task progresses to completion without resubmission');
  const results=await second.newPage();await results.goto(origin+'/admin/highlight/results');
  await results.getByText(/대기 2번째/).first().waitFor();
  assert.equal(await results.getByRole('link',{name:'로그 JSON 다운로드',exact:true}).count(),1);
  assert(await results.getByRole('button',{name:'삭제',exact:true}).isDisabled());
  await results.getByRole('button',{name:'클립 1개',exact:true}).click();
  await results.getByText('교체',{exact:true}).waitFor();
  pass('Results show queue position, stored JSON and substitution label, and protect active jobs from deletion');
  await results.screenshot({path:output+'/queue-results.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
})().catch(error=>{errors.push(error.stack);console.error(error);process.exitCode=1;})
  .finally(async()=>{fs.writeFileSync(output+'/results.json',JSON.stringify({evidence,uploaded,errors,unexpected},null,2));await browser?.close();});
