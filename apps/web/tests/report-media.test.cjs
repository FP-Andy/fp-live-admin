const {test}=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function load(name){const scope={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/'+name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,scope);return scope.exports;}
const {teamLogo}=load('futsal-team-logos');
const {bufferedSeconds,sameVideoFile}=load('video-buffer');
test('all 39 fixture teams map to supplied assets, with explicit missing clubs',()=>{
 const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'../../api/app/data/queen-cup-fla-2026.json')));
 const missing=new Set();
 for(const f of fixtures)for(const name of [f.home,f.away]){const logo=teamLogo(name);if(logo)assert.ok(fs.existsSync(path.join(__dirname,'../public',logo)),name);else missing.add(name);}
 assert.deepEqual([...missing].sort(),['연맹연합','파주']);
 assert.notEqual(teamLogo('서울'),teamLogo('서울E'));
 assert.equal(teamLogo('FC 서울'),teamLogo('서울'));
 assert.equal(teamLogo('수원FC'),teamLogo('수원fc'));
 assert.equal(teamLogo('충북청주'),teamLogo('청주'));
 assert.equal(teamLogo('김천상무'),teamLogo('김천'));
});
test('buffer indicator handles gaps and reports playable time at selected speed',()=>{
 const r={length:2,start:i=>[0,30][i],end:i=>[20,60][i]};
 assert.equal(bufferedSeconds(r,10,2),5);assert.equal(bufferedSeconds(r,25,1),0);assert.equal(bufferedSeconds(r,40,.5),40);
});
test('local playback accepts Unicode-normalized identical original, rejects edits',()=>{
 const u={name:'경남.MP4',size:1234};
 assert.equal(sameVideoFile({name:u.name.normalize('NFD'),size:1234},u),true);
 assert.equal(sameVideoFile({name:u.name,size:1200},u),false);
 assert.equal(sameVideoFile({name:'다른 경기.MP4',size:1234},u),false);
});
