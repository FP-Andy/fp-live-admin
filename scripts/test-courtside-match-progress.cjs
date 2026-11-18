const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'../apps/web/public/kbl-grayzone');
const playwright=require(process.env.COURTSIDE_TEST_PLAYWRIGHT||path.resolve(__dirname,'../apps/web/node_modules/playwright-core'));
const mid='11111111-1111-4111-8111-111111111111',caseId='game-test';let saved;
const stages={objects:{completed:3,total:3},joints:{completed:3,total:3},spatial:{completed:1,total:3}};
const json=(res,data)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1'),p=u.pathname;
 if(p===`/api/courtside/matches/${mid}/access`)return json(res,{canEdit:true,canManageEditors:true});
 if(p===`/api/matches/${mid}`)return json(res,{name:'테스트 경기',metadata:{}});
 if(p===`/api/courtside/matches/${mid}/cases`)return json(res,{cases:[{id:caseId}]});
 if(p===`/api/courtside/matches/${mid}/intakes`)return json(res,{intakes:[]});
 if(p===`/api/courtside/matches/${mid}/presence`)return json(res,{people:[{name:'김 작업자',stage:'spatial',eventId:'review-2'}]});
 if(p===`/api/courtside/matches/${mid}/editors`){if(req.method==='POST'){let body='';req.on('data',b=>body+=b);req.on('end',()=>{saved=JSON.parse(body);json(res,{version:'v2',editorIds:saved.editorIds});});return;}return json(res,{version:'v1',editorIds:[],users:[{id:'operator-a',name:'김 작업자'}]});}
 if(p.endsWith('/review-flow'))return json(res,{caseId,activeStage:'spatial',nextEventId:'review-2',stages});
 if(p.endsWith('/report-video-batches'))return json(res,{job:{state:'running',stage:'영상 제작 2/3'}});
 const file=path.resolve(root,'.'+decodeURIComponent(p));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type',({'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
});
(async()=>{let browser;try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await playwright.chromium.launch({headless:true,...(process.env.COURTSIDE_TEST_CHROME?{executablePath:process.env.COURTSIDE_TEST_CHROME}:{channel:'chrome'})});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});await page.goto(`http://127.0.0.1:${server.address().port}/fpc-match.html?id=${mid}`);
 await page.getByText('2D·3D 단계 · 1/3장면 확인').waitFor();await page.getByText('최근 2분 활동 · 김 작업자 (2D·3D · 2번)').waitFor();
 assert.match(await page.locator('#workProgressLink').getAttribute('href'),/reconstruction\.html\?id=game-test#review-2$/);
 assert.equal(await page.locator('#workProgressVideo').textContent(),'영상 제작 2/3');
 await page.getByLabel('김 작업자').check();await page.getByRole('button',{name:'작업자 저장'}).click();await page.getByText('작업자 권한을 저장했습니다.').waitFor();assert.deepEqual(saved,{version:'v1',editorIds:['operator-a']});
 console.log('Match detail shows saved work, recent activity and scoped editor assignment.');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
