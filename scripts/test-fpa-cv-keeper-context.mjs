import assert from 'node:assert/strict';
import {buildKeeperContext,classifyKit,keeperAt} from '../apps/web/public/fpa-cv/keeper-context.mjs';
import {emptyReview,validateDataset,assign,trackRange,identityAt} from '../apps/web/public/fpa-cv/core.mjs';
import {reconnect} from '../apps/web/public/fpa-cv/identity.mjs';
import {effectiveSegments} from '../apps/web/public/fpa-cv/integrity.mjs';
import {packRecovery,hydrateRecovery} from '../apps/web/public/fpa-cv/recovery-protocol.mjs';
import {classifyUniform} from '../apps/web/public/fpa-cv/colors.mjs';

const yellow=[250,230,20],lime=[235,250,160],orange=[240,105,10],red=[190,10,15];
const uniforms={home:[yellow],home_gk:[lime,yellow],away:[red],away_gk:[orange,yellow],referee:[[200,245,190]]};
function fixture(change=()=>{},roi=[[0,0],[1,0],[1,1],[0,1]]){
  const box=(id,x,rgb)=>({id,box:[x-.012,.45,x+.012,.51],confidence:.9,appearance:[{rgb,weight:1}]});
  const frames=Array.from({length:50},(_,i)=>{const t=i/10,boxes=[box(1,.08,lime),box(2,.9,orange),box(3,.4,yellow),box(4,.6,red)];change(boxes,t,box);return {t,boxes};});
  const data=validateDataset({schema:'fpa-tracks/v1',datasetId:'keeper-test',video:{name:'roles.mp4',width:1920,height:1080,fps:30,duration:5,clipStart:0,clipEnd:5},detector:{sampleFps:10,roi},frames});
  const review={...emptyReview(data),uniforms,setup:{time:0},segments:[{trackId:1,personId:'home_gk-1',group:'home_gk',team:'home',from:0,to:5,source:'manual'},{trackId:2,personId:'away_gk-1',group:'away_gk',team:'away',from:0,to:5,source:'manual'}]};
  return {data,review};
}
let {data,review}=fixture();
let context=buildKeeperContext(data,review);
assert(context.enabled);
assert.equal(classifyUniform(data.frames[5].boxes[2].appearance,uniforms).group,null);
assert.equal(classifyKit(data.frames[5].boxes[2],.5,uniforms,context).group,'home','Home field colour is not vetoed by matching keeper colours');
assert.equal(keeperAt(context,1,1).group,'home_gk');
assert.equal(classifyKit(data.frames[5].boxes[2],.5,{...uniforms,away:[yellow]},context).group,null,'Identical opposing field uniforms still require human evidence');

({data,review}=fixture((boxes,t,box)=>{if(t>=1)boxes[1].appearance=[{rgb:lime,weight:1}];if(t>=2)boxes[1].id=22;if(t>=1)boxes.push(box(99,.97,red));}));
context=buildKeeperContext(data,review);
assert.equal(keeperAt(context,2,1.5).group,'away_gk','Sunlight/colour confusion cannot override a continuous seeded keeper');
assert.equal(keeperAt(context,22,2.5).group,'away_gk','A lost ID reconnects through nearby consistent observations');
assert.equal(keeperAt(context,99,2.5),undefined,'An attacker closer to goal is not promoted');
assert.equal(classifyKit(data.frames[25].boxes.find(b=>b.id===22),2.5,uniforms,context).group,'away_gk');

({data,review}=fixture((boxes,t,box)=>{if(t>=2){boxes.splice(1,1);boxes.push(box(21,.87,orange),box(22,.93,orange));}}));
context=buildKeeperContext(data,review);
assert.equal(keeperAt(context,21,3),undefined);assert.equal(keeperAt(context,22,3),undefined,'Equally plausible set-piece candidates stay unresolved');

({data,review}=fixture((boxes,t)=>{boxes[1].box=boxes[1].box.map((v,i)=>i%2===0?v-t*.06:v);}));
context=buildKeeperContext(data,review);
assert.equal(keeperAt(context,2,4.5).group,'away_gk','A continuously observed flying keeper keeps their role');

({data,review}=fixture());
review.segments.push({trackId:2,personId:'home-1',group:'home',team:'home',from:2,to:5,source:'manual'});
context=buildKeeperContext(data,review);
assert.equal(keeperAt(context,2,3),undefined,'A later manual field correction stops the prior keeper path');

({data,review}=fixture(()=>{},null));
context=buildKeeperContext(data,review);assert.equal(context.enabled,false,'Missing court does not guess goal ends');
assert.deepEqual(classifyKit(data.frames[0].boxes[2],0,uniforms,context),classifyUniform(data.frames[0].boxes[2].appearance,uniforms));

({data,review}=fixture());
const rotated={...data,frames:data.frames.map(f=>({...f,boxes:f.boxes.map(b=>({...b,box:[b.box[1],b.box[0],b.box[3],b.box[2]]}))}))};
context=buildKeeperContext(rotated,review);assert(context.enabled);assert.equal(keeperAt(context,2,2).group,'away_gk','Rotated camera derives its goal axis from the seeds');
const packed=structuredClone(packRecovery({data:{...rotated,keeperContext:context},keeperContext:context,timeline:new Map()},rotated));
assert.equal(keeperAt(hydrateRecovery(packed,rotated).data.keeperContext,2,2).group,'away_gk','Role evidence survives worker/cache round trips');

// Full association: all 13 roster slots, matching yellow kits, a keeper colour
// change and a new keeper track ID. The final identity must follow the role.
({data,review}=fixture((boxes,t,box)=>{
  if(t>=1)boxes[1].appearance=[{rgb:lime,weight:1}];if(t>=2)boxes[1].id=22;
  for(let i=0;i<9;i++){
    const b=box(i+5,.25+(i%5)*.1,i<4?yellow:i<8?red:uniforms.referee[0]);
    b.box[1]=i<4?.2:.75;b.box[3]=b.box[1]+.06;boxes.push(b);
  }
}));
data=validateDataset(data);
const ids=['home_gk-1','away_gk-1','home-1','away-1','home-2','home-3','home-4','home-5','away-2','away-3','away-4','away-5','referee-1'];
review={...review,segments:[],roster:review.roster.map(p=>({...p,jersey:p.group==='referee'?'REF':p.group.endsWith('_gk')?'1':String(Number(p.id.split('-').at(-1))+1)}))};
for(let i=0;i<13;i++)review=assign(review,data,i+1,...trackRange(data,i+1),{personId:ids[i],source:'manual'});
const recovered=reconnect(data,review),working={...review,segments:effectiveSegments(review,recovered)};
assert.equal(identityAt(working,22,3)?.personId,'away_gk-1','Recovered goalkeeper gets its original roster number, not a home field number');
console.log('PASS: same-team colour ambiguity, keeper motion and ID recovery, set-piece abstention, closer attacker, flying keeper, manual correction, rotated/missing court, cache persistence.');
