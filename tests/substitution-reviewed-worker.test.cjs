const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('apps/web/public/fpa-cv/substitution-report-worker.mjs','utf8').replace(/^import .*;$/gm,'');
async function run(provenance,ok=true){
 const messages=[],urls=[];
 const context={Map,Error,encodeURIComponent,self:{postMessage:m=>messages.push(m)},fetch:async url=>{urls.push(url);return {ok,json:async()=>({provenance,status:'review',heatmap:{players:[]}})}},deriveSubstitutionReport:()=>{throw Error('Must not recompute reviewed data')}};
 vm.runInNewContext(source,context);
 await context.self.onmessage({data:{ticket:4,snapshotId:'s',jobId:'j',saved:{revision:2},redetectionId:'r',reviewedReportId:'v'}});
 return {messages,urls};
}
test('reviewed result bypasses re-derivation and preserves unresolved review status',async()=>{
 const {messages,urls}=await run({snapshotId:'s',jobId:'j',logRevision:2,redetectionId:'r',reviewedReportId:'v'});
 assert.equal(messages[0].result.status,'review');assert.equal(urls.length,1);assert.match(urls[0],/reviewed-report/);
});
test('stale source or rejected server result fails closed',async()=>{
 for(const [p,ok] of [[{snapshotId:'s',jobId:'j',logRevision:1,redetectionId:'r',reviewedReportId:'v'},true],[{},false]]){
 const {messages}=await run(p,ok);assert.ok(messages[0].error);assert.equal(messages[0].result,undefined);
 }
});
