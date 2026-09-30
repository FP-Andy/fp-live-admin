// Deterministic blocked masking experiment. The reference is CV coordinates,
// not independent human ground truth. Nothing is uploaded or written to FPC.
// Usage: node scripts/fpa-cv-heatmap-reconstruction-experiment.mjs train.json holdout.json output-dir
import fs from 'node:fs';
import path from 'node:path';
import {reconstructGap,reconstructPlayer,occupancyGrid,RECONSTRUCTION_VERSION} from '../apps/web/public/fpa-cv/heatmap-reconstruction.mjs';
const [trainFile,holdoutFile,outDir]=process.argv.slice(2);
if(!outDir)throw Error('Supply training export, held-out export and output directory.');
fs.mkdirSync(outDir,{recursive:true});
const train=JSON.parse(fs.readFileSync(trainFile)),holdout=JSON.parse(fs.readFileSync(holdoutFile));
if(train.datasetId===holdout.datasetId)throw Error('Use different matches for train and held-out evaluation.');
const durations=[.5,1,2,3,5,10],context=1.2,limit=12;
let seed=20260930;const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
const sum=a=>a.reduce((s,x)=>s+x,0),mean=a=>a.length?sum(a)/a.length:null;
const percentile=(a,q)=>a.length?[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(q*(a.length-1)))]:null;
const d=(a,b)=>Math.hypot((a.x-b.x)*40,(a.y-b.y)*20);
function grid(samples){return occupancyGrid(samples.map(p=>({...p,sigma:Math.hypot(p.sigma||0,.75)})),{width:40,height:20});}
function add(a,b){return Float64Array.from(a,(v,i)=>v+b[i]);}
function tv(a,b){const x=sum(a),y=sum(b);return a.reduce((s,v,i)=>s+Math.abs((x?v/x:0)-(y?b[i]/y:0)),0)/2;}
function zones(samples){const z=new Float64Array(9);for(const p of samples)z[Math.min(2,Math.floor(p.y*3))*3+Math.min(2,Math.floor(p.x*3))]+=p.seconds;return z;}
function continuousRuns(p){
  const runs=[];let run=[];
  for(const point of p.positions){
    const prev=run.at(-1);
    if(prev&&(point.trackId!==prev.trackId||point.t-prev.t-prev.seconds>.03||point.t<=prev.t||d(point,prev)/(point.t-prev.t)>8)){if(run.length)runs.push(run);run=[];}
    run.push(point);
  }
  if(run.length)runs.push(run);return runs;
}
function casesFor(data,training,requestedDurations=durations){
  const cases=[];
  for(const player of data.players){
    const runs=continuousRuns(player);
    for(const duration of requestedDurations){
      const pool=[];
      for(const run of runs){
        let next=run[0].t+context;
        for(let i=1;i<run.length-1;i++){
          const from=run[i].t;
          if(from<next)continue;next=from+.5;
          // Training uses only the first half; full held-out match is untouched
          // until the training-based profile has been selected.
          if(training&&from+duration+context>data.from+data.duration/2)continue;
          let j=i;while(j<run.length&&run[j].t<from+duration-1e-6)j++;
          if(j>=run.length)continue;
          let l=i-1,r=j;
          while(l>0&&run[i-1].t-run[l-1].t<=context+1e-6)l--;
          while(r+1<run.length&&run[r+1].t-run[j].t<=context+1e-6)r++;
          if(run[i-1].t-run[l].t<.8||run[r].t-run[j].t<.8)continue;
          const left=run.slice(l,i),right=run.slice(j,r+1),hidden=run.slice(i,j);
          const visible=[...left,...right],truth=[...visible,...hidden];
          const visibleGrid=grid(visible),truthGrid=grid(truth);
          pool.push({playerId:player.id,duration,from,to:run[j].t,left,right,hidden,visible,visibleGrid,truthGrid,
            truthZones:zones(truth),visibleZones:zones(visible),baselineTV:tv(visibleGrid,truthGrid)});
        }
      }
      for(let i=pool.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
      const selected=[];
      for(const c of pool){
        // Prevent windows at the same duration from sharing visible/hidden data.
        if(selected.some(s=>c.from-context<s.to+context&&c.to+context>s.from-context))continue;
        selected.push(c);if(selected.length>=limit)break;
      }
      cases.push(...selected);
    }
  }
  return cases;
}
const candidates=[{method:'linear',diffusion:0},{method:'hermite',diffusion:0},
  ...['bridge-linear','bridge-hermite'].flatMap(method=>[.05,.15,.5].map(diffusion=>({method,diffusion})))];
const name=c=>`${c.method}${c.diffusion?`-${c.diffusion}`:''}`;
function evaluate(cases,parameters){
  const rows=[];
  for(const c of cases){
    const reconstructed=reconstructGap(c.left,c.right,{...parameters,maxGapSeconds:11});
    let inferred=[],rmse=null;
    if(reconstructed.accepted){
      inferred=reconstructed.samples;let error=0;
      for(const p of inferred){let ref=c.hidden[0];for(const q of c.hidden){if(Math.abs(q.t-p.t)<Math.abs(ref.t-p.t))ref=q;}
        error+=d(p,ref)**2*p.seconds;}
      rmse=Math.sqrt(error/reconstructed.seconds);
    }
    const estimateGrid=grid(inferred),zoneGrid=zones(inferred);
    rows.push({playerId:c.playerId,duration:c.duration,from:c.from,to:c.to,accepted:reconstructed.accepted,reason:reconstructed.reason,
      referenceManualShare:c.hidden.filter(p=>p.source==='manual').length/c.hidden.length,
      baselineTV:c.baselineTV,reconstructionTV:tv(add(c.visibleGrid,estimateGrid),c.truthGrid),
      baselineZoneTV:tv(c.visibleZones,c.truthZones),zoneTV:tv(add(c.visibleZones,zoneGrid),c.truthZones),rmse});
  }
  const bins=[...new Set(cases.map(c=>c.duration))].sort((a,b)=>a-b).map(duration=>{
    const selected=rows.filter(r=>r.duration===duration),accepted=selected.filter(r=>r.accepted),baselineTV=mean(selected.map(r=>r.baselineTV)),reconstructionTV=mean(selected.map(r=>r.reconstructionTV));
    return {duration,n:selected.length,accepted:accepted.length,acceptance:selected.length?accepted.length/selected.length:0,
      baselineTV,reconstructionTV,relativeImprovement:baselineTV?(baselineTV-reconstructionTV)/baselineTV:null,
      baselineZoneTV:mean(selected.map(r=>r.baselineZoneTV)),zoneTV:mean(selected.map(r=>r.zoneTV)),
      meanGapRMSEM:mean(accepted.map(r=>r.rmse)),p95GapRMSEM:percentile(accepted.map(r=>r.rmse),.95)};
  });
  return {parameters,bins,rows};
}
console.log('Sampling training windows');
const trainingCases=casesFor(train,true);
console.log('Training cases:',trainingCases.length);
const training=candidates.map(c=>{const result=evaluate(trainingCases,c);console.log(name(c),result.bins.map(b=>`${b.duration}s:${b.n}/${(100*(b.relativeImprovement||0)).toFixed(1)}%`).join(' '));return result;});
// Predeclared selection rule: >= 30 cases/bin, >= 60% accepted, >= 5%
// distribution improvement AND 95th-percentile gap RMSE <= 1.5 m. Select on
// training only, then check the same criteria on a different match.
const eligible=[];
for(const candidate of training){
  let maxGap=0;
  for(const bin of candidate.bins){
    if(bin.n<30||bin.acceptance<.6||bin.relativeImprovement<.05||bin.p95GapRMSEM>1.5)break;
    maxGap=bin.duration;
  }
  if(maxGap)eligible.push({candidate,maxGap,score:mean(candidate.bins.filter(b=>b.duration<=maxGap).map(b=>b.reconstructionTV/b.baselineTV))});
}
eligible.sort((a,b)=>b.maxGap-a.maxGap||a.score-b.score);
const chosen=eligible[0];
const selected=chosen?{...chosen.candidate.parameters,maxGapSeconds:chosen.maxGap}:null;
console.log('Training selection:',selected);
const holdoutCases=casesFor(holdout,false);
// All methods are exported for inspection, but only training chooses the model.
const heldout=candidates.map(c=>evaluate(holdoutCases,c));
const validation=selected?heldout.find(c=>name(c.parameters)===name(selected)):null;
const holdoutPass=!!validation&&validation.bins.filter(b=>b.duration<=selected.maxGapSeconds).every(b=>b.n>=30&&b.acceptance>=.6&&b.relativeImprovement>=.05&&b.p95GapRMSEM<=1.5);
const actual=[];
for(const source of [train,holdout]){
  const start=performance.now(),players=selected?source.players.map(p=>({...p,reconstruction:reconstructPlayer(p,selected)})):source.players;
  const output={...source,experiment:{algorithm:RECONSTRUCTION_VERSION,selected,holdoutPass,notForProduction:true},players};
  fs.writeFileSync(path.join(outDir,`${source===train?'training':'heldout'}-preview.json`),JSON.stringify(output));
  actual.push({datasetId:source.datasetId,video:source.video,duration:source.duration,seconds:(performance.now()-start)/1000,
    players:players.map(p=>({id:p.id,group:p.group,jersey:p.jersey,coverage:p.coverage,observed:p.observed,
      inferredSeconds:p.reconstruction?.inferredSeconds||0,gaps:p.reconstruction?.gaps.length||0,rejected:p.reconstruction?.rejected||{}}))});
}
// Actual gaps are often a single missing sample. Check these separately after
// selecting the model; do not change the selection based on the extra test.
const microTraining=selected?evaluate(casesFor(train,true,[.05,.2]),selected):null;
const microHeldout=selected?evaluate(casesFor(holdout,false,[.05,.2]),selected):null;
const microPass=!!microHeldout&&microHeldout.bins.every(b=>b.n>=30&&b.acceptance>=.6&&b.relativeImprovement>=.05&&b.p95GapRMSEM<=1.5);
const result={algorithm:RECONSTRUCTION_VERSION,createdAt:new Date().toISOString(),selected,holdoutPass,microPass,microTraining,microHeldout,
  referenceLimit:'Held-out CV observations are a proxy reference, not independent video identity ground truth. Masked continuous runs underrepresent real occlusions and identity switches.',
  protocol:{durations,contextSeconds:context,maxCasesPerPlayerPerDuration:limit,seed:20260930,
    train:{datasetId:train.datasetId,video:train.video,source:train.experimentSource,range:[train.from,train.from+train.duration/2]},
    holdout:{datasetId:holdout.datasetId,video:holdout.video,source:holdout.experimentSource},
    metric:'Total variation between normalised occupancy in a masked window plus visible context; 0.75 m Gaussian measurement smoothing on a 1 m grid.',
    rule:'Every duration up to limit: n>=30, acceptance>=0.6, TV improvement>=0.05, P95 gap RMSE<=1.5 m. Model selected before examining held-out match.'},
  training,heldout,actual};
fs.writeFileSync(path.join(outDir,'results.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({selected,holdoutPass,trainingCases:trainingCases.length,holdoutCases:holdoutCases.length,
  validation:validation?.bins,actual:actual.map(a=>({video:a.video,meanObserved:mean(a.players.map(p=>p.coverage)),meanAddedPercentagePoints:mean(a.players.map(p=>p.inferredSeconds/a.duration*100)),seconds:a.seconds}))},null,2));
