/* Local, intercepted API: no real matches or writes. */
const assert=require('node:assert/strict');
const {chromium}=require('../apps/web/node_modules/playwright-core');
const origin=process.env.FPC_QA_ORIGIN||'http://127.0.0.1:4354';
assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const id='11111111-1111-4111-8111-111111111111';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {
  const context=await browser.newContext({serviceWorkers:'block'}); let writes=0;
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url()); if(u.origin!==origin)return route.abort();
   if(u.pathname===`/api/broadcast/v1/matches/${id}`)return route.fulfill({json:{match_id:id,name:'홈 vs 원정',home_team:'홈',away_team:'원정',competition_class:'K3',round_number:1,status:'OPEN',clock_ms:3000000,assets:{live:{},archive:{},dominance:{fulltime:{background_url:'/old-bg',asset_url:'/old-data',combined_url:'/old-full'}}}}});
   if(u.pathname===`/api/broadcast/matches/${id}/snapshot`)return route.fulfill({json:{match:{home:{score:2},away:{score:2}}}});
   if(u.pathname===`/api/broadcast/matches/${id}/dominance/fulltime/refresh`){writes++;assert.deepEqual(route.request().postDataJSON(),{home_score:2,away_score:2});return route.fulfill({json:{ok:true}});}
   if(u.pathname.startsWith('/api/'))return route.fulfill({json:{}});
   return route.continue();
  });
  const page=await context.newPage(); await page.goto(`${origin}/broadcast/matches/${id}`);
  await page.getByRole('button',{name:'풀경기 도미넌스 점수 확인'}).click();
  await page.getByRole('button',{name:'2 : 2로 풀경기 그래픽만 갱신'}).click();
  await page.getByText('풀경기 매치 도미넌스만 갱신했습니다.').waitFor();
  assert.equal(writes,1);console.log('fulltime score review and scoped refresh passed');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
