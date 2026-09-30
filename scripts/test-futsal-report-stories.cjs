const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('../apps/web/node_modules/typescript');
const cache=new Map();function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const m={exports:{}};cache.set(file,m.exports);Function('exports','require','module',ts.transpile(fs.readFileSync(file,'utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}))(m.exports,id=>id.startsWith('.')?load(path.resolve(path.dirname(file),id)+(path.extname(id)?'':'.ts')):require(id),m);return m.exports;}
const r=load('apps/web/lib/futsal-report.ts'),e=load('apps/web/lib/futsal-report-events.ts');
const p={id:'home-1',group:'home',jersey:'7',grid:[180],positions:[{t:50,x:.1,y:.2,seconds:60},{t:350,x:.5,y:.5,seconds:60},{t:650,x:.9,y:.8,seconds:60}],coverage:.2,observed:180};
const heat={schema:'fpa-heatmaps/v1',datasetId:'one',video:'one',from:20,to:950,width:1,height:1,scale:1,players:[p]};
let d=r.attachHeatmap(r.emptyDraft(),heat);d.matchStartSeconds=50;d.matchId='same';
const phases=r.phaseSummary(heat,p,'right',50);assert.deepEqual(phases.map(p=>p.seconds),[60,60,60]);assert.deepEqual(phases.map(p=>p.zone),[0,1,2]);assert(phases.every(p=>p.reliable));assert.deepEqual(r.phaseSummary(heat,p,'left',50).map(p=>p.zone),[2,1,0]);
const split=r.phaseSummary(heat,{...p,positions:[{t:349,x:.5,y:.5,seconds:2}]},'right',50);assert.deepEqual(split.map(p=>p.seconds),[1,1,0]);assert(split.every(p=>!p.reliable));
const story=r.commentDraft(heat,p,d.players[p.id],[],'right',50);assert.match(story.heatComment,/초반보다 후반/);assert.match(story.heatComment,/상대 골문/);assert(!story.heatComment.includes('%'));assert.match(story.eventComment,/연결된 이벤트가 없어요/);
const shot=(id,team,num,x=38,y=3)=>({id,type:'XG',team,player_number:num,player_name:'',is_goal:false,shot_x:x,shot_y:y,xg:.2,clock_ms:10000});
d.fla={matchId:'same',events:[shot('a','HOME','7'),shot('b','AWAY','7'),shot('c','HOME',''),shot('missing','HOME','7',null,null)]};
let mapped=e.eventMapData(d,d.players[p.id]);assert.equal(mapped.personal.length,0,'Initial CV jersey cannot silently identify a FLA shirt number');assert.deepEqual(mapped.markers.slice(0,2).map(m=>[m.x,m.y]),[[38,17],[2,3]]);assert.equal(mapped.missing,1);
d.players[p.id].flaNumber='07';mapped=e.eventMapData(d,d.players[p.id]);assert.equal(mapped.personal.length,2);assert(mapped.markers.filter(m=>m.personal).every(m=>m.side==='home'));
d.homeDirection='left';assert.deepEqual(e.eventMapData(d,d.players[p.id]).markers.slice(0,2).map(m=>[m.x,m.y]),[[2,3],[38,17]]);d.homeDirection='right';
d.fpa={rows:[{Team:'home',Player:'7',Action:'Shot',Time:'0:10',StartX:'38',StartY:'3',Direction:'right'},{Team:'home',Player:'7',Action:'Acquisition',StartX:'12',StartY:'4',Direction:'right'},{Team:'home',Player:'7',Action:'Block',StartX:'5',StartY:'6',Direction:'right'},{Team:'home',Player:'7',Action:'Tackle',Tags:'Fail'}],logs:[]};
mapped=e.eventMapData(d,d.players[p.id]);assert.equal(mapped.markers.length,5,'Same FPA and FLA shot is not doubled');assert.equal(mapped.markers.filter(m=>m.kind==='recovery').length,1);assert.equal(mapped.markers.filter(m=>m.kind==='defense').length,1);
d.players[p.id].heatComment='직접 쓴 활동 이야기';d.players[p.id].strengths[0]='내가 쓴 장점';const rendered=e.reportPlayer(d);assert.equal(rendered.person.heatComment,'직접 쓴 활동 이야기');assert.equal(rendered.person.strengths[0],'내가 쓴 장점');assert.match(rendered.person.eventComment,/공을 되찾은/);assert.match(rendered.person.strengths[2],/슈팅/);assert.match(rendered.person.improvements[1],/동료/);
d.fla.matchId='other';assert(e.eventMapData(d,d.players[p.id]).markers.every(m=>m.source==='fpa'));
console.log('PASS: five-minute clipping and coverage gates; warm grounded stories; explicit FLA shirt binding; both-team orientation; no-coordinate exclusion; shot deduplication; defense vs recovery; manual edits preserved.');

const clubs=load('apps/web/lib/futsal-clubs.ts'),teams=load('apps/web/lib/futsal-team-report.ts'),logos=load('apps/web/lib/futsal-team-logos.ts');
assert.equal(clubs.FUTSAL_CLUBS.length,29);assert.equal(clubs.clubName('수원fc'),'수원 FC');assert.equal(clubs.clubName('수원삼성'),'수원 삼성');assert.equal(clubs.clubName('FC서울'),'FC 서울');assert.equal(clubs.clubName('서울E'),'서울 이랜드');assert.equal(clubs.clubName('연맹연합'),'연맹연합');
assert(clubs.FUTSAL_CLUBS.every(c=>logos.teamLogo(c.name)),'Every full club name resolves its existing logo');
let options=teams.reportTeamOptions({homeName:'안양',awayName:'대전',teamReport:teams.defaultTeamReport()});assert.equal(options.homeColor,'#4A227A');assert.equal(options.awayColor,'#992941');
options=teams.reportTeamOptions({homeName:'안양',awayName:'대전',teamReport:{...options,homeColor:'#FF7400',homeColorCustom:true}});assert.equal(options.homeColor,'#FF7400','Explicit custom colors, even legacy defaults, are kept');
d.fpa=null;d.fla={matchId:'same',summary:{lanes:{home:{left_count:0,center_count:0,right_count:0,total_count:0}}},events:[shot('a','AWAY',''),shot('b','AWAY','')]};d.players[p.id].heatComment='';
const awayOnly=e.eventMapData(d,d.players[p.id]);assert.equal(awayOnly.markers.length,2);assert(awayOnly.markers.every(m=>m.side==='away'&&m.x<20),'Away-only source stays away-only, no invented home shots');
const narrative=e.reportPlayer(d).generated.eventComment;assert.match(narrative,/상대의 슈팅/);assert.doesNotMatch(narrative,/공격에 직접 참여|볼을 되찾/);assert(narrative.length>200);
console.log('PASS: full club names/logos and colors; explicit color overrides; honest one-team shot map and activity/event contextual story.');

const assignment=load('apps/web/lib/futsal-report-assignment.ts'),roles=load('apps/web/lib/futsal-report-positions.ts');
const people=assignment.assignmentPlayers([{id:p.id,group:'home',jersey:'4',box:[.1,.1,.2,.2]},{id:'home_gk-1',group:'home_gk',jersey:'1',box:[.01,.4,.04,.5]}]);
assert.throws(()=>assignment.assignmentPlayers([{id:'bad',group:'home',jersey:'4',box:[.1,.1,.05,.2]}]));
d.sourceSnapshot={id:'a'.repeat(32),jobId:'b'.repeat(32),version:1,createdAt:'now'};d.assignment={jobId:'b'.repeat(32),time:0,width:1600,height:900,image:'data:image/png;base64,aQ==',players:people};
assert.equal(assignment.assignmentNumber(d,p.id),'4','Report reference uses the actual initial number, not an edited shirt label');assert.equal(assignment.assignmentRows(d,'home')[0].id,'home_gk-1');assert.equal(assignment.assignmentRows(d,'home')[0].role.value,'GK');
assert.equal(roles.reportRole('PIVO').value,'FW');assert.equal(roles.reportRole('FIXO').value,'DF');assert.equal(roles.reportRole('ALA').value,'MF');
for(const role of roles.REPORT_ROLES){d.players[p.id].position=role.value;const comments=e.reportPlayer(d).generated;assert(comments.heatComment.includes(role.short));assert(comments.eventComment.includes(role.short));assert.equal(comments.improvements[0],role.next);}
d.players[p.id].name='';assert.equal(e.reportPlayer(d).person.name,'');assert.throws(()=>assignment.validateAssignment({...d.assignment,image:'https://example.com/frame.png'}));
console.log('PASS: validated initial frame coordinates; immutable analysis numbers; keeper-inclusive roster; paired football/futsal roles personalize stories without player names.');
