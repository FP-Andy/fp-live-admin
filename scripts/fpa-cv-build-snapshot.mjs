// CPU-only postprocessing of existing tracks. Does not rerun YOLO or alter IDs.
// Usage: FPA_MODULE_ROOT=/app/public/fpa-cv node ... input.json output.json
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.FPA_MODULE_ROOT||path.resolve('apps/web/public/fpa-cv');
const use=name=>import(pathToFileURL(path.join(root,name)).href);
const {validateDataset,validateReview}=await use('core.mjs');
const {restoreInitialSeeds}=await use('initial-recovery.mjs');
const {reconnect}=await use('identity.mjs');
const {effectiveSegments}=await use('integrity.mjs');
const {buildHeatmaps}=await use('heatmaps.mjs');
const {recoveryInputs,recoverySignature}=await use('recovery-protocol.mjs');
const {augmentPlayerActivity,AUGMENTATION_VERSION}=await use('heatmap-augmentation.mjs');
const {validateHeatmapAugmentation}=await use('heatmap-augmentation-schema.mjs');
const {heatmapDensityScale}=await use('heatmap-render.mjs');
const [inputFile,outputFile]=process.argv.slice(2);
if(!inputFile||!outputFile)throw Error('Supply input and output paths.');
const input=JSON.parse(fs.readFileSync(inputFile)),started=Date.now();
const data=validateDataset(input.tracks);
const review=restoreInitialSeeds(validateReview(input.savedReview||input.initial,data),input.initial,data);
let last=Date.now();const progress=p=>{if(Date.now()-last>30000){console.error(input.jobId,p.phase,p.completed,p.total);last=Date.now();}};
const baseline=review.checkpoints?.length?reconnect(data,{...review,checkpoints:[]},progress):null;
const recovered=reconnect(data,review,progress,{baseline});
if(recovered.issues.length)throw Error('Initial setup incomplete: '+JSON.stringify(recovered.issues));
const previous=review.batch,changed=!!previous?.applied&&recoverySignature(review)!==recoverySignature(previous.applied);
const round=(previous?.round||0)+(changed?1:0),completedAt=new Date().toISOString();
review.batch={...previous,round,applied:recoveryInputs(review),completedAt,
 history:[...(previous?.history||[]).filter(h=>h.version!==round+1),{version:round+1,completedAt,checkpoints:review.checkpoints?.length||0,manualIntervals:review.segments.length,changes:changed?['일괄 스냅샷 검수 반영']:[]}].slice(-100)};
const heatmap=buildHeatmaps(recovered.data,{...review,segments:effectiveSegments(review,recovered)},{point:'bottom'});
heatmap.augmentation={enabled:true,algorithm:AUGMENTATION_VERSION,targetRatio:.3,targetBasis:'duration',use:'heatmap-only'};
for(const p of heatmap.players)p.augmentation=augmentPlayerActivity(p,{from:heatmap.from,to:heatmap.to,width:heatmap.width,height:heatmap.height,targetRatio:.3});
heatmap.scale=heatmapDensityScale(heatmap);validateHeatmapAugmentation(heatmap);
const output={jobId:input.jobId,reviewVersion:input.reviewVersion,trackETag:input.trackETag,review,heatmap,seconds:(Date.now()-started)/1000};
fs.writeFileSync(outputFile,JSON.stringify(output));
console.log(JSON.stringify({jobId:input.jobId,players:heatmap.players.length,round:round+1,seconds:output.seconds,meanCoverage:heatmap.players.reduce((s,p)=>s+p.coverage,0)/heatmap.players.length}));
