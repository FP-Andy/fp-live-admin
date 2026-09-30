// Read-only export of the latest applied review for offline reconstruction tests.
// Usage: node scripts/fpa-cv-export-heatmap-experiment.mjs input.json output.json
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {validateDataset,validateReview} from '../apps/web/public/fpa-cv/core.mjs';
import {restoreInitialSeeds} from '../apps/web/public/fpa-cv/initial-recovery.mjs';
import {reconnect} from '../apps/web/public/fpa-cv/identity.mjs';
import {effectiveSegments} from '../apps/web/public/fpa-cv/integrity.mjs';
import {buildHeatmaps,courtProjection} from '../apps/web/public/fpa-cv/heatmaps.mjs';
import {classifyKit} from '../apps/web/public/fpa-cv/keeper-context.mjs';
import {recoverySignature} from '../apps/web/public/fpa-cv/recovery-protocol.mjs';

const [inputPath,outputPath]=process.argv.slice(2);
if(!inputPath||!outputPath)throw Error('Supply an audit input and output path.');
const raw=fs.readFileSync(inputPath),input=JSON.parse(raw),start=Date.now();
const data=validateDataset(input.tracks);
const current=restoreInitialSeeds(validateReview(input.savedReview||input.initial,data),input.initial,data);
const review=current.batch?.applied?{...current,...current.batch.applied}:current;
let last=Date.now();
const progress=p=>{if(Date.now()-last>20000){console.error(p.phase,p.completed,p.total);last=Date.now();}};
const baseline=review.checkpoints?.length?reconnect(data,{...review,checkpoints:[]},progress):null;
const recovered=reconnect(data,review,progress,{baseline});
const working={...review,segments:effectiveSegments(review,recovered)};
const result=buildHeatmaps(recovered.data,working,{point:'bottom'});
// Keep reasons that make filling unsafe. Missing detections and overlap may be
// tested; a contradictory team, duplicate identity or court exit must be held.
const byPerson=new Map(result.players.map(p=>[p.id,p]));
for(const p of result.players)p.blockedIntervals=[];
const segments=new Map();
for(const s of working.segments){const list=segments.get(s.trackId)||[];list.push(s);segments.set(s.trackId,list);}
const project=courtProjection(recovered.data.detector.roi),step=1/recovered.data.detector.sampleFps;
for(const [index,frame] of recovered.data.frames.entries()){
  const from=Math.max(result.from,frame.t),to=Math.min(result.to,frame.t+step,recovered.data.frames[index+1]?.t??result.to);
  if(to<=from)continue;
  const matches=frame.boxes.map(box=>({box,identity:segments.get(box.id)?.find(s=>s.from<=frame.t&&frame.t<s.to)}));
  const counts=new Map();for(const {identity} of matches)if(identity?.personId)counts.set(identity.personId,(counts.get(identity.personId)||0)+1);
  for(const {box,identity} of matches){
    const player=byPerson.get(identity?.personId);if(!player||identity.team==='ignore')continue;
    const color=classifyKit(box,frame.t,review.uniforms,recovered.data.keeperContext);
    const conflict=color.group&&color.group!==player.group&&color.strength>=.22&&color.margin>=.5;
    const xy=project([(box.box[0]+box.box[2])/2,box.box[3]]);
    const reason=counts.get(player.id)>1?'duplicate':conflict?'teamConflict':!xy||xy.some(v=>v<0||v>1)?'outside':null;
    if(reason){
      const prev=player.blockedIntervals.at(-1);
      if(prev?.reason===reason&&from<=prev.to+1e-6)prev.to=Math.max(prev.to,to);
      else player.blockedIntervals.push({from,to,reason});
    }
  }
}
// Reusing a tracker ID does not prove that its owner remained the same. Block
// a bridge if the applied review assigned that ID to anyone else in the gap.
for(const p of result.players)for(let i=1;i<p.positions.length;i++){
  const a=p.positions[i-1],b=p.positions[i];
  if(a.trackId!==b.trackId||b.t-a.t-a.seconds<=.03)continue;
  for(const s of segments.get(a.trackId)||[]){
    if(s.personId!==p.id&&s.from<b.t&&s.to>a.t+a.seconds)
      p.blockedIntervals.push({from:Math.max(s.from,a.t+a.seconds),to:Math.min(s.to,b.t),reason:'identityReassignment'});
  }
}
result.experimentSource={jobId:input.jobId,inputSha256:crypto.createHash('sha256').update(raw).digest('hex'),
  exportedAt:new Date().toISOString(),dirty:recoverySignature(current)!==recoverySignature(review),
  reference:'Existing CV observations; no independent frame-by-frame identity ground truth.',
  courtMeters:[40,20],seconds:(Date.now()-start)/1000};
fs.mkdirSync(path.dirname(outputPath),{recursive:true});
fs.writeFileSync(outputPath,JSON.stringify(result));
console.log(JSON.stringify({outputPath,seconds:result.experimentSource.seconds,players:result.players.length,meanCoverage:result.players.reduce((s,p)=>s+p.coverage,0)/result.players.length}));
