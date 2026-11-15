// Browser contract for the FPC preview, with synthetic media and no real data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_CORE_PATH || '../apps/web/node_modules/playwright-core');

const root=path.resolve(__dirname,'../apps/web/public/kbl-grayzone');
const match='00000000-0000-4000-8000-000000000001';
const session='00000000-0000-4000-8000-000000000002';
const intake='a'.repeat(24), file='take-00001-part-000000.mp4';
const bridge=`/api/courtside/matches/${match}/intakes/${intake}/bridge`;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'courtside-wide-qa-'));
const movie=process.env.COURTSIDE_QA_VIDEO || path.join(temp,'preview.mp4');
if(!process.env.COURTSIDE_QA_VIDEO)execFileSync('ffmpeg',['-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x180:r=10',
  '-t','1','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',movie]);
let listings=0,prepared=0,legacyRequests=0,failList=false,browser;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture');
 if(url.pathname.endsWith('/fixture.html')){
  res.setHeader('Content-Type','text/html');
  return res.end(`<!doctype html><html data-console-theme="dark"><head><link rel="stylesheet" href="/static/workflow.css"><link rel="stylesheet" href="/static/courtside-ui.css"></head><body><main><div id="host"></div></main><script type="module">import {isFpcReviewPath,mountFpcRecordingRelay} from '/static/fpc-recording-relay.mjs';window.isFpc=isFpcReviewPath(location.pathname);window.relay=mountFpcRecordingRelay(document.querySelector('#host'),{intakeId:'${intake}',inline:true,onPrepared:()=>{window.prepared=true}});window.relay.load();</script></body></html>`);
 }
 if(url.pathname.startsWith('/static/')){
  const name=url.pathname.slice('/static/'.length);
  if(!['workflow.css','courtside-ui.css','fpc-recording-relay.mjs'].includes(name)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');return res.end(fs.readFileSync(path.join(root,name)));
 }
 if(url.pathname.startsWith(bridge+'/api/')){
  const part=url.pathname.slice(bridge.length);
  if(part.startsWith('/api/library/'))legacyRequests++;
  res.setHeader('Content-Type','application/json');
  if(part===`/api/intake/${intake}`)return res.end(JSON.stringify({id:intake,libraryMatchId:`fpc-${match}`,status:'selected',events:[{id:'review-1',number:1,quarter:1,gameClock:'1:00',candidates:[]}],media:[{id:'0',name:'test.mp4'}],case:{home:'A',away:'B',date:'2026-11-13'},warnings:[]}));
  if(part==='/api/referees'||part===`/api/intake/${intake}/referees`)return res.end(JSON.stringify({catalogue:[],referees:[],version:'fixture'}));
  res.writeHead(404);return res.end(JSON.stringify({error:'fixture endpoint missing'}));
 }
 if(url.pathname.startsWith(bridge+'/')){
  const name=url.pathname.slice(bridge.length+1);
  if(!/^[A-Za-z0-9_.-]+\.(html|mjs|css)$/.test(name)){res.writeHead(404);return res.end();}
  try{
   let body=fs.readFileSync(path.join(root,name),'utf8');
   // The deployed bridge rewrites root-relative workbench URLs in assets.
   body=body.replace(/(["'`])\/(?=api\/|case-|pose-assets\/|wide-source\/|workflow\.html)/g,(_,quote)=>quote+bridge+'/');
   res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript');return res.end(body);
  }catch{res.writeHead(404);return res.end();}
 }
 if(url.pathname===`/api/courtside/matches/${match}/recording-parts`){
  listings++;
  if(failList){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({detail:'녹화 목록을 확인하세요.'}));}
  res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({recordings:[{id:session,created_at:'2026-11-13T09:25:46Z',parts:[{number:1,sourcePartName:file,duration:1},{number:2,sourcePartName:'take-00001-part-000001.mp4',duration:1}]}]}));
 }
 if(url.pathname===`/api/recordings/matches/${match}/${session}/files/0`){
  const data=fs.readFileSync(movie),range=req.headers.range;
  if(range){const found=/bytes=(\d+)-(\d*)/.exec(range),start=Number(found[1]),end=found[2]?Number(found[2]):data.length-1;res.writeHead(206,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${data.length}`,'Content-Length':end-start+1});return res.end(data.subarray(start,end+1));}
  res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':data.length,'Accept-Ranges':'bytes'});return res.end(data);
 }
 if(req.method==='POST' && url.pathname===`/api/courtside/matches/${match}/intakes/${intake}/recording-sessions/${session}/parts/${file}/prepare`){prepared++;res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({status:'stored-unpaired'}));}
 res.writeHead(404);res.end();
});

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':chromium.executablePath())});
 const page=await browser.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}/api/courtside/matches/${match}/intakes/${intake}/bridge/fixture.html`);
 await page.waitForFunction(()=>window.isFpc && document.querySelector('[data-relay="part"]')?.options.length===3);
 assert.equal(listings,1);
 assert.equal(await page.locator('[data-relay="session"]').inputValue(),session);
 assert.match(await page.locator('[data-relay="part"] option').nth(2).textContent(),/원본 누적 0:01부터/);
 assert.equal(await page.locator('.relay-panel').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(32, 36, 45)');
 if(process.env.COURTSIDE_QA_SCREENSHOT)await page.screenshot({path:process.env.COURTSIDE_QA_SCREENSHOT});
 await page.evaluate(()=>{document.documentElement.dataset.consoleTheme='light';});
 assert.equal(await page.locator('.relay-panel').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(250, 251, 254)');
 await page.evaluate(()=>{document.documentElement.dataset.consoleTheme='dark';});
 await page.locator('[data-relay="part"]').selectOption(file);
 await page.getByRole('button',{name:'선택 구간 미리보기'}).click();
 await page.waitForFunction(()=>{const v=document.querySelector('[data-relay="video"]');return v.readyState>=2 && v.videoWidth===320;});
 await page.getByRole('button',{name:'선택 구간 작업에 사용'}).click();
 await page.waitForFunction(()=>window.prepared===true);
 assert.equal(prepared,1);
 assert.match(await page.locator('[data-relay="status"]').textContent(),/구간|조각/);
 failList=true;await page.getByRole('button',{name:'녹화 목록 새로고침'}).click();
 await page.waitForFunction(()=>document.querySelector('[data-relay="status"]').textContent.includes('녹화 목록을 확인하세요.'));
 // Load the actual workflow through the match-scoped bridge path: the legacy
 // local preparation UI must not make unavailable FPC catalogue requests.
 failList=false;
 await page.goto(`http://127.0.0.1:${server.address().port}${bridge}/workflow.html?intake=${intake}`);
 await page.waitForFunction(()=>!document.querySelector('#widePreparationPanel').hidden && document.querySelector('#workflowWide .relay-panel'));
 await page.locator('#widePreparationPanel summary').click();
 await page.waitForFunction(()=>document.querySelector('#workflowWide [data-relay="part"]')?.options.length===3);
 assert.equal(legacyRequests,0);
 assert.equal(await page.locator('#fpcRecordingRelay .relay-panel').count(),0);
 assert.equal(await page.getByText('FPC 경기 연결 변경').count(),0);
 console.log('Wide preview dark theme, recording list, video, prepare and failure handling passed');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();fs.rmSync(temp,{recursive:true,force:true});});
