// Browser test for CSV review, staging, and explicit save using fixture APIs.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH || '../apps/web/node_modules/playwright-core');
const root=path.resolve(__dirname,'../apps/web/public/kbl-grayzone');
const baseFields={focus:'기존 지점',observation:'',difficultyFactors:'',viewComment:'기존 시야',initialCall:'',decisionBasis:'',takeaway:'',assessment:'기존 총평',callerBasis:'중계 확인',callerNumber:37};
const events=[1,2].map(n=>({id:`review-${n}`,number:n,quarter:1,gameClock:`${n}:00`,ready:true,captureId:`capture-${n}`,recordedDecision:'유지',recordedReason:'파울 유지',fields:{...baseFields},refereeAssignments:{r1:37},referees:[{id:'r1',label:'R1',image:'/fixture.jpg'}],map:'/fixture.jpg',warnings:[],delivery:{referees:1,matchedReferees:1}}));
let editorial={caseId:'game-test',revision:1,recordsVersion:'rec1',version:'v1',referees:[{number:37,name:'심판'}],events,limits:{focus:130,observation:160,difficultyFactors:160,viewComment:180,initialCall:100,decisionBasis:140,takeaway:120,assessment:520,callerBasis:120}};
let saves=[];
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://fixture');
 if(u.pathname==='/review-flow.mjs'){res.setHeader('Content-Type','text/javascript');return res.end(`export const flowUrl=()=> '#';export function mountFlow(){return {update(){},async refresh(){return {title:'테스트 경기',revision:1,reportReady:true,events:[1,2].map(n=>({id:'review-'+n,number:n,quarter:1,gameClock:n+':00',nextStage:'report',stages:{objects:{complete:true},joints:{complete:true},spatial:{complete:true}}}))}}}}`);}
 if(u.pathname==='/report-video-box.mjs'){res.setHeader('Content-Type','text/javascript');return res.end('export function mountReportVideoBox(){return {restore(){},canGenerate(){return true},selected(){return false}}}');}
 if(u.pathname==='/report-download.mjs'){res.setHeader('Content-Type','text/javascript');return res.end('export function bindReportDownload(){}');}
 if(u.pathname==='/task-feedback.mjs'){res.setHeader('Content-Type','text/javascript');return res.end('');}
 if(u.pathname==='/api/cases/game-test/report-editorial'){
  res.setHeader('Content-Type','application/json');if(req.method==='GET')return res.end(JSON.stringify(editorial));
  let body='';req.on('data',x=>body+=x);return req.on('end',()=>{const value=JSON.parse(body);saves.push(value);for(const update of value.events){const e=editorial.events.find(e=>e.id===update.id);e.fields={...update.fields};e.refereeAssignments={...update.fields.refereeAssignments};}editorial={...editorial,version:'v2'};res.end(JSON.stringify(editorial));});
 }
 if(u.pathname==='/api/cases/game-test/reports'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({versions:[]}));}
 if(u.pathname==='/fixture.jpg'){res.writeHead(404);return res.end();}
 if(u.pathname==='/assets/referee-roster.jpg'){res.setHeader('Content-Type','image/jpeg');return res.end(fs.readFileSync(path.join(root,'assets/referee-roster.jpg')));}
 const name=u.pathname.slice(1);if(!/^[a-zA-Z0-9_.-]+\.(html|mjs|css)$/.test(name)){res.writeHead(404);return res.end();}
 try{const file=fs.readFileSync(path.join(root,name));res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript');return res.end(file);}catch{res.writeHead(404);return res.end();}
});

const headers=['case_id','event_id','capture_id','case_revision','records_version','editorial_version','focus','observation','difficultyFactors','viewComment','initialCall','decisionBasis','takeaway','assessment'];
const csv=rows=>'\uFEFF'+[headers,...rows.map(r=>headers.map(k=>r[k]??''))].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
const row=(n,more={})=>({case_id:'game-test',event_id:`review-${n}`,capture_id:`capture-${n}`,case_revision:'1',records_version:'rec1',editorial_version:'v1',...more});
let browser;
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const executablePath=process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':fs.existsSync('/opt/google/chrome/chrome')?'/opt/google/chrome/chrome':chromium.executablePath());
 browser=await chromium.launch({headless:true,executablePath});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/report-review.html?id=game-test`);
 await page.waitForFunction(()=>document.querySelector('#eventSelect').options.length===2);
 await page.evaluate(()=>{document.documentElement.dataset.consoleTheme='dark';});
 assert.equal(await page.locator('.referee-reference').evaluate(e=>e.open),false);
 await page.locator('.referee-reference summary').click();
 await page.waitForFunction(()=>document.querySelector('.referee-reference img').naturalWidth>0);
 assert.equal(await page.locator('#refereeCards select').inputValue(),'37');
 assert.notEqual(await page.locator('.referee-reference').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
 if(process.env.COURTSIDE_REFEREE_SCREENSHOT)await page.locator('.report-visuals').screenshot({path:process.env.COURTSIDE_REFEREE_SCREENSHOT});
 await page.locator('.referee-reference summary').click();
 assert.equal(await page.locator('.referee-reference').evaluate(e=>e.open),false);
 await page.locator('.report-map summary').click();
 await page.waitForFunction(()=>!document.querySelector('#mapError').hidden);
 assert.equal(await page.locator('#mapPreview').isVisible(),false);
 const select=content=>page.locator('#commentCsv').setInputFiles({name:'comments.csv',mimeType:'text/csv',buffer:Buffer.from(content)});
 await select(csv([row(1,{case_id:'game-other',focus:'잘못된 경기'})]));
 await page.waitForFunction(()=>document.querySelector('#commentImportNote').textContent.includes('다른 경기'));
 assert.equal(await page.locator('#focus').inputValue(),'기존 지점');assert.equal(saves.length,0);
 await select(csv([row(1,{focus:'새 지점',assessment:'첫 문장, "인용"\n둘째 문장'}),row(2,{viewComment:'다른 장면 시야'})]));
 await page.waitForFunction(()=>!document.querySelector('#commentImportPreview').hidden);
 assert.match(await page.locator('#commentImportChanges').innerText(),/기존: 기존 지점/);
 assert.match(await page.locator('#commentImportChanges').innerText(),/가져올 문안: 새 지점/);
 assert.equal(await page.locator('#focus').inputValue(),'기존 지점');assert.equal(saves.length,0);
 const dark=await page.locator('.comment-import-diff').first().evaluate(e=>getComputedStyle(e).backgroundColor);
 assert.notEqual(dark,'rgb(255, 255, 255)');
 if(process.env.COURTSIDE_CSV_SCREENSHOT)await page.locator('.comment-import').screenshot({path:process.env.COURTSIDE_CSV_SCREENSHOT});
 await page.evaluate(()=>{document.documentElement.dataset.consoleTheme='light';});
 assert.notEqual(await page.locator('.comment-import-diff').first().evaluate(e=>getComputedStyle(e).backgroundColor),dark);
 await page.evaluate(()=>{document.documentElement.dataset.consoleTheme='dark';});
 await page.locator('#commentImportApply').click();
 assert.equal(await page.locator('#focus').inputValue(),'새 지점');assert.equal(await page.locator('#assessment').inputValue(),'첫 문장, "인용"\n둘째 문장');
 assert.equal(saves.length,0);assert.equal(await page.locator('#saveAll').isEnabled(),true);
 await page.locator('#eventSelect').selectOption('review-2');assert.equal(await page.locator('#viewComment').inputValue(),'다른 장면 시야');
 await page.locator('#saveAll').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('저장했습니다'));
 assert.equal(saves.length,1);assert.equal(saves[0].events.length,2);
 for(const e of saves[0].events){assert.equal(e.fields.callerNumber,37);assert.deepEqual(e.fields.refereeAssignments,{r1:37});assert.equal(e.fields.callerBasis,'중계 확인');}
 await select(csv([row(1,{focus:'버전 변경 후 새 문안'})]));await page.waitForFunction(()=>!document.querySelector('#commentImportPreview').hidden);
 assert.match(await page.locator('#commentImportWarning').innerText(),/변경됐습니다/);
 await page.locator('#commentImportCancel').click();assert.equal(saves.length,1);assert.deepEqual(errors,[]);
 console.log('Comment CSV browser review, save, identity preservation and dark theme passed');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
