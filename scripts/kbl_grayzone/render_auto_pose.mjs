// Private server-side browser for the existing 2D/3D capture path. The browser
// never reaches the public network and receives no credentials or batch key.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const input=JSON.parse(await new Promise((resolve,reject)=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{s+=d;if(s.length>8192)reject(Error('invalid input'));});process.stdin.on('end',()=>resolve(s));process.stdin.on('error',reject);}));
const {caseId,eventId,key,socketPath,port}=input;
if(!/^[a-z0-9-]+$/.test(caseId)||!/^review-[0-9]+$/.test(eventId)||!/^[-_a-zA-Z0-9]{32,128}$/.test(key))throw Error('invalid preparation request');
if(socketPath&&(!path.isAbsolute(socketPath)||socketPath.includes('\0')))throw Error('invalid worker socket');
if(!socketPath&&(!Number.isInteger(port)||port<1||port>65535))throw Error('invalid local worker port');
const require=createRequire(path.join(process.env.COURTSIDE_PLAYWRIGHT_ROOT||path.join(root,'apps/web'),'package.json'));
const {chromium}=require('playwright-core');
const token=randomUUID(),workPath=`/api/cases/${caseId}/events/${eventId}`;
const html=`<!doctype html><meta charset="utf-8"><iframe id="scene" title="automatic preparation" style="width:1280px;height:900px;border:0"></iframe><script>
const token=${JSON.stringify(token)},caseId=${JSON.stringify(caseId)};
window.addEventListener('message',e=>{const f=document.getElementById('scene');if(e.origin!==location.origin||e.source!==f.contentWindow||e.data?.token!==token||e.data?.caseId!==caseId)return;
 if(e.data.type==='kbl-auto-pose-ready')f.contentWindow.postMessage({type:'kbl-auto-pose-start',token},location.origin);
 if(e.data.type==='kbl-auto-pose-complete'||e.data.type==='kbl-auto-pose-error')window.autoPoseResult=e.data;
});
document.getElementById('scene').src='/reconstruction.html?id='+encodeURIComponent(caseId)+'&autoPrepare='+encodeURIComponent(token)+'#'+${JSON.stringify(eventId)};
</script>`;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.method==='GET'&&url.pathname==='/__auto_pose_driver'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(html);}
 // The invisible server browser is not an operator and must not create usage logs.
 if(url.pathname===`/api/cases/${caseId}/work-sessions`){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{}');}
 const isSave=req.method==='POST'&&url.pathname===`${workPath}/reconstruction`&&url.searchParams.get('automatic')==='1';
 const isPose=req.method==='POST'&&url.pathname===`${workPath}/pose-variant-jobs`;
 if(!['GET','HEAD'].includes(req.method)&&!isSave&&!isPose){res.writeHead(403);return res.end();}
 const headers={host:'127.0.0.1',origin:'http://127.0.0.1'};
 for(const name of ['content-type','content-length','range','if-none-match','if-modified-since'])if(req.headers[name])headers[name]=req.headers[name];
 if(isSave)headers['x-courtside-auto-key']=key;
 const upstream=http.request({...(socketPath?{socketPath}:{hostname:'127.0.0.1',port}),method:req.method,path:req.url,headers},reply=>{
  const out={...reply.headers};delete out['connection'];delete out['transfer-encoding'];res.writeHead(reply.statusCode||502,out);reply.pipe(res);
 });
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('error',()=>upstream.destroy());req.pipe(upstream);
});
const home=await fs.mkdtemp(path.join(os.tmpdir(),'courtside-auto-browser-'));
let browser;
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.KBL_CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),
  args:['--disable-background-networking','--disable-dev-shm-usage','--enable-unsafe-swiftshader'],
  env:{...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache')}});
 const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1});
 await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await page.goto(base+'/__auto_pose_driver',{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.autoPoseResult,{timeout:30*60*1000});
 const result=await page.evaluate(()=>window.autoPoseResult);
 if(result.type!=='kbl-auto-pose-complete')throw Error(result.error||'자동 자세 보정에 실패했습니다.');
 if(result.caseId!==caseId||result.eventId!==eventId||! /^[a-f0-9]{24}$/.test(result.previousCaptureId||'')||! /^[a-f0-9]{24}$/.test(result.captureId||''))throw Error('자동 보정 결과를 확인할 수 없습니다.');
 process.stdout.write(JSON.stringify({previousCaptureId:result.previousCaptureId,captureId:result.captureId}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));await fs.rm(home,{recursive:true,force:true});}
