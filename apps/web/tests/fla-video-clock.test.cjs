const {test}=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/fla-video-clock.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {VideoClock,videoHotkey}=context.exports;
const segments=c=>JSON.parse(JSON.stringify(c.pending));
test('media offset, pause and variable playback rate conserve actual media time',()=>{
 const c=new VideoClock({offset_ms:5000,duration_ms:200000,started:true,possession_team:'HOME'});
 c.playing=true;c.tick(6000);c.tick(8000);assert.equal(c.state.frontier_ms,3000);
 c.playing=false;c.tick(8000);assert.equal(c.state.frontier_ms,3000);
 assert.deepEqual(segments(c),[{start_ms:0,end_ms:3000,team:'HOME'}]);
});
test('replay adds no possession, preserves frontier team, then resumes without overlap',()=>{
 const c=new VideoClock({duration_ms:100000,started:true,possession_team:'HOME'});
 c.playing=true;c.tick(10000);assert.equal(c.seek(5000),true);c.choose('AWAY');
 c.playing=true;c.tick(9000);assert.equal(c.state.selected_team,'AWAY');assert.equal(c.state.frontier_ms,10000);
 assert.equal(c.state.possession_team,'HOME');assert.equal(c.seek(9500),false);
 c.tick(11000);assert.equal(c.state.selected_team,'HOME');
 assert.deepEqual(segments(c),[{start_ms:0,end_ms:11000,team:'HOME'}]);
});
test('in-flight save acknowledgement retains new intervals and finish freezes progress',()=>{
 const c=new VideoClock({duration_ms:100000,started:true,possession_team:'HOME'});
 c.playing=true;c.tick(1000);c.tick(2000);c.choose('AWAY');c.tick(3000);c.acknowledge(2,1000);
 assert.deepEqual(segments(c),[{start_ms:1000,end_ms:2000,team:'HOME'},{start_ms:2000,end_ms:3000,team:'AWAY'}]);
 c.state.ended=true;c.tick(10000);assert.equal(c.state.cursor_ms,3000);assert.equal(c.state.frontier_ms,3000);
});
test('physical shortcuts work independent of focused element and ignore repeats/modifiers',()=>{
 for(const code of ['Space','KeyQ','KeyW','KeyE','KeyA','KeyS','KeyD','Enter'])assert.equal(videoHotkey({code}),code);
 assert.equal(videoHotkey({code:'KeyQ',repeat:true}),null);assert.equal(videoHotkey({code:'KeyW',metaKey:true}),null);
});
test('buffer stalls and source reconnection add no wall-time possession',()=>{
 const c=new VideoClock({duration_ms:900000,offset_ms:5000,started:true,possession_team:'HOME'});
 c.playing=true;c.tick(15000);c.playing=false;
 for(let i=0;i<30;i++)c.tick(15000);
 c.playing=true;c.tick(16000);
 assert.equal(c.state.cursor_ms,11000);assert.deepEqual(segments(c),[{start_ms:0,end_ms:11000,team:'HOME'}]);
});
