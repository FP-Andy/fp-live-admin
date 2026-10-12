const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),ts=require('../apps/web/node_modules/typescript');
const compiled=ts.transpileModule(fs.readFileSync('apps/web/lib/substitution-scenes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const output={},calls=new Map();let active=0,peak=0,counter=0,fail=true;
vm.runInNewContext(compiled,{exports:output,AbortSignal,URL:{createObjectURL:()=>`blob:${++counter}`,revokeObjectURL:()=>{}},setTimeout,
 fetch:async url=>{calls.set(url,(calls.get(url)||0)+1);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;if(url==='error'&&fail)throw Error('network');return{ok:true,status:200,blob:async()=>({type:'image/jpeg',size:10})};}});
(async()=>{const a=output.substitutionScene('same'),b=output.substitutionScene('same');assert.equal(a,b);
 await Promise.all([a,...Array.from({length:12},(_,i)=>output.substitutionScene('frame-'+i))]);assert.equal(peak,2);assert.equal(calls.get('same'),1);
 await output.substitutionScene('frame-5');assert.equal(calls.get('frame-5'),1);
 await assert.rejects(output.substitutionScene('error'));fail=false;await output.substitutionScene('error');assert.equal(calls.get('error'),2);
 console.log('PASS: two frame requests maximum, shared in-flight/cache, failed request can be retried.');})().catch(e=>{console.error(e);process.exitCode=1;});
