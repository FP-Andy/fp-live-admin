const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../apps/web/node_modules/playwright-core');
const origin=process.env.SNAPSHOT_TEST_ORIGIN||'http://127.0.0.1:4346';
const id='c'.repeat(32),jobId='a'.repeat(32);
const heat={schema:'fpa-heatmaps/v1',datasetId:'snapshot-test',video:'스냅샷 검증 예시',resultVersion:3,from:0,to:10,width:80,height:40,scale:8,players:[{id:'home-1',group:'home',jersey:'2',grid:Array.from({length:3200},(_,i)=>i===1600?8:0),positions:[{t:0,x:.5,y:.5,seconds:8}]}]};
const source={schema:'fpc-analysis-snapshot/v1',id,jobId,version:1,title:'스냅샷 검증 예시',createdAt:'2026-09-30T00:00:00Z',createdBy:'검수자',reviewVersion:7,resultVersion:3,meanCoverage:.8,minCoverage:.8,eventCount:1,matchId:null,matchName:'서울 vs 안양',homeName:'서울',awayName:'안양',roster:[{id:'home-1',name:'테스트 선수',position:'ALA'}],heatmap:heat,fpa:{rows:[{Team:'home',Player:'2',Action:'Shot',StartX:'32',StartY:'9',Direction:'right'}],logs:[]}};
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',r=>{const p=new URL(r.request().url()).pathname;let body={};if(p==='/api/session/me')body={id:'local',name:'test',role:'SUPERADMIN'};else if(p==='/api/futsal/analysis-snapshots')body={snapshots:[source]};else if(p==='/api/futsal/analysis-snapshots/'+id)body=source;else if(p==='/api/futsal/fla-video/fixtures')body={fixtures:[]};return r.fulfill({contentType:'application/json',body:JSON.stringify(body)});});
 await page.context().addCookies([{name:'live_admin_session',value:'local-test',url:origin}]);
 await page.goto(origin+'/admin/fcm/futsal/reports?snapshot='+id,{waitUntil:'networkidle'});
 await page.getByLabel('선수 이름',{exact:true}).waitFor();assert.equal(await page.getByLabel('선수 이름',{exact:true}).inputValue(),'테스트 선수');
 assert.equal(await page.getByLabel('포지션',{exact:true}).inputValue(),'ALA');
 assert.match(await page.locator('.mr-controls').innerText(),/연결된 볼 회수·슈팅 1건/);
 assert(await page.getByLabel('히트맵 좌표·품질 JSON',{exact:true}).isDisabled());
 await page.getByLabel('히트맵 코멘트',{exact:true}).fill('스냅샷의 관측 자료를 바탕으로 수정한 문구');
 await page.getByLabel('리포트 등번호',{exact:true}).fill('77');
 await page.getByText('이 브라우저에 저장됨',{exact:true}).waitFor();
 await page.reload({waitUntil:'networkidle'});assert.equal(await page.getByLabel('리포트 등번호',{exact:true}).inputValue(),'77');
 assert.equal(source.heatmap.players[0].jersey,'2');
 assert.match(await page.locator('.mr-sheet-footer').innerText(),/AI 기반 풋살 분석/);
 fs.mkdirSync('/tmp/analysis-snapshots-qa',{recursive:true});await page.screenshot({path:'/tmp/analysis-snapshots-qa/report.png'});
 // Run the real heatmap controller against a small synthetic dataset.
 const html=fs.readFileSync(path.join(__dirname,'../apps/web/public/fpa-cv/index.html'),'utf8');
 const section=html.match(/<section id="heatmap-workspace"[\s\S]*?<\/section>/)[0].replace(' hidden','');
 await page.route('**/snapshot-ui-fixture',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<meta charset="utf-8"><link rel="stylesheet" href="/fpa-cv/brand.css"><link rel="stylesheet" href="/fpa-cv/style.css">${section}`}));
 await page.goto(origin+'/snapshot-ui-fixture');
 let posted=null;await page.route('**/api/futsal/analysis-snapshots',async r=>{if(r.request().method()==='POST'){posted=r.request().postDataJSON();return r.fulfill({contentType:'application/json',body:JSON.stringify(source)});}return r.fulfill({contentType:'application/json',body:'{"snapshots":[]}'});});
 await page.evaluate(async()=>{
  const {heatmapUI}=await import('/fpa-cv/heatmap-ui.mjs');
  const data={datasetId:'test',video:{name:'test',clipStart:0,clipEnd:2},detector:{sampleFps:10,roi:[[0,0],[1,0],[1,1],[0,1]]},frames:Array.from({length:20},(_,i)=>({t:i/10,boxes:i<10?[{id:1,box:[.3,.3,.32,.4],confidence:.9}]:[]}))};
  const review={setup:{time:0},uniforms:{},roster:[{id:'home-1',jersey:'2',group:'home'}],segments:[{trackId:1,personId:'home-1',source:'manual',from:0,to:2}],events:[],batch:{round:2}};
  window.notices=[];window.fixtureUI=heatmapUI({getData:()=>data,getWorking:()=>review,getRecovery:()=>({status:'complete',issues:[],data}),prepareSnapshot:async()=>({jobId:'a'.repeat(32),reviewVersion:7}),message:m=>window.notices.push(m)});window.fixtureUI.open();
 });
 await page.locator('#heatmap-complete:enabled').waitFor();assert.equal(await page.locator('#heatmap-augmentation').inputValue(),'0.3');await page.locator('#heatmap-complete').click();
 assert(await page.locator('#analysis-complete-confirm').isDisabled());assert.match(await page.locator('#analysis-complete-summary').innerText(),/이벤트맵 비어 있음/);
 await page.locator('#analysis-complete-checked').check();await page.locator('#analysis-complete-confirm').click();
 await page.locator('#analysis-snapshot-link').waitFor();assert.equal(posted.reviewVersion,7);assert.equal(posted.confirmed,true);assert.equal(posted.heatmap.resultVersion,3);assert.equal(posted.heatmap.augmentation.targetRatio,.3);assert(Math.abs(posted.heatmap.players[0].augmentation.inferredSeconds-.6)<1e-6);assert(Math.abs(posted.heatmap.players[0].coverage-.5)<1e-6);
 assert.match(await page.locator('#analysis-snapshot-link').getAttribute('href'),new RegExp('snapshot='+id));
 await page.locator('#heatmap-complete').click();await page.screenshot({path:'/tmp/analysis-snapshots-qa/completion.png'});
 await page.evaluate(()=>window.fixtureUI.invalidate());assert(await page.locator('#heatmap-complete').isDisabled());assert.equal(await page.locator('#analysis-complete-dialog').evaluate(n=>n.open),false);
 // Import the exact completed map into FCM: report uses display coverage,
 // while observed statistics stay at 50% and saved density is retained.
 source.heatmap=posted.heatmap;
 await page.goto(origin+'/admin/fcm/futsal/reports?snapshot='+id,{waitUntil:'networkidle'});
 await page.getByLabel('선수 이름',{exact:true}).waitFor();
 assert.match(await page.locator('.mr-map-panel small').first().innerText(),/히트맵 반영률 80.0%/);
 assert.doesNotMatch(await page.locator('.mr-sheet').innerText(),/유효 관측|보강|추정/);
 await page.screenshot({path:'/tmp/analysis-snapshots-qa/augmented-report.png'});
 const pdfPromise=page.waitForEvent('download');
 await page.getByRole('button',{name:'A4 PDF 다운로드',exact:true}).click();
 const pdf=await pdfPromise;await pdf.saveAs('/tmp/analysis-snapshots-qa/augmented-report.pdf');
 const {PDFDocument}=require('../apps/web/node_modules/pdf-lib');
 const pdfDoc=await PDFDocument.load(fs.readFileSync('/tmp/analysis-snapshots-qa/augmented-report.pdf'));
 assert.equal(pdfDoc.getPageCount(),1);
 assert(Math.abs(pdfDoc.getPage(0).getWidth()-595.28)<1);
 assert.deepEqual(errors,[]);console.log('PASS: immutable snapshot import, editable report copy and reload, frozen map sources, explicit approval, empty-event disclosure, versioned save and invalidation.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
