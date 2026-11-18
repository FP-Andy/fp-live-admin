const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../apps/web/public/kbl-grayzone');
const playwright=require(process.env.COURTSIDE_TEST_PLAYWRIGHT||path.resolve(__dirname,'../apps/web/node_modules/playwright-core'));
const fixture=`<script type="module">
import {mountWideReference} from './wide-reference.mjs';
window.fetch=async url=>String(url).endsWith('/sequence')?new Response('{}',{status:404}):new Response(JSON.stringify({version:'v',sources:[],reference:{image:'/fixture-wide.svg',sha256:'test'},referees:[{number:8,name:'심판'}],supplementalReferees:[],broadcastRefereeCount:2,identities:{}}),{headers:{'Content-Type':'application/json'}});
mountWideReference(document.getElementById('wideReferencePanel'),{caseId:'game-test',eventId:'review-1'});
</script>`;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://127.0.0.1').pathname;
 if(pathname==='/fixture-wide.svg'){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="navy"/></svg>');}
 const file=path.resolve(root,'.'+decodeURIComponent(pathname));
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
 const ext=path.extname(file);res.setHeader('Content-Type',({'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[ext]||'application/octet-stream');
 let data=fs.readFileSync(file);
 if(pathname==='/reconstruction.html')data=Buffer.from(data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>',fixture+'</body>'));
 res.end(data);
});
(async()=>{let browser;try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await playwright.chromium.launch({headless:true,...(process.env.COURTSIDE_TEST_CHROME?{executablePath:process.env.COURTSIDE_TEST_CHROME}:{channel:'chrome'})});
 const page=await browser.newPage({viewport:{width:1440,height:1200}});
 await page.goto(`http://127.0.0.1:${server.address().port}/reconstruction.html?id=game-test#review-1`);
 await page.waitForFunction(()=>document.querySelector('[data-w=image]')?.width===320);
 assert.equal(await page.locator('[data-w=sources], [data-w=video], [data-w=capture]').count(),0);
 assert.equal(await page.locator('[data-w=note]').getAttribute('type'),'hidden');
 assert.equal(await page.locator('#wideReferencePanel details').first().getAttribute('open'),'');
 const source=await page.locator('#source').boundingBox(),wide=await page.locator('[data-w=image]').boundingBox(),map=await page.locator('#map').boundingBox();
 assert.ok(source&&wide&&map&&wide.y>=source.y+source.height,'광각 화면은 중계 아래에 위치해야 합니다.');
 assert.ok(wide.x<map.x,'2D 코트와 분리된 중계 열에 있어야 합니다.');
 if(process.env.COURTSIDE_TEST_SCREENSHOT)await page.screenshot({path:process.env.COURTSIDE_TEST_SCREENSHOT,fullPage:false});
 console.log('The confirmed wide frame appears under broadcast without a second video selection.');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
