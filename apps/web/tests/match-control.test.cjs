const {test}=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
let request;
const context={exports:{},Date,AbortController,setTimeout,clearTimeout,require:()=>({apiFetch:(...args)=>request(...args)})};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/match-control.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {elapsedMatchMs,restoredMatchMs,matchControlJson}=context.exports;
test('90 minutes retain elapsed time across repeated suspended performance-clock intervals',()=>{
 const wallStart=1000000;let perf=0,previous=0;
 for(let second=1;second<=5400;second++){
  if(second%600>=20)perf+=1000;
  const clock=elapsedMatchMs(0,wallStart,perf,wallStart+second*1000);
  assert.equal(clock,second*1000);assert(clock>=previous);previous=clock;
 }
});
test('UTC server anchors restore elapsed running time and respect pause and 2x speed',()=>{
 const state={clock_ms:5000,running:true,sampled_at:'2026-10-11T01:00:00Z',server_now:'2026-10-11T01:01:35Z'};
 assert.equal(restoredMatchMs(state),100000);
 assert.equal(restoredMatchMs({...state,clock_speed:2}),195000);
 assert.equal(restoredMatchMs({...state,running:false}),5000);
 assert.equal(restoredMatchMs({...state,sampled_at:undefined}),5000);
 assert.equal(elapsedMatchMs(0,100000,2000,50000),2000);
});
test('timeout also bounds a stalled response body',async()=>{
 request=async(_path,init)=>({ok:true,json:()=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('body timeout'))))});
 await assert.rejects(matchControlJson('/fixture',undefined,10),/body timeout/);
});
