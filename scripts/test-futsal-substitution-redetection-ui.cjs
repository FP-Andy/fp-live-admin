// Uses the local fixture server only. Human choices below are test inputs, not production decisions.
const {chromium}=require('../apps/web/node_modules/playwright-core'),assert=require('assert/strict'),fs=require('fs');
(async()=>{const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5452/preview',{waitUntil:'domcontentloaded'});
 await page.getByText(/재탐지 1개 구간의 후보를 함께/).waitFor({state:'attached',timeout:120000});
 const parent=page.locator('details').filter({has:page.locator(':scope > summary', {hasText:'선수 배정·교체 설정'})});
 if(!await parent.getAttribute('open'))await parent.locator(':scope > summary').click();
 const event=page.locator('.mr-sub-event').filter({has:page.locator('summary',{hasText:'07:56.745'})});
 if(await event.getAttribute('open')===null)await event.locator('summary').click();
 await event.getByRole('button',{name:'나간 선수 기존 추적 · TRACK #5296 선택',exact:true}).click();
 await event.getByRole('button',{name:'들어온 선수 재탐지 · TRACK #6585 선택',exact:true}).click();
 await event.getByText('기존 #5의 기록을 종료하고, 들어온 선수는 새 분석번호로 분리합니다.',{exact:true}).waitFor();
 assert.equal(await event.getByLabel('퇴장한 분석번호').count(),0,'outgoing number comes from trajectory, not the reviewer');
 await event.getByRole('button',{name:'장면 크게 보기'}).last().click();
 const dialog=page.getByRole('dialog',{name:'교체 후보 장면'});await dialog.waitFor();
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('[role=dialog] img')).every(i=>i.complete&&i.naturalWidth>0));
 await page.screenshot({path:'/tmp/substitution-redetection-scene.png'});await dialog.getByRole('button',{name:'닫기',exact:true}).click();
 await event.getByRole('button',{name:'이 연결 확인 · 리포트 갱신',exact:true}).click();
 await event.locator('summary').filter({hasText:'연결 확인됨'}).waitFor({timeout:120000});
 const api='/api/futsal/fla-video/matches/72adc60a-b83a-5ec9-8938-86986607ace8';const response=await page.request.get('http://127.0.0.1:5452'+api),saved=(await response.json()).substitutions;
 const decision=saved.log.substitutions.find(e=>Math.abs(e.time-476.745)<.02).tracking;assert(decision.redetectionId);assert.equal(decision.inTrackId,6585);
 await page.reload({waitUntil:'domcontentloaded'});await page.getByText(/재탐지 1개 구간의 후보를 함께/).waitFor({state:'attached',timeout:120000});
 await page.locator('.mr-sub-event summary').filter({hasText:'07:56.745'}).filter({hasText:'연결 확인됨'}).waitFor({state:'attached',timeout:120000});
 assert.equal((await(await page.request.get('http://127.0.0.1:5452'+api)).json()).substitutions.revision,saved.revision);
 assert.deepEqual(errors,[]);console.log('PASS: real pilot candidates, framed photo, manual pinned selection, revision/reload persistence, partial-trajectory state.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
