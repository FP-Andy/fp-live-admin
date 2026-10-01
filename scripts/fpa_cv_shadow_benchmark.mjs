import fs from 'node:fs';import {gunzipSync} from 'node:zlib';
import {validateDataset,validateReview} from '../apps/web/public/fpa-cv/core.mjs';
import {reconnect} from '../apps/web/public/fpa-cv/identity.mjs';
import {effectiveSegments} from '../apps/web/public/fpa-cv/integrity.mjs';
import {buildHeatmaps} from '../apps/web/public/fpa-cv/heatmaps.mjs';
import {packRecovery,hydrateRecovery} from '../apps/web/public/fpa-cv/recovery-protocol.mjs';
import {normalizeShadowBodies} from '../apps/web/public/fpa-cv/shadow-bodies.mjs';
import assert from 'node:assert/strict';

const [path,output,seconds='90']=process.argv.slice(2);
if(!path||!output)throw Error('Usage: node scripts/fpa_cv_shadow_benchmark.mjs input.json[.gz] output.json [seconds]');
const bytes=fs.readFileSync(path),input=JSON.parse(path.endsWith('.gz')?gunzipSync(bytes):bytes);
const all=validateDataset(input.tracks),saved=validateReview(input.review||input.savedReview||input.initial,all);
let review={...saved,...saved.batch?.applied};
const end=Math.min(all.video.clipEnd,all.video.clipStart+Number(seconds));
const frames=all.frames.filter(f=>f.t<end),observations=new Map();
for(const f of frames)for(const b of f.boxes){const t=observations.get(b.id)||{id:b.id,first:f.t,last:f.t,samples:0};t.last=f.t;t.samples++;observations.set(b.id,t);}
const data={...all,video:{...all.video,clipEnd:end},frames,tracks:[...observations.values()]};
review={...review,segments:review.segments.filter(s=>s.from<end).map(s=>({...s,to:Math.min(end,s.to)})),checkpoints:(review.checkpoints||[]).filter(c=>c.time<end)};
const result={from:data.video.clipStart,to:end,frames:frames.length,cases:{}};
for(const enabled of [false,true]){
 const started=performance.now(),r={...review,shadowCorrection:enabled},recovered=reconnect(data,r);
 const heat=buildHeatmaps(recovered.data,{...r,segments:effectiveSegments(r,recovered)});
 const packed=packRecovery(recovered,data),hydrated=hydrateRecovery(packed,data);
 assert.deepEqual(hydrated.data.frames,recovered.data.frames,'worker/cache must preserve geometry and colour correction');
 const mode=enabled?'bodyShadow':'baseline';
 result.cases[mode]={seconds:(performance.now()-started)/1000,shadow:recovered.shadowBodies,observations:recovered.data.frames.reduce((n,f)=>n+f.boxes.length,0),masks:recovered.masks.filter(m=>m.personId==='away-2'),meanCoverage:heat.players.reduce((s,p)=>s+p.coverage,0)/heat.players.length,players:heat.players.map(p=>({id:p.id,number:p.jersey,coverage:p.coverage,observed:p.observed,excluded:p.excludedReasons})),duplicates:recovered.duplicates.filter(d=>d.reason==='body-shadow')};
 console.log(mode,JSON.stringify({...result.cases[mode],duplicates:result.cases[mode].duplicates.length}));
}
// Later contact scenes are checked independently for deduplication, using
// surrounding observations so prior independent people are still protected.
result.geometryWindows=[];
for(const [from,to] of [[230,255],[585,615]]){
 const scene={...all,frames:all.frames.filter(f=>f.t>=from-2&&f.t<=to+2)};
 const out=normalizeShadowBodies(scene,{...review,shadowCorrection:true});
 result.geometryWindows.push({from,to,frames:scene.frames.length,...out.shadowBodies});
}
fs.writeFileSync(output,JSON.stringify(result,null,2));
