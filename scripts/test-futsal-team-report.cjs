const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('../apps/web/node_modules/typescript');
const cache=new Map();function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const m={exports:{}};cache.set(file,m.exports);Function('exports','require','module',ts.transpile(fs.readFileSync(file,'utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}))(m.exports,id=>id.startsWith('.')?load(path.resolve(path.dirname(file),id)+(path.extname(id)?'':'.ts')):require(id),m);return m.exports;}
const r=load('apps/web/lib/futsal-team-report.ts'),f=load('apps/web/lib/futsal-report.ts');
const data={matchId:'one',loadedAt:new Date().toISOString(),started:true,ended:false,summary:{possession:{home_ms:200,away_ms:100,home_pct:66.67,away_pct:33.33},lanes:{home:{left_count:1,center_count:3,right_count:0,total_count:4},away:{left_count:0,center_count:0,right_count:2,total_count:2}}},dominance:{bins:[{start_ms:0,end_ms:60000,dominance:.6,annotations:{goal_summary:{home:1,away:0}}},{start_ms:60000,end_ms:120000,dominance:-.2}]}};
r.validateMatchReportData(data);const home=r.teamReportView(data,'home'),away=r.teamReportView(data,'away');
assert.equal(home.ownMs,away.opponentMs);assert.equal(away.ownLanes.right_count,2);assert.equal(away.bins[0].dominance,-.6);assert.equal(away.bins[0].annotations.goal_summary.away,1);assert.equal(data.dominance.bins[0].dominance,.6);
assert.match(r.matchComment(data,'home'),/중앙/);assert.match(r.matchComment(data,'away'),/오른쪽 측면/);assert.throws(()=>r.validateMatchReportData({...data,dominance:{bins:[{start_ms:0,end_ms:1,dominance:NaN}]}}));
const d=f.emptyDraft();d.id='draft';d.sourceSnapshot={id:'a',jobId:'job',version:1,createdAt:'one'};d.players={'home-1':{...f.blankPlayer(),name:'수정한 이름',jersey:'88',heatComment:'보존할 코멘트'}};d.selected='home-1';d.teamReport=r.defaultTeamReport();
const source={id:'b',jobId:'job',version:2,createdAt:'two',matchId:'match',matchName:'서울 vs 안양',homeName:'서울',awayName:'안양',fpa:{rows:[],logs:[]},heatmap:{schema:'fpa-heatmaps/v1',datasetId:'one',video:'one',from:0,to:10,width:1,height:1,scale:1,players:[{id:'home-1',group:'home',jersey:'2',positions:[{t:0,x:.5,y:.5,seconds:1}],grid:[1]}]}};
const updated=f.updateSnapshotSource(d,source);assert.equal(updated.players['home-1'].name,'수정한 이름');assert.equal(updated.players['home-1'].jersey,'88');assert.equal(updated.players['home-1'].heatComment,'보존할 코멘트');assert.equal(updated.id,d.id);assert.equal(updated.sourceSnapshot.version,2);assert.equal(d.sourceSnapshot.version,1);assert.equal(f.updateSnapshotSource(updated,source),updated);assert.equal(f.updateSnapshotSource(d,{...source,jobId:'different'}),d);
console.log('PASS: team-perspective inversion, preserved time axis/goals/colors, grounded comments, source refresh preserves edits, older/different snapshots ignored.');

if(process.env.REAL_FLA_SUMMARY&&process.env.REAL_FLA_DOMINANCE){const actual={...data,summary:JSON.parse(fs.readFileSync(process.env.REAL_FLA_SUMMARY)),dominance:JSON.parse(fs.readFileSync(process.env.REAL_FLA_DOMINANCE))};r.validateMatchReportData(actual);console.log('Real FLA accepted:',actual.dominance.bins.length,'bins',r.matchComment(actual,'home'));}

const shot=(i,team)=>({id:String(i),type:'XG',team,shot_x:30,shot_y:10,xg:.1,is_goal:false});
const full={...data,ended:true,summary:{...data.summary,possession:{home_ms:600000,away_ms:300000}},dominance:{bins:Array.from({length:15},(_,i)=>({start_ms:i*60000,end_ms:(i+1)*60000,dominance:.5}))},events:[...Array.from({length:9},(_,i)=>shot(i,'HOME')),...Array.from({length:3},(_,i)=>shot(i+9,'AWAY'))]};
assert.match(r.matchComment(full,'home',{homeScore:'3',awayScore:'1'}),/승리.*경기 지표가 함께/s);
assert.match(r.matchComment(full,'away',{homeScore:'3',awayScore:'1'}),/패배.*상대 쪽으로 기운/s);
assert.match(r.matchComment(full,'home',{homeScore:'1',awayScore:'1'}),/우위를 득점 차로 연결/);
assert.match(r.matchComment(full,'home',{homeScore:'1',awayScore:'3'}),/유리하게 남은 지표/);
assert.match(r.matchComment(full,'away',{homeScore:'1',awayScore:'3'}),/상대 쪽에 유리한 지표가 더 많았는데도 승리/);
assert.match(r.matchComment(full,'home',{homeScore:'3',awayScore:'0'}),/실점 없이/);
const live=r.matchComment({...full,ended:false},'home',{homeScore:'3',awayScore:'1'});assert.match(live,/현재 스코어.*아직 기록 중/s);assert.doesNotMatch(live,/승리로 경기를 마쳤|패배였|무승부로 경기를 마쳤/);
for(const score of [{homeScore:'',awayScore:''},{homeScore:'-1',awayScore:'0'},{homeScore:'a',awayScore:'1'}])assert.equal(r.matchResult(full,'home',score),null);
const missing=r.matchComment(full,'home',{homeScore:'',awayScore:''});assert.doesNotMatch(missing,/0:0|승리로|패배였/);
const oneTeam=r.matchComment({...full,events:[shot(1,'AWAY')]},'home',{homeScore:'3',awayScore:'1'});assert.match(oneTeam,/횟수 비교는 보류/);assert.doesNotMatch(oneTeam,/우리 팀 0회|결정력|역전|선제골/);
const sparse={...full,summary:data.summary,dominance:{bins:[]},events:[]};assert.doesNotMatch(r.matchComment(sparse,'home',{homeScore:'2',awayScore:'1'}),/지표가 함께 뒷받침|상대 쪽에 유리한 지표/);
for(const own of [0,1,3])for(const other of [0,1,3])for(const side of ['home','away']){const text=r.matchComment(full,side,{homeScore:String(own),awayScore:String(other)});assert(text.length<1100);assert(!text.includes('undefined'));assert.equal(text.split('\n\n').length,3);}
console.log('PASS: score-aware win/draw/loss assessment, score perspective inversion, process/result divergence, clean sheet, ongoing/missing score safeguards, sparse and one-team log limits.');
