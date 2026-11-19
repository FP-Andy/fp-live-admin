/* Browser regression using synthetic UCCC data and an intercepted API only. */
const assert = require('node:assert/strict');
const {chromium} = require('../apps/web/node_modules/playwright-core');
const origin = 'http://127.0.0.1:4348', id = '11111111-1111-4111-8111-111111111111';
const fixtures = Array.from({length:27}, (_, i) => ({matchId: 800+i, matchName: `경기 ${i+1}`, homeTeamName: i<18?'홈팀':null, awayTeamName: i<18?'원정팀':null, scheduledAt:'2026-11-20T13:00', stage:i<18?'qualifying':'finals'}));
let ready=false, match={id,name:'[UCCC | 1R] 홈팀 vs 원정팀',sport:'FOOTBALL',archived:false,competition_class:'UCCC',first_half_minutes:45,metadata:{stream_mode:'MANUAL',home_team:'홈팀',away_team:'원정팀',lineups:{teams:{HOME:[],AWAY:[]}}}};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'live_admin_session',value:'fixture-only',url:origin}]);
  await context.route('**/*',async route=>{
   const {pathname:path,origin:host}=new URL(route.request().url());
   if(host!==origin)return route.abort();
   if(!path.startsWith('/api/'))return route.continue();
   const send=json=>route.fulfill({json});
   if(path==='/api/session/me')return send({id:'operator',name:'테스트',role:'SUPERADMIN'});
   if(path===`/api/matches/${id}`)return send(match);
   if(path===`/api/matches/${id}/summary`)return send({state:{clock_ms:0,running:false,possession_team:'NONE',selected_team:'HOME',attack_lr:'L2R'},command_revision:0,events:[],markers:[],possession:{home_pct:0,away_pct:0},lanes:{home:{},away:{}}});
   if(path===`/api/matches/${id}/dominance`)return send({bins:[]});
   if(path===`/api/matches/${id}/matchday/fixtures`)return send({fixtures});
   if(path===`/api/matches/${id}/matchday/fixtures/800/preview`)return send({fixture:fixtures[0],teams:ready?{HOME:[{number:'7',name:'홈 선수'}],AWAY:[{number:'9',name:'원정 선수',isSubstitute:true}]}:{HOME:[],AWAY:[]},current_teams:match.metadata.lineups.teams,current_names:{HOME:'홈팀',AWAY:'원정팀'},teams_known:true,names_changed:false,has_records:false,linked_match_id:match.metadata.matchday?.match_id||null,roster_ready:ready,errors:[],fingerprint:'example'});
   if(path===`/api/matches/${id}/matchday/apply`){assert.equal(route.request().postDataJSON().match_id,800);match={...match,metadata:{...match.metadata,matchday:{match_id:800},lineups:{teams:ready?{HOME:[{number:'7',name:'홈 선수'}],AWAY:[{number:'9',name:'원정 선수',isSubstitute:true}]}:match.metadata.lineups.teams}}};return send({match,roster_imported:ready});}
   if(path.endsWith('/agent-edits'))return send({items:[],server_now:new Date().toISOString()});
   if(path==='/api/outbox')return send([]);
   return send({});
  });
  const page=await context.newPage();
  await page.goto(`${origin}/admin/match/${id}`);
  await page.locator('summary').filter({hasText:'명단 · 운영권'}).click();
  await page.getByRole('button',{name:'UCCC 경기 선택'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#matchday-fixture option').length===28);
  assert.equal(await page.locator('#matchday-fixture optgroup').count(),2);
  await page.selectOption('#matchday-fixture','800');
  await page.getByRole('button',{name:'경기 · 명단 조회'}).click();
  await page.getByText('양쪽 명단이 모두 준비되지 않았거나 확인이 필요합니다. 기존 명단은 유지됩니다.').waitFor();
  await page.getByRole('button',{name:'경기 연결',exact:true}).click();
  await page.getByText('경기를 연결했습니다.',{exact:false}).waitFor();
  ready=true;
  await page.getByRole('button',{name:'경기 · 명단 조회'}).click();
  await page.getByText(/7 홈 선수/).waitFor();
  await page.getByRole('button',{name:'경기 연결 및 명단 반영'}).click();
  await page.getByText('홈·어웨이 팀과 경기 명단을 반영했습니다.').waitFor();
  assert.equal(match.metadata.lineups.teams.HOME[0].name,'홈 선수');
  console.log('UCCC fixture selection, empty link, and roster refresh passed');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
