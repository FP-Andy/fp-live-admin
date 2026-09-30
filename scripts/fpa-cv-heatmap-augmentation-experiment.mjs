// Expanded activity estimation. Uses the same two proxy-reference matches as
// experiment 1; these are NOT a newly unseen independent test set.
import fs from 'node:fs';
import path from 'node:path';
import {augmentPlayerActivity,estimateActivityGap,AUGMENTATION_VERSION} from '../apps/web/public/fpa-cv/heatmap-augmentation.mjs';
import {occupancyGrid} from '../apps/web/public/fpa-cv/heatmap-reconstruction.mjs';
const [firstFile,secondFile,outDir]=process.argv.slice(2);if(!outDir)throw Error('Supply two observed heatmaps and the existing experiment result directory.');
const data=[JSON.parse(fs.readFileSync(firstFile)),JSON.parse(fs.readFileSync(secondFile))];
const sum=a=>a.reduce((s,v)=>s+v,0),mean=a=>a.length?sum(a)/a.length:null,normal=a=>{const s=sum(a);return Float64Array.from(a,n=>s?n/s:0);};
const options={width:40,height:20,courtWidth:40,courtHeight:20};
function smooth(a){const samples=[];for(let i=0;i<a.length;i++)if(a[i]>0)samples.push({x:(i%40+.5)/40,y:(Math.floor(i/40)+.5)/20,seconds:a[i],sigma:.75});return normal(occupancyGrid(samples,options));}
function tv(a,b){return sum(a.map((v,i)=>Math.abs(v-b[i])))/2;}
function zones(a){const z=new Float64Array(9);for(let y=0;y<20;y++)for(let x=0;x<40;x++)z[Math.min(2,Math.floor((y+.5)*3/20))*3+Math.min(2,Math.floor((x+.5)*3/40))]+=a[y*40+x];return z;}
function topZones(a,count=3){return [...a].map((v,i)=>({v,i})).filter(x=>x.v>=.01).sort((x,y)=>y.v-x.v).slice(0,count).map(v=>v.i);}
let seed=20260930;const rand=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
const durations=[3,10,30,60],evaluations=[],actual=[];
for(const [index,h] of data.entries()){
  const rows=[];
  for(const p of h.players){
    const points=p.positions;
    const globalGrid=occupancyGrid(points.map(q=>({...q,sigma:1.1})),options);
    for(const seconds of durations){
      const candidates=[];let next=h.from+5;
      for(let i=1;i<points.length;i++){
        if(points[i].t<next)continue;next=points[i].t+10;
        const from=points[i].t;let j=i;while(j<points.length&&points[j].t<from+seconds)j++;
        if(j>=points.length||points[j].t>h.to-5)continue;
        const hidden=points.slice(i,j),mass=sum(hidden.map(q=>q.seconds)),to=points[j].t;
        if(mass/(to-from)<.85||from-points[i-1].t>1||(p.blockedIntervals||[]).some(b=>b.reason==='outside'&&b.from<to&&b.to>from))continue;
        candidates.push({i,j,from,to,hidden,mass});
      }
      for(let i=candidates.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[candidates[i],candidates[j]]=[candidates[j],candidates[i]];}
      const selected=[];for(const c of candidates){if(selected.some(s=>c.from<s.to&&c.to>s.from))continue;selected.push(c);if(selected.length>=6)break;}
      for(const c of selected){
        const visible=[...points.slice(0,c.i),...points.slice(c.j)],gap={from:c.from,to:c.to,left:points[c.i-1],right:points[c.j]};
        const prediction=estimateActivityGap({...p,positions:visible},gap,options);if(!prediction)continue;
        const reference=smooth(occupancyGrid(c.hidden,options)),estimate=smooth(prediction.grid);
        // A simple alternative: reuse the entire player's visible distribution.
        const hiddenGlobal=occupancyGrid(c.hidden.map(q=>({...q,sigma:1.1})),options);
        const baseline=smooth(Float64Array.from(globalGrid,(v,i)=>Math.max(0,v-hiddenGlobal[i])));
        const actualZones=zones(reference),predictedZones=zones(estimate),baselineZones=zones(baseline),best=topZones(actualZones),top=topZones(predictedZones,best.length);
        rows.push({playerId:p.id,seconds,from:c.from,to:c.to,referenceCoverage:c.mass/(c.to-c.from),kind:prediction.kind,
          distributionTV:tv(reference,estimate),baselineTV:tv(reference,baseline),zoneTV:tv(actualZones,predictedZones),baselineZoneTV:tv(actualZones,baselineZones),topZoneOverlap:best.length?top.filter(i=>best.includes(i)).length/best.length:0});
      }
    }
  }
  evaluations.push({datasetId:h.datasetId,video:h.video,rows,bins:durations.map(seconds=>{const rr=rows.filter(r=>r.seconds===seconds);return {seconds,n:rr.length,distributionTV:mean(rr.map(r=>r.distributionTV)),baselineTV:mean(rr.map(r=>r.baselineTV)),zoneTV:mean(rr.map(r=>r.zoneTV)),baselineZoneTV:mean(rr.map(r=>r.baselineZoneTV)),topZoneOverlap:mean(rr.map(r=>r.topZoneOverlap))};})});
  const previewFile=path.join(outDir,index===0?'training-preview.json':'heldout-preview.json'),preview=JSON.parse(fs.readFileSync(previewFile));
  const started=performance.now(),players=[];
  for(const p of h.players){
    const presets={};for(const ratio of [.2,.3])presets[String(ratio)]=augmentPlayerActivity(p,{from:h.from,to:h.to,targetRatio:ratio,targetBasis:'duration'});
    const a=presets['0.2'];players.push({id:p.id,group:p.group,jersey:p.jersey,coverage:p.coverage,observed:p.observed,inferred:a.inferredSeconds,addedCoverage:a.addedCoverage,targetReached:a.targetReached,knownAbsent:a.knownAbsentSeconds,byKind:a.byKind});
    preview.players.find(q=>q.id===p.id).augmentationPresets=presets;
  }
  preview.activityEstimation={algorithm:AUGMENTATION_VERSION,targetBasis:'duration',defaultRatio:.2,experimental:true};
  fs.writeFileSync(previewFile,JSON.stringify(preview));
  actual.push({datasetId:h.datasetId,video:h.video,duration:h.duration,seconds:(performance.now()-started)/1000,players});
  console.log(JSON.stringify({video:h.video,meanAddedPercentagePoints:mean(players.map(p=>p.addedCoverage*100)),playersReaching20pp:players.filter(p=>p.targetReached).length,evaluation:evaluations.at(-1).bins}));
}
const result={algorithm:AUGMENTATION_VERSION,createdAt:new Date().toISOString(),target:{basis:'duration',fraction:.2},
  note:'Latest user clarification: add 20 percentage points, capped by unobserved eligible time. Not a 20% increase relative to observations.',
  referenceLimit:'Existing CV positions masked in the two previously used matches. No independent identity ground truth; long missing intervals use a personal activity prior and may miss changes of tactics or substitutions.',
  protocol:{durations,minReferenceCoverage:.85,maxCasesPerPlayerPerDuration:6,baseline:'Entire visible personal activity distribution, excluding hidden samples.',metric:'Normalised occupancy total variation; 0 means equal distributions, 1 means disjoint. Coarse zone error uses nine court zones.'},evaluations,actual};
fs.writeFileSync(path.join(outDir,'augmentation-results.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({cases:evaluations.reduce((s,r)=>s+r.rows.length,0),actual:actual.map(a=>({video:a.video,observed:mean(a.players.map(p=>p.coverage)),added:mean(a.players.map(p=>p.addedCoverage)),illustrativeCombined:mean(a.players.map(p=>p.coverage+p.addedCoverage)),seconds:a.seconds}))},null,2));
