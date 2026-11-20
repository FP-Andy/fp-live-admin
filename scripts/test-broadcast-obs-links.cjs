/* Local browser contract: synthetic matches only, no production writes. */
const assert = require('node:assert/strict');
const {chromium} = require('../apps/web/node_modules/playwright-core');
const origin = process.env.FPC_QA_ORIGIN || 'http://127.0.0.1:4354';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'fixture server must be local');
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const base = id => ({match_id:id,name:'[UCCC | 1R] 홈 vs 원정',home_team:'홈',away_team:'원정',competition_class:'UCCC',round_number:1,status:'OPEN',archived:false,clock_ms:0,assets:{live:{},dominance:{}}});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let selected = null, assets = {};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1400,height:1000},permissions:['clipboard-read','clipboard-write']});
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url()), path=u.pathname;
   if(u.origin!==origin)return route.abort();
   if(path.startsWith('/api/broadcast/v1/matches/'))return route.fulfill({json:base(first)});
   if(path==='/api/broadcast/v1/channels/uccc/select'){
    const body=route.request().postDataJSON();
    assert.equal(body.expected_match_id, selected); selected=body.match_id;
    return route.fulfill({json:{match:base(selected)}});
   }
   if(path==='/api/broadcast/v1/channels/uccc')return route.fulfill({json:{match:selected?{...base(selected),assets}:null}});
   if(path==='/test.png')return route.fulfill({status:200,contentType:'image/png',body:png});
   return route.continue();
  });
  const page=await context.newPage();
  await page.goto(`${origin}/broadcast/matches/${first}`);
  const links=page.locator('.broadcast-asset-url').filter({hasText:'OBS'});
  await links.first().waitFor();
  assert.equal(await links.count(),7,'all seven OBS URLs exist before rendering');
  await page.getByRole('button',{name:'이 경기 OBS 링크 전체 복사'}).click();
  let clip=await page.evaluate(()=>navigator.clipboard.readText());
  assert(clip.includes(`/overlay/${first}/live/attack-direction-home`) && clip.includes(`/overlay/${first}/dominance/fulltime`));
  assert.equal((clip.match(/http:\/\//g)||[]).length,7);
  await page.getByRole('button',{name:'고정 OBS 링크 전체 복사'}).click();
  clip=await page.evaluate(()=>navigator.clipboard.readText());
  assert(clip.includes('/overlay/uccc/live/possession') && clip.includes('/overlay/uccc/dominance/halftime'));
  await page.getByRole('button',{name:'이 경기를 고정 링크에 연결'}).click();
  await page.getByRole('button',{name:'이 경기 연결됨'}).waitFor();
  assets={live:{possession:{combined_url:`${origin}/test.png`,generated_at:'1'}}};
  const obs=await context.newPage();
  await obs.goto(`${origin}/broadcast/overlay/uccc/live/possession`);
  await obs.locator('img').waitFor();
  selected=second; assets={};
  await obs.locator('img').waitFor({state:'detached',timeout:20000});
  assets={live:{possession:{combined_url:`${origin}/test.png`,generated_at:'2'}}};
  await obs.locator('img').waitFor({state:'visible',timeout:20000});
  assert((await obs.locator('img').getAttribute('src')).includes('obs=2'));
  console.log('pre-start URLs, copy-all, fixed channel, and transparent fixture switch passed');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
