/* Real player/workspace; deterministic fixture API with lost responses. */
const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('../apps/web/node_modules/playwright-core');
const origin=process.env.FPC_QA_ORIGIN||'http://127.0.0.1:4354';assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const output=process.env.FPC_FLA_QA_OUTPUT||'/tmp/fpc-fla-recovery-qa';fs.mkdirSync(output,{recursive:true});
const media=output+'/synthetic.mp4';require('node:child_process').execFileSync(process.env.FFMPEG||'ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=green:s=320x180:r=25:d=20','-c:v','libx264','-threads','1',media]);
const id='11111111-1111-4111-8111-111111111111',endpoint='/api/futsal/fla-video/matches/'+id,path='/admin/futsal/fla/video/'+id;
let state={configured:true,version:1,upload_id:'synthetic',offset_ms:0,duration_ms:20000,cursor_ms:0,frontier_ms:0,started:true,ended:false,possession_team:'HOME',selected_team:'HOME',direction:'L2R',rate:1};
const receipts=new Map(),requests=[],segments=[],errors=[],cases=[];let fail=true,conflict=false;
const payload=()=>({state,can_write:true,can_write_substitutions:true,match:{id,name:'검증 경기',home:'홈',away:'원정',archived:false,fixture:{stage:'격리',round:1,court:'A'},lineups:{teams:{HOME:[],AWAY:[]}}},events:[],flow:[],segments,possession:{HOME:segments.reduce((s,p)=>s+p.end_ms-p.start_ms,0),AWAY:0,NONE:0},substitutions:{revision:0,log:null}});
const pass=name=>{cases.push(name);console.log('PASS:',name);};
let browser,page;
(async()=>{browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':chromium.executablePath()),headless:true});
 const c=await browser.newContext({serviceWorkers:'block',acceptDownloads:true,viewport:{width:1366,height:768}});
 await c.addCookies([{name:'live_admin_session',value:'synthetic',url:origin}]);await c.addInitScript(()=>localStorage.setItem('fineplay.selectedSport','FUTSAL'));
 await c.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue();
 if(u.pathname==='/api/session/me')return route.fulfill({json:{id:'fla-owner',name:'검증 관리자',role:'SUPERADMIN'}});
 if(u.pathname.endsWith('/source'))return route.fulfill({path:media,contentType:'video/mp4'});
 if(u.pathname===endpoint)return route.fulfill({json:payload()});
 if(u.pathname==='/api/futsal/fla-video/fixtures')return route.fulfill({json:{fixtures:[],uploads:[{id:'synthetic',name:'synthetic.mp4',size:fs.statSync(media).size}]}});
 if(u.pathname===endpoint+'/recording'){
  const p=route.request().postDataJSON();requests.push(p);
  if(conflict&&p.segments.length)return route.fulfill({status:409,json:{detail:'다른 창의 변경이 저장되었습니다.'}});
  if(receipts.has(p.request_id))assert.deepEqual(receipts.get(p.request_id),p);
  else{assert.equal(p.version,state.version);receipts.set(p.request_id,p);segments.push(...p.segments);state={...state,...p,version:state.version+1,started:true,ended:p.action==='finish'};delete state.segments;}
  if(fail)return route.abort('failed');return route.fulfill({json:payload()});
 }
 return route.fulfill({json:[]});});
 try{page=await c.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.goto(origin+path);await page.getByRole('button',{name:'영상 재생 정지',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
 await page.getByRole('button',{name:'영상 재생 정지',exact:true}).click();
 await page.getByRole('button',{name:'저장 다시 시도',exact:true}).waitFor();
 await page.getByRole('button',{name:'저장 다시 시도',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.fv-error')?.textContent.includes('Failed to fetch'));
 const first=requests[0];assert(first.segments.length);assert(requests.length>=2);requests.forEach(p=>assert.deepEqual(p,first));
 await page.reload();await page.getByRole('button',{name:'저장 다시 시도',exact:true}).waitFor();
 fail=false;await page.getByRole('button',{name:'저장 다시 시도',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.fv-error'));
 assert.deepEqual(requests.at(-1),first);assert.equal(receipts.size,1);
 pass('Two lost responses and reload retry retain original request ID/payload without duplicate segments');
 await page.getByRole('button',{name:'영상 재생 정지',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('video').currentTime>4);
 await page.getByRole('link',{name:'경기 목록',exact:true}).click();await page.waitForURL('**/admin/futsal/fla/video');
 assert(state.frontier_ms>=4000);for(let i=1;i<segments.length;i++)assert.equal(segments[i].start_ms,segments[i-1].end_ms);
 pass('Internal list navigation samples the last frame, pauses, and saves contiguous final possession');
 await page.goto(origin+path);await page.getByRole('button',{name:'영상 재생 정지',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
 conflict=true;await page.getByRole('button',{name:'영상 재생 정지',exact:true}).click();await page.getByRole('button',{name:'저장 다시 시도',exact:true}).waitFor();
 await page.getByRole('link',{name:'경기 목록',exact:true}).click();
 await page.getByText('이동 전에 저장하지 못했습니다.',{exact:false}).waitFor();assert.equal(new URL(page.url()).pathname,path);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'기록 복구 JSON 저장',exact:true}).click();const d=await download;await d.saveAs(output+'/recording.json');const record=JSON.parse(fs.readFileSync(output+'/recording.json'));
 assert(record.recording.request);assert(record.recording.segments.length);assert.equal(record.matchId,id);
 pass('Other-tab conflict blocks navigation and exports the unsent recording for comparison');
 assert.deepEqual(errors,[]);await page.screenshot({path:output+'/conflict-recovery.png'});fs.writeFileSync(output+'/results.json',JSON.stringify({cases,errors},null,2));
 }catch(e){await page?.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
