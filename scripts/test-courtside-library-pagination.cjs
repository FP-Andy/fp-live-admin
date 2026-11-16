// Browser contract using synthetic matches and fixture APIs only.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH || '../apps/web/node_modules/playwright-core');
const root=path.resolve(__dirname,'../apps/web/public/kbl-grayzone');
const matches=Array.from({length:125},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,name:i===124?'원주 DB vs 서울 삼성':`테스트 경기 ${String(i+1).padStart(3,'0')}`,archived:i===124,metadata:{match_date:'2026-11-13'}}));
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://fixture');
 if(u.pathname==='/api/matches/page'){
  const q=(u.searchParams.get('q')||'').replaceAll(' ','').toLowerCase();
  const rows=matches.filter(m=>m.name.replaceAll(' ','').toLowerCase().includes(q));
  const offset=Number(u.searchParams.get('offset')),limit=Number(u.searchParams.get('limit'));
  assert.equal(limit,10);res.setHeader('content-type','application/json');
  return setTimeout(()=>res.end(JSON.stringify({items:rows.slice(offset,offset+limit),total:rows.length})),q==='느린검색'?500:0);
 }
 if(u.pathname.startsWith('/api/')){res.setHeader('content-type','application/json');return res.end(JSON.stringify({cases:[],recordings:[]}));}
 const name=u.pathname.slice(1);if(!/^[a-zA-Z0-9_.-]+\.(html|mjs|css)$/.test(name)){res.writeHead(404);return res.end();}
 try{const file=fs.readFileSync(path.join(root,name));res.setHeader('content-type',name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript');return res.end(file);}catch{res.writeHead(404);return res.end();}
});
let browser;
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const executablePath=process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':fs.existsSync('/opt/google/chrome/chrome')?'/opt/google/chrome/chrome':chromium.executablePath());
 browser=await chromium.launch({headless:true,executablePath});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/fpc-library.html`);
 await page.waitForFunction(()=>document.querySelectorAll('.match-row').length===10);
 assert.equal(await page.locator('#matchCount').textContent(),'125');
 assert.match(await page.locator('.match-row').first().innerText(),/001/);
 assert.equal(await page.locator('#matchPagination [aria-current=page]').textContent(),'1');
 await page.getByRole('button',{name:'다음 →'}).click();
 await page.waitForFunction(()=>document.querySelector('#matchPagination [aria-current=page]')?.textContent==='2');
 assert.match(await page.locator('.match-row').first().innerText(),/011/);
 await page.getByRole('button',{name:'5',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#matchPagination [aria-current=page]')?.textContent==='5');
 await page.getByRole('button',{name:'다음 →'}).click();
 await page.waitForFunction(()=>document.querySelector('#matchPagination [aria-current=page]')?.textContent==='6');
 assert.equal(await page.getByRole('button',{name:'10',exact:true}).count(),1);
 await page.locator('#matchSearch').fill('서울삼성');
 await page.waitForFunction(()=>document.querySelector('#matchCount').textContent==='1');
 assert.equal(await page.locator('.match-row').count(),1);
 assert.match(await page.locator('.match-row').innerText(),/서울 삼성/);
 assert.match(await page.locator('.match-row').innerText(),/보관된 경기/);
 assert.equal(await page.locator('#matchPagination').isVisible(),false);
 await page.locator('#matchSearch').fill('느린검색');await page.waitForTimeout(300);
 await page.locator('#matchSearch').fill('서울삼성');
 await page.waitForTimeout(900);
 assert.equal(await page.locator('#matchCount').textContent(),'1');
 assert.match(await page.locator('.match-row').innerText(),/서울 삼성/);
 await page.locator('#matchSearch').fill('없는경기');
 await page.waitForFunction(()=>!document.querySelector('#emptyMatches').hidden);
 await page.getByRole('button',{name:'전체 경기 보기'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.match-row').length===10);
 assert.equal(await page.locator('#matchPagination [aria-current=page]').textContent(),'1');
 await page.evaluate(()=>{document.documentElement.dataset.consoleTheme='dark';});
 await page.waitForTimeout(250);
 assert.notEqual(await page.locator('#matchPagination button').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
 assert.deepEqual(errors,[]);console.log('Library 10-item pages, full search, archived results and stale responses passed');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
