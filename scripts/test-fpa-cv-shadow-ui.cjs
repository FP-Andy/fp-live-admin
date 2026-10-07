const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||'../apps/web/node_modules/playwright-core');
const root=path.join(__dirname,'../apps/web/public/fpa-cv');
(async()=>{const server=http.createServer((req,res)=>{try{const p=new URL(req.url,'http://localhost').pathname;const file=path.join(root,p==='/'?'index.html':p);let body=fs.readFileSync(file);if(p==='/')body=body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');res.setHeader('Content-Type',p.endsWith('.mjs')?'text/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});try{
const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
await page.evaluate(async()=>{
const {setupUI}=await import('/setup-ui.mjs'),{emptyReview}=await import('/core.mjs');
const data={datasetId:'fixture',video:{clipStart:0,clipEnd:1,width:1000,height:1000},detector:{sampleFps:15},tracks:[{id:1,first:0,last:.6}],frames:[{t:0,boxes:[{id:1,box:[.1,.2,.2,.3]}]}]};
window.review=emptyReview(data);window.commits=0;review.roster.find(p=>p.id==='away-2').jersey='3';
const segment={trackId:1,personId:'away-2',team:'away',group:'away',jersey:'3',source:'auto',mode:'body-representative',from:0,to:.6,previousTrack:2,time:0,gap:0,uniform:'away'};
const recovery={status:'complete',segments:[segment],suggestions:[],warnings:[],masks:[],duplicates:[],issues:[]};
const ui=setupUI({getData:()=>data,getReview:()=>review,getWorking:()=>review,getRecovery:()=>recovery,commit:v=>{window.review=v;window.commits++;},seek:()=>{},time:()=>0,selectTrack:()=>{},message:()=>{},video:document.querySelector('video')});
document.getElementById('reconnect-panel').open=true;ui.configuration();
});
assert.match(await page.locator('#reconnect-list').textContent(),/몸·그림자 중복에서 몸 박스로 번호 승계/);assert.doesNotMatch(await page.locator('#reconnect-list').textContent(),/NaN|undefined/);
await page.locator('#shadow-correction').evaluate(el=>el.click());assert.equal(await page.evaluate(()=>review.shadowCorrection),true);assert.equal(await page.evaluate(()=>commits),1);
await page.locator('#shadow-correction').evaluate(el=>el.click());assert.equal(await page.evaluate(()=>review.shadowCorrection),false);assert.deepEqual(errors,[]);
console.log('PASS: real setup UI renders transferred identities without fictitious scores; option toggles and saves both directions.');
}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
