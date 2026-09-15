/** Local, in-memory design sandbox. Never connects to production. Start with node scripts/preview-console.cjs. */
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const pathModule = require('node:path');
const now = () => new Date().toISOString();
const today = now().slice(0,10);
const match = {id:'demo-fla',name:'파인 FC vs 루덴스 FC',sport:'FOOTBALL',competition_class:'DEMO',round_number:1,created_at:now(),archived:false,operator_id:null,first_half_minutes:45,second_half_minutes:45,hls_url:null,metadata:{stream_mode:'MANUAL',design_preview:true,lineups:{teams:{HOME:[{number:7,name:'홈 선수 7',position:'FW'},{number:10,name:'홈 선수 10',position:'MF'}],AWAY:[{number:9,name:'원정 선수 9',position:'FW'},{number:8,name:'원정 선수 8',position:'MF'}]}}}};
const savedLineup = pathModule.join(__dirname, '../runtime/preview-lineup.json');
function applyLineup(lineup) {
 match.metadata.lineups = lineup;
 if(lineup.team_names?.HOME && lineup.team_names?.AWAY) {
  match.metadata.home_team=lineup.team_names.HOME; match.metadata.away_team=lineup.team_names.AWAY;
  match.name=`${lineup.team_names.HOME} vs ${lineup.team_names.AWAY}`;
 }
}
if(fs.existsSync(savedLineup)){try{applyLineup(JSON.parse(fs.readFileSync(savedLineup,'utf8')));}catch{}}

let state={clock_ms:24*60000+18000,running:false,possession_team:'NONE',selected_team:'HOME',attack_lr:'L2R'};
let events=[{id:'demo-goal',type:'XG',team:'HOME',xg:.32,is_goal:true,is_on_target:true,clock_ms:18*60000,created_at:now(),player_name:'홈 선수 7',player_number:7},{id:'demo-shot',type:'XG',team:'AWAY',xg:.14,is_goal:false,clock_ms:22*60000,created_at:now()}];
const possession={HOME:780000,AWAY:660000};
const schedules=[{id:'demo-schedule',league:'DEMO',round_label:'1',match_date:today,kickoff_time:'19:00',home_team:'파인 FC',away_team:'루덴스 FC',fla_staff:'Preview',fpa_home_staff:'',fpa_away_staff:'',created_at:now(),updated_at:now()}];
const archivedMatch={...match,id:'demo-fcm',name:'[K3 | 1R] 파인 FC vs 루덴스 FC',competition_class:'K3',archived:true,archived_at:now(),metadata:{design_preview:true,stream_mode:'MANUAL',home_team:'파인 FC',away_team:'루덴스 FC'}};
const streams=[{...match,id:'demo-stream',name:'예시 · 서울 FC vs 부산 FC',hls_url:null,metadata:{stream_mode:'STREAM',ingest_protocol:'RTMP',rtmp:{server_url:'rtmp://preview.invalid/live',stream_key:'demo-stream'},hls_probe:{ok:true,status_code:200,detail:'예시 송출 상태',checked_at:now()}}},{...match,id:'demo-stream-error',name:'예시 · 인천 FC vs 대전 FC',metadata:{stream_mode:'STREAM',ingest_protocol:'SRT',stream_attach_error:'예시: 입력 신호를 기다리고 있습니다.',hls_probe:{ok:false,status_code:404,detail:'예시: HLS 세그먼트 대기',checked_at:now()}}}];
const competitionClasses=['DEMO','K3'].map(code=>({code,name:code==='DEMO'?'로컬 예시 리그':'K3 예시',first_half_minutes:45,second_half_minutes:45,team_options:['파인 FC','루덴스 FC'],created_at:now()}));
const templates=[{id:'demo-template',name:'예시 · 파인 FC 선수 카드',competition_class:'K3',match_regex:'파인',image_url:'',card_type:'PLAYER',priority:100,active:true,created_at:now(),updated_at:now()},{id:'demo-template-gk',name:'예시 · 루덴스 FC 골키퍼 카드',competition_class:'K3',match_regex:'루덴스',image_url:'',card_type:'GOALKEEPER',priority:100,active:false,created_at:now(),updated_at:now()}];
const submissions=[{id:'demo-submission',match_id:'demo-fcm',competition_class:'K3',round_number:1,team_side:'HOME',team_name:'파인 FC',player_id:'7',player_name:'예시 선수',selected_stats:['유효 슈팅 3회','패스 성공률 86%','키패스 2회','찬스 창출 2회','득점 1'],submitted_by:'Preview',created_at:now(),updated_at:now()}];
const sceneRows=[0,1,2].map(i=>({SceneIndex:String(i+1),Action:i===2?'Shot':'Pass',Player:i===2?'7':'10',Receiver:i===2?'':'7',PathPoints:`${45+i*10},34;${70+i*10},30`,xG:i===2?'0.32':'0',EPV:'0.018',PC:'0.12',SceneState:JSON.stringify({actor_team:'home',beforeDots:[{id:'h10',number:'10',teamSide:'home',meter_x:45+i*10,meter_y:34},{id:'h7',number:'7',teamSide:'home',meter_x:70+i*8,meter_y:30},{id:'a4',number:'4',teamSide:'away',meter_x:80+i*3,meter_y:35},{id:'a5',number:'5',teamSide:'away',meter_x:70+i*6,meter_y:45}],afterDots:[{id:'h10',number:'10',teamSide:'home',meter_x:52+i*10,meter_y:32},{id:'h7',number:'7',teamSide:'home',meter_x:78+i*6,meter_y:30},{id:'a4',number:'4',teamSide:'away',meter_x:84+i*3,meter_y:34},{id:'a5',number:'5',teamSide:'away',meter_x:75+i*5,meter_y:40}]})}));
const modelRoom={slots:['xg','xgot','epv','pc','xfp_weights'].map(key=>({key,label:({xg:'xG',xgot:'xGOT',epv:'EPV',pc:'PC',xfp_weights:'xFP'})[key],description:'예시 데이터 · 분포와 버전 확인',active_model_id:'sample-'+key,models:[{id:'sample-'+key,slot:key,label:'로컬 예시 v1',filename:'sample-'+key+'.csv',file_size:2048,uploaded_at:now(),notes:'화면 검토용 합성 데이터',distribution:{parse_status:'ok',stats:{count:100,min:.01,max:.8,mean:.22,p10:.03,p50:.18,p90:.6},histogram:Array.from({length:10},(_,i)=>({start:i/10,end:(i+1)/10,count:20-i*2})),points:Array.from({length:100},(_,i)=>({x:(i%10)*10+5,y:Math.floor(i/10)*10+5,value:((i%10)+1)/10})),goalmouth_points:[],matrix_cells:[]}}]}))};
function systemPreview(){const metrics={available:true,cpu_average_percent:24.5,cpu_max_percent:38.2,memory_percent:42,memory_used_gib:3.36,memory_total_gib:8,disk_percent:28,disk_used_gib:28,disk_total_gib:100,sample_time:now()};const server={configured:false,ok:true,state:'running',instance_name:'로컬 예시',provider:'preview',metrics};return {ok:true,time:now(),streams_enabled:false,gateway_base:'local-preview',public_hls_base:null,app_server:server,media_server:{...server,instance_name:'예시 · Stream Gateway'},highlight_worker:{...server,state:'stopped',active_jobs:0},health:{gateway_ok:true,running_streams:1,active_matches:3,live_matches:1,streaming_matches:2,manual_matches:1,active_highlight_jobs:0},alerts:[{severity:'INFO',title:'로컬 미리보기',message:'합성 상태 데이터입니다. 실제 서버 제어는 연결되지 않았습니다.'}],recent_audits:[{id:'demo-audit',actor_name:'Preview',actor_role:'SUPERADMIN',action:'match.create',target_type:'match',target_id:'demo-fla',severity:'INFO',created_at:now()}]};}
function matchPage(url) {const archived=url.searchParams.get('archived')==='true'||url.searchParams.get('mode')==='archived';const cls=url.searchParams.get('competition_class');const sport=url.searchParams.get('sport');const items=archived||match.archived||sport&&sport!=='FOOTBALL'||cls&&cls!=='ALL'&&cls!=='DEMO'?[]:[match];return {items,total:items.length,active_total:match.archived?0:1,archived_total:match.archived?1:0,assigned_total:1,rtmp_total:0,class_options:['DEMO']};}
function summary(){const total=possession.HOME+possession.AWAY;const lanes={};for(const [key,team] of [['home','HOME'],['away','AWAY']]){const es=events.filter(e=>e.type==='ATTACK_LANE'&&e.team===team);lanes[key]={total_count:es.length,...Object.fromEntries(['LEFT','CENTER','RIGHT'].map(l=>[l.toLowerCase()+'_pct',es.length?100*es.filter(e=>e.lane===l).length/es.length:0]))};}return {state,possession:{home_pct:total?possession.HOME/total*100:0,away_pct:total?possession.AWAY/total*100:0},events,lanes};}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');const path=url.pathname;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 const send=(data,status=200)=>{res.statusCode=status;res.end(JSON.stringify(data));};
 let rawBody=Buffer.alloc(0),body={};
 try {
  if(!['GET','HEAD'].includes(req.method)) {
   const chunks=[]; let bytes=0;
   for await(const chunk of req){bytes+=chunk.length;if(bytes>21*1024*1024)throw Error('Request too large');chunks.push(chunk);}
   rawBody=Buffer.concat(chunks);
   if((req.headers['content-type']||'').includes('application/json'))body=rawBody.length?JSON.parse(rawBody.toString()):{};
  }
 } catch {return send({detail:'Invalid request or file too large'},400);}
 const forward = async(target, buffer=rawBody) => {
  const response=await fetch('http://127.0.0.1:4317'+target,{method:req.method,headers:{'content-type':req.headers['content-type']||'application/json',cookie:req.headers.cookie||''},...(['GET','HEAD'].includes(req.method)?{}:{body:buffer}),signal:AbortSignal.timeout(30000)});
  res.statusCode=response.status;res.setHeader('Content-Type',response.headers.get('content-type')||'application/json');
  const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
 };
 if(path.startsWith('/api/broadcast/assets/logos/')){try{return await forward(req.url);}catch{return send({detail:'Logo unavailable'},503);}}

 let user;
 try {
  const authHeaders={'Content-Type':'application/json',cookie:req.headers.cookie||''};
  if(path.startsWith('/api/session/')||path.startsWith('/api/admin/access')||path.startsWith('/api/fcm/team-logos')){
   return await forward(req.url);
  }
  const session=await fetch('http://127.0.0.1:4317/api/session/me',{headers:authHeaders,signal:AbortSignal.timeout(10000)});
  if(!session.ok)return send({detail:'로그인이 필요합니다.'},401);
  user=await session.json();
  if(path.startsWith('/api/admin/')&&user.role!=='SUPERADMIN')return send({detail:'관리자만 접근할 수 있습니다.'},403);
 } catch {return send({detail:'로컬 인증 서버에 연결하지 못했습니다.'},503);}
 const branding = async(changes={}) => {
  const response=await fetch('http://127.0.0.1:4317/api/preview/branding',{method:'POST',headers:{'Content-Type':'application/json',cookie:req.headers.cookie||''},body:JSON.stringify({...match,changes}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Branding unavailable');
  return response.json();
 };
 if(path==='/api/matches/demo-fla/lineup/pdf'&&req.method==='POST') {
  if(match.operator_id&&match.operator_id!==user.id&&user.role!=='SUPERADMIN')return send({detail:'다른 운영자가 경기를 제어 중입니다.'},403);
  try{
   const response=await fetch('http://127.0.0.1:4317/api/preview/lineup/pdf',{method:'POST',headers:{'Content-Type':req.headers['content-type'],cookie:req.headers.cookie||''},body:rawBody,signal:AbortSignal.timeout(30000)});
   const data=await response.json();if(!response.ok)return send(data,response.status);
   applyLineup(data.lineups);fs.writeFileSync(savedLineup,JSON.stringify(data.lineups));
   return send({...data,match});
  }catch{return send({detail:'PDF 분석 서버에 연결하지 못했습니다.'},503);}
 }
 if(path==='/api/matches/demo-fla/lineup/swap'&&req.method==='POST'){
  for(const key of ['teams','team_names','uniforms']){const value=match.metadata.lineups[key];if(value)match.metadata.lineups[key]={HOME:value.AWAY,AWAY:value.HOME};}
  match.metadata.lineups.first_team_side=match.metadata.lineups.first_team_side==='HOME'?'AWAY':'HOME';
  match.metadata.lineups.detected_by='manual';
  applyLineup(match.metadata.lineups);fs.writeFileSync(savedLineup,JSON.stringify(match.metadata.lineups));
  return send({ok:true,lineups:match.metadata.lineups,match});
 }
 if(path==='/api/broadcast/matches/demo-fla/snapshot') {
  try {
   const value=await branding(); const data=summary();
   return send({match:{id:match.id,name:match.name,sport:'FOOTBALL',home:{name:match.metadata.home_team||'파인 FC',score:1},away:{name:match.metadata.away_team||'루덴스 FC',score:0},clock:'24:18',clock_ms:state.clock_ms,fla_clock:'24:18',fla_clock_ms:state.clock_ms,running:state.running,first_half_minutes:45,second_half_minutes:45},broadcast_state:{...value,match_id:match.id,home_label:match.metadata.home_team,away_label:match.metadata.away_team,scoreboard_visible:true,possession_visible:true,active_graphic:null,event_graphic:null,fullscreen_graphic:null,theme_id:'fineplay_dark',home_score:null,away_score:null,clock_ms:state.clock_ms,clock_running:false,sequence:0,updated_at:now()},analysis:{possession:data.possession,attack_direction:[{team:'HOME',direction_ratio:{left_pct:25,center_pct:50,right_pct:25}},{team:'AWAY',direction_ratio:{left_pct:35,center_pct:20,right_pct:45}}],xg:events.filter(e=>e.type==='XG').map(e=>({...e,event_id:e.id,event_clock_ms:e.clock_ms,shot_x:88,shot_y:34}))},updated_at:now()});
  }catch{return send({detail:'로컬 그래픽 정보를 불러오지 못했습니다.'},503);}
 }
 if(path==='/api/broadcast/matches/demo-fla/state'){
  try {const value=await branding(req.method==='POST'?body:{});if(req.method==='POST')match.metadata.broadcast=value;return send(value);}catch{return send({detail:'팀 브랜딩을 불러오지 못했습니다.'},503);}
 }
 if(path==='/api/broadcast/v1/live-matches'||path==='/api/broadcast/v1/matches/demo-fla') {
  try {
   const value=await branding();
   const item={match_id:match.id,name:match.name,home_team:match.metadata.home_team||'파인 FC',away_team:match.metadata.away_team||'루덴스 FC',competition_class:match.competition_class,round_number:1,status:'OPEN',clock_ms:state.clock_ms,created_at:match.created_at,assets:{live:{},archive:{},dominance:{}},branding:{...value,sources:value.branding_sources}};
   if(path.endsWith('/demo-fla'))return send(item);
   return send({generated_at:now(),matches:[item],competition_classes:['DEMO'],pagination:{page:1,page_size:20,total:1,total_pages:1}});
  }catch{return send({detail:'팀 브랜딩을 불러오지 못했습니다.'},503);}
 }
 if(path==='/api/dashboard/bootstrap')return send({user,matches:matchPage(url),competition_classes:[{code:'DEMO',name:'로컬 예시 리그',first_half_minutes:45,second_half_minutes:45,team_options:['파인 FC','루덴스 FC'],created_at:now()}],schedule_entries:schedules,stream_status:{running_match_ids:state.running?['demo-fla']:[]}});
 if(path==='/api/dashboard/matches')return send(matchPage(url));
 if(path==='/api/admin/streams/status')return send({running_match_ids:state.running?['demo-fla']:[]});
 if(req.method==='GET'){
  if(path==='/api/competition-classes')return send(competitionClasses);
  if(path==='/api/matches')return send([match,archivedMatch,...streams]);
  if(path==='/api/matches/page')return send({items:[match,...streams],total:3});
  if(path==='/api/admin/media')return send({ok:true,time:now(),gateway:{configured:false,base:'local-preview',status_ok:true,lines:['로컬 예시 · 송출 1건, 점검 필요 1건'],running_match_ids:['demo-stream']},matches:[match,...streams]});
  if(path==='/api/admin/system')return send(systemPreview());
  if(path==='/api/data-hub/matches')return send(url.searchParams.get('sport')==='FOOTBALL'?[{...match,has_fla_data:true,has_fpa_logs:false},{...archivedMatch,has_fla_data:true,has_fpa_logs:true},{...streams[1],has_fla_data:false,has_fpa_logs:false}]:[]);
  if(path==='/api/fpa/replay-matches')return send({items:[{match:archivedMatch,saved:{match_id:archivedMatch.id,logs:sceneRows.map(()=>''),rows:sceneRows,teamid_h:'파인 FC',teamid_a:'루덴스 FC',updated_at:now()}}]});
  if(path==='/api/fpa/model-room')return send(modelRoom);
  if(path==='/api/fcm/templates')return send(templates);
  if(path==='/api/fcm/submissions')return send(submissions);
  if(/^\/api\/fcm\/templates\/demo-template(-gk)?\/image$/.test(path)){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500" viewBox="0 0 400 500"><rect width="400" height="500" fill="#13161c"/><path d="M0 0H400V120L0 280Z" fill="#2158e8"/><path d="M0 360L400 200V500H0Z" fill="#ff7400"/><text x="32" y="70" fill="white" font-family="sans-serif" font-size="28" font-weight="bold">FINEPLAY</text><text x="32" y="320" fill="white" font-family="sans-serif" font-size="74" font-weight="bold">07</text><text x="32" y="450" fill="white" font-family="sans-serif" font-size="20">LOCAL PREVIEW</text></svg>');}
 }
 if(path==='/api/outbox')return send([]);
 if(path==='/api/matches/demo-fla'&&req.method==='GET')return send(match);
 if(path==='/api/matches/demo-fla/summary')return send(summary());
 if(path==='/api/matches/demo-fla/dominance')return send({bins:[.1,.22,-.15,-.27,.3,.5,.26,-.18].map((d,i)=>({start_ms:i*180000,end_ms:(i+1)*180000,dominance:d})),split_halves:false});
 if(path==='/api/matches/demo-fla/state'&&req.method==='POST'){if(state.running&&['HOME','AWAY'].includes(state.possession_team))possession[state.possession_team]+=Math.max(0,body.clock_ms-state.clock_ms);state={...state,...body};return send({ok:true});}
 if(path.match(/^\/api\/matches\/demo-fla\/events\/(attack_lane|xg)$/)&&req.method==='POST'){const id=body.event_id||randomUUID();if(!events.some(e=>e.id===id))events.unshift({...body,id,type:path.endsWith('xg')?'XG':'ATTACK_LANE',created_at:now()});return send({ok:true});}
 if(path==='/api/matches/demo-fla/events/reset'&&req.method==='POST'){events=[];return send({ok:true});}
 if(path==='/api/matches/demo-fla/possession/reset'&&req.method==='POST'){possession.HOME=0;possession.AWAY=0;return send({ok:true});}
 if(path==='/api/matches/demo-fla/markers'&&req.method==='POST')return send({ok:true});
 if(path==='/api/matches/demo-fla/lock/acquire'&&req.method==='POST'){match.operator_id=user.id;return send({ok:true});}
 if(path==='/api/matches/demo-fla/lock/release'&&req.method==='POST'){match.operator_id=null;return send({ok:true});}
 if(path==='/api/matches/demo-fla/lineup/manual/player'&&req.method==='POST'){const team=body.team||body.side;if(!['HOME','AWAY'].includes(team))return send({detail:'Invalid team'},400);match.metadata.lineups.teams[team].push(body);return send({ok:true});}
 if(path==='/api/xg/estimate'&&req.method==='POST'){const distance=Math.hypot(105-body.start_x,34-body.start_y);return send({xg:Number(Math.max(.01,.55-distance/100).toFixed(3)),distance:Number(distance.toFixed(1)),is_in_box:distance<16.5,label:'DEMO'});}
 if(path==='/api/xgot/estimate'&&req.method==='POST')return send({xgot:Math.min(1,Number(body.xg||.1)+.05),delta:.05,label:'DEMO'});
 if(path==='/api/matches/demo-fla/export.csv'){res.setHeader('Content-Type','text/csv; charset=utf-8');return res.end('type,team,clock_ms,xg\n'+events.map(e=>[e.type,e.team,e.clock_ms,e.xg||0].join(',')).join('\n'));}
 return send({detail:'로컬 예시에서 지원하지 않는 작업입니다.'},404);
});
server.listen(4319,'127.0.0.1',()=>console.log('FPC local sample API: http://127.0.0.1:4319 — demo-fla (memory only)'));
