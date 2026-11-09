const {test}=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../components/fpa/fpa-log-edit.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {parseStatCode,composeStatCode,positionsFromLog,draftFromRow,draftDots,sameDraftShot}=context.exports;
const plain=(v)=>JSON.parse(JSON.stringify(v));

test('stat code splits into player/action/receiver/tags and back unchanged',()=>{
 for(const code of ['9cc11','11dd.h','10ss7.p.up','4','pr','3q']){
  const parts=parseStatCode(code);
  assert.ok(parts,code);
  assert.equal(composeStatCode(parts),code);
 }
 assert.deepEqual(plain(parseStatCode('9CC11.H')),{player:'9',action:'cc',receiver:'11',tags:'h'});
 assert.equal(parseStatCode('9-x'),null);
 assert.equal(composeStatCode({player:'9',action:'',receiver:'11',tags:''}),'9','touch has no receiver');
 assert.equal(composeStatCode({player:'7',action:'d',receiver:'',tags:' h, up .wf'}),'7d.h.up.wf');
});

test('positions: first Pos is position, last Pos is receive, dribble path keeps middle points',()=>{
 const pass='1H | home | right | 01:24 | Pos(70.8, 39.6) | 9 Cross to 11 | Pos(94.2, 36.3) | Tags: Success';
 assert.deepEqual(plain(positionsFromLog({Coord:'Pos(70.8, 39.6)'},pass)),{pos:{x:70.8,y:39.6},recv:{x:94.2,y:36.3},via:[]});
 const shot='1H | home | right | 01:26 | Pos(94.2, 36.3) | 11 Shot | Tags: Header';
 assert.deepEqual(plain(positionsFromLog({Coord:'Pos(94.2, 36.3)'},shot)),{pos:{x:94.2,y:36.3},recv:null,via:[]});
 const drib=positionsFromLog({Coord:'Pos(55.1, 41.7)',PathPoints:'55.1,41.7;63.4,44;70.8,39.6'},'1H | home | right | 01:20 | Pos(55.1, 41.7) | 9 Dribble | Pos(70.8, 39.6) | Path(55.1,41.7;63.4,44;70.8,39.6)');
 assert.deepEqual(plain(drib),{pos:{x:55.1,y:41.7},recv:{x:70.8,y:39.6},via:[{x:63.4,y:44}]});
});

test('draft from a saved row rebuilds the same request the live input sent',()=>{
 const log='2H | away | left | 63:44 | Pos(88.6, 40.2) | 11 Shot | Pos(91.0, 38.7) | Tags: Blocked, Fail';
 const d=draftFromRow({Time:'63:44',Team:'away',Coord:'Pos(88.6, 40.2)'},log,'11db');
 assert.equal(d.half,'2H');assert.equal(d.direction,'left');assert.equal(d.team,'away');
 assert.equal(composeStatCode(d),'11db');
 assert.deepEqual(plain(draftDots(d)),[{x:88.6,y:40.2},{x:91,y:38.7}]);
 assert.equal(sameDraftShot(d,{...d,time:'63:50',half:'1H'}),true,'time/half do not change the shot');
 assert.equal(sameDraftShot(d,{...d,recv:{x:90,y:38}}),false);
 assert.equal(draftFromRow({},log,''),null,'no code → cannot edit here');
});
