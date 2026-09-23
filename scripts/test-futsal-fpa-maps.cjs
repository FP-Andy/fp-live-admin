const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('../apps/web/node_modules/typescript');
function load(file){const module={exports:{}};Function('exports','require',ts.transpile(fs.readFileSync(file,'utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}))(module.exports,()=>load('apps/web/components/futsal/graphics.ts'));return module.exports;}
const {parseFpa,filterEvents,mapEvents,displayPoint,fpaGraphic,filteredMapEvents,defaultMapFilters,distanceBand,isDefense}=load('apps/web/components/futsal/fpaGraphics.ts');
const logs=['1H | away | left | 00:00 | Pos(0, 20) | 1 Pass to 2 | Pos(40, 0) | Tags: Success | Sport: FUTSAL','1H | home | right | 00:00 | Pos(10, 5) | 1 Shot | Tags: Goal, Success','1H | away | left | 00:00 | Pos(1, 2) | 2 Dribble | Pos(3, 4) | Path(1,2;2,3;3,4) | Tags: Fail'];
const events=parseFpa({logs,rows:[]});
assert.equal(events.length,3);assert.equal(events[0].receiver,'2');assert.deepEqual(events[0].points,[{x:0,y:20},{x:40,y:0}]);assert(events[1].goal);assert.equal(events[2].points.length,3);
assert.deepEqual(displayPoint({x:0,y:20},'left',false),{x:160,y:250});assert.deepEqual(displayPoint({x:0,y:20},'left',true),{x:1440,y:890});
assert.equal(filterEvents(events,0,2,'all','away:1').length,1);assert.equal(filterEvents(events,1,2,'all','all').length,2);
assert.deepEqual(mapEvents(events,'sequence',new Set([2,0])).map(e=>e.index),[0,2]);assert.equal(mapEvents(events,'pass',new Set()).length,1);assert.equal(mapEvents(events,'shot',new Set()).length,1);
const invalid=parseFpa({logs:['1H | away | left | 00:00 | Pos(41, 5) | 1 Pass to 2 | Pos(3, 4)','1H | away | left | 00:00 | Pos(1, 2) | 2 Dribble | Pos(3, 4) | Path(1,2;99,3;3,4)'],rows:[]});assert.equal(invalid[0].points.length,0);assert.equal(invalid[1].points.length,1);
const svg=fpaGraphic({id:'test',name:'A & B vs <C>'},events,'sequence',{home:'#ff7400',away:'#2158e8',background:'transparent'},false,'#1–3');assert(svg.includes('A &amp; B vs &lt;C&gt;'));assert(!svg.includes('NaN'));assert(svg.includes('width="1600" height="1000"'));assert(!svg.includes('<rect width="1600"'));
if(process.argv[2]){const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))[0], all=parseFpa(fixture);assert.equal(all.length,125);assert.equal(mapEvents(all,'shot',new Set()).length,19);assert.equal(all.filter(e=>e.action==='Pass').length,51);assert(all.every(e=>e.points.length));assert.equal(new Set(all.map(e=>e.player)).size,6);console.log('Real Queen Cup fixture: 125 events, 51 passes, 19 shots, 6 players; all coordinates valid.');}
console.log('FPA maps: parsing, full paths, coordinate orientation, bounds, missing positions, player/team/range filters, sequence ordering and SVG escaping passed.');

const base={...events[0],action:'Pass',points:[{x:0,y:0},{x:20,y:0}]};
assert.equal(distanceBand(base,20,40),'medium');
assert.equal(distanceBand({...base,points:[{x:0,y:0},{x:40,y:0}]},20,40),'long');
assert.equal(distanceBand({...base,points:[{x:0,y:0},{x:19.99,y:0}]},20,40),'short');
assert.equal(distanceBand(base,10,20),'long');
assert.equal(distanceBand({...base,points:[{x:0,y:0}]},20,40),'unknown');
const defense=[{...base,index:0,action:'Tackle',tags:['Success','Foot'],outcome:'success'},{...base,index:1,action:'Save',tags:['Fail','Punch'],outcome:'fail'},{...base,index:2,action:'Intercept',tags:['Success','Foot'],outcome:'success'}];
assert(!isDefense({...base,action:'Blocked Shot'}));
assert.equal(filteredMapEvents(defense,'defense',new Set(),{...defaultMapFilters,actions:['Tackle','Save'],tags:['Foot','Punch']}).length,2);
assert.equal(filteredMapEvents(defense,'defense',new Set(),{...defaultMapFilters,actions:['Tackle','Save'],tags:['Foot','Punch'],outcome:'fail'}).length,1);
assert.equal(filteredMapEvents(defense,'defense',new Set(),{...defaultMapFilters,distance:'long'}).length,3);
assert.equal(filteredMapEvents([base],'pass',new Set(),{...defaultMapFilters,actions:['Save'],tags:['Punch']}).length,1);
assert.equal(filteredMapEvents([base],'pass',new Set(),{...defaultMapFilters,distance:'short'}).length,0);
assert.equal(filteredMapEvents([{...base,action:'Kick-in'}],'pass',new Set(),defaultMapFilters).length,0);
if(process.argv[2]){const all=parseFpa(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))[0]);assert.equal(mapEvents(all,'kickin',new Set()).length,15);assert.equal(mapEvents(all,'defense',new Set()).length,31);assert.equal(mapEvents(all,'pass',new Set()).length,51);}
console.log('Detailed defense, outcome and tag combinations, kick-in isolation, pass boundaries and missing distance passed.');
