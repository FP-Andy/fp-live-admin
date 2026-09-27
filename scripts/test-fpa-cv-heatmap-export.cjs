const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require(process.env.FPA_CV_PLAYWRIGHT_PATH||'../apps/web/node_modules/playwright-core');
const root=path.resolve(__dirname,'../apps/web/public/fpa-cv');
const output=process.env.FPA_CV_EXPORT_QA_DIR;
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/style.css"></head><body style="padding:20px"><select id="heatmap-point"><option value="bottom">하단</option></select><select id="heatmap-turn"><option value="0">기본</option></select><input type="checkbox" id="heatmap-manual"><button id="heatmap-build">히트맵 만들기</button><button id="heatmap-report">10명 PNG 저장</button><button id="heatmap-json">좌표·품질 JSON</button><p id="heatmap-status"></p><div id="heatmap-cards"></div><script type="module">
import {heatmapUI} from '/heatmap-ui.mjs';
import {emptyReview} from '/core.mjs';
// Export must never paint identity/quality text into the artwork.
CanvasRenderingContext2D.prototype.fillText=CanvasRenderingContext2D.prototype.strokeText=()=>{throw Error('Text leaked into PNG');};
const data={datasetId:'export-test',video:{name:'fixture',clipStart:0,clipEnd:2},detector:{sampleFps:10,roi:[[0,0],[1,0],[1,1],[0,1]]},frames:Array.from({length:20},(_,i)=>({t:i/10,boxes:[{id:1,box:[.27,.2,.29,.25],confidence:.9}]}))};
const review={...emptyReview(data),setup:{time:0},segments:[{trackId:1,personId:'home-1',team:'home',source:'manual',from:0,to:2}]};
review.roster=review.roster.map(p=>({...p,jersey:p.group==='referee'?'REF':p.group.endsWith('_gk')?'1':String(Number(p.id.split('-')[1])+1)}));
heatmapUI({getData:()=>data,getWorking:()=>review,getRecovery:()=>({status:'complete',issues:[],data}),message:text=>{throw Error(text);}}).open();
</script></body></html>`;
(async()=>{
 const server=http.createServer(async(req,res)=>{
  try{
   const pathname=new URL(req.url,'http://localhost').pathname;
   if(pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
   const target=path.resolve(root,'.'+pathname);
   if(!target.startsWith(root+path.sep)){res.writeHead(404);res.end();return;}
   res.setHeader('Content-Type',target.endsWith('.mjs')?'text/javascript':target.endsWith('.css')?'text/css':'application/octet-stream');
   res.end(await fs.readFile(target));
  }catch{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#heatmap-cards article').nth(9).waitFor();
  assert.equal(await page.locator('.heatmap-player').first().innerText(),'홈 #2','Player identity stays outside the artwork');
  assert.match(await page.locator('.heatmap-quality').first().innerText(),/유효/);
  const sizes=await page.locator('#heatmap-cards canvas').evaluateAll(items=>items.map(c=>[c.width,c.height]));
  assert(sizes.every(([w,h])=>w===660&&h===360),'Preview has only the court and its surround, no text margins');
  const pngInfo=async download=>{
   const bytes=await fs.readFile(await download.path());
   const info=await page.evaluate(async dataURL=>{
    const image=new Image();image.src=dataURL;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
    const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
    return {width:c.width,height:c.height};
   },'data:image/png;base64,'+bytes.toString('base64'));
   return {bytes,...info};
  };
  const downloadButton=async selector=>{const pending=page.waitForEvent('download');await page.locator(selector).click();return pending;};
  const individual=await downloadButton('#heatmap-cards article:first-child button');
  assert.equal(individual.suggestedFilename(),'queens-cup-home-2-heatmap.png');
  const single=await pngInfo(individual);assert.deepEqual([single.width,single.height],[1320,720]);
  const report=await downloadButton('#heatmap-report'),combined=await pngInfo(report);
  assert.deepEqual([combined.width,combined.height],[2640,3600]);
  assert.equal(report.suggestedFilename(),'queens-cup-10-player-heatmaps.png');
  const blank=await downloadButton('#heatmap-cards article:nth-child(2) button');
  const pixels=await page.evaluate(async uri=>{
   const image=new Image();image.src=uri;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
   const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const at=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
   return {outside:at(10,10),field:at(300,200),line:at(660,200),penalty:at(240,350),corner:at(60,400)};
  },'data:image/png;base64,'+(await fs.readFile(await blank.path())).toString('base64'));
  assert.deepEqual(pixels.outside,[239,202,222,255]);assert.deepEqual(pixels.field,[255,255,255,255]);
  for(const key of ['line','penalty','corner'])assert.deepEqual(pixels[key],[225,98,167,255],key+' uses exact Queens Cup line colour');
  // Repainting another player or exporting an atlas cannot change the common
  // density scale or leak text into the individual PNG.
  const again=await downloadButton('#heatmap-cards article:first-child button');
  assert((await fs.readFile(await again.path())).equals(single.bytes));
  if(output){await fs.mkdir(output,{recursive:true});await individual.saveAs(path.join(output,'individual.png'));await report.saveAs(path.join(output,'ten-player.png'));await page.screenshot({path:path.join(output,'screen.png'),fullPage:true});}
  if(process.env.FPA_CV_HEATMAP_JSON&&process.env.FPA_CV_SAMPLE_PNG){
   const result=JSON.parse(await fs.readFile(process.env.FPA_CV_HEATMAP_JSON,'utf8'));
   const compact={width:result.width,height:result.height,scale:result.scale,players:result.players.map(p=>({group:p.group,jersey:p.jersey,grid:p.grid}))};
   const dataURL=await page.evaluate(async result=>{const {paintHeatmap}=await import('/heatmap-render.mjs');const canvas=document.createElement('canvas');canvas.width=1320;paintHeatmap(canvas,result,result.players[0]);return canvas.toDataURL('image/png');},compact);
   await fs.writeFile(process.env.FPA_CV_SAMPLE_PNG,Buffer.from(dataURL.split(',')[1],'base64'));
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: actual individual and 10-player PNG downloads; exact white/pink palette; court-only dimensions; no raster text; metadata retained on screen; repeat exports preserve density.');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
