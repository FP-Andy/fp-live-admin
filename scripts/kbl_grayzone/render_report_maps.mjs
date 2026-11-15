// Presentation-only map refresh. Saved coordinates, meshes and nine-ray results
// are verified before drawing the same full canvas used by Step 3.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildCoverage} from './report_coverage.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(process.env.COURTSIDE_PLAYWRIGHT_ROOT || path.join(root,'apps/web'),'package.json'));
const {chromium}=require('playwright-core');
const publicRoot=path.join(root,'apps/web/public/kbl-grayzone');
const jobs=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const executablePath=process.env.KBL_CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
const browser=await chromium.launch({headless:true,executablePath,args:['--disable-gpu','--renderer-process-limit=1']});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!=='http://kbl-report.local')return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><style>@font-face{font-family:"KBL Jump";src:url(/fonts/KBLJump_R.woff2)}@font-face{font-family:"KBL Jump";font-weight:700;src:url(/fonts/KBLJump_B.woff2)}</style><canvas id="map" width="1280" height="800"></canvas>'});
  const file=path.resolve(publicRoot,'.'+decodeURIComponent(url.pathname));
  if(!file.startsWith(publicRoot+path.sep))return route.abort();
  try{
   const contentType=({'.mjs':'text/javascript','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream';
   await route.fulfill({contentType,body:await fs.readFile(file)});
  }catch{return route.abort();}
 });
 await page.goto('http://kbl-report.local/');
 await page.evaluate(async()=>{
  await document.fonts.load('18px "KBL Jump"');await document.fonts.load('bold 18px "KBL Jump"');
  await (await import('/court-asset.mjs')).loadCourtAsset();
 });
 for(const job of jobs){
  const model=buildCoverage(job.snapshot);
  const data=await page.evaluate(async({model,snapshot,home,away})=>{
   const {drawSceneMap}=await import('/scene-map.mjs');
   const a=snapshot.crewAnalysis;
   drawSceneMap(document.getElementById('map'),model,null,{home,away},{observers:model.observers,cells:model.cells,complete:a.crewComplete&&a.sceneComplete&&!a.qualityWarnings?.length});
   return document.getElementById('map').toDataURL('image/png').split(',')[1];
  },{model,...job});
  const temporary=job.output+'.'+process.pid+'.tmp';
  await fs.writeFile(temporary,Buffer.from(data,'base64'));await fs.rename(temporary,job.output);
 }
}finally{await browser.close();}
