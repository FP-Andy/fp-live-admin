import {occupancyGrid} from './heatmap-reconstruction.mjs';

/** Exploratory activity-density augmentation, not a reconstructed true path.
 * Longer gaps borrow ONLY this player's nearby observed activity distribution.
 * This layer must never alter identity, observed coverage, distance or events.
 */
export const AUGMENTATION_VERSION='personal-activity-density/experiment-2';
export const AUGMENTATION_DEFAULTS=Object.freeze({targetRatio:.2,courtWidth:40,courtHeight:20,width:80,height:40,
  profileWindowSeconds:120,profileDecaySeconds:60,profileSigma:1.1,movementLimitSeconds:15,
  minObservedSeconds:1,maxSpeed:8,sampleSeconds:.25});
const total=a=>a.reduce((s,v)=>s+v,0);
const dist=(a,b,c)=>Math.hypot((a.x-b.x)*c.courtWidth,(a.y-b.y)*c.courtHeight);
const unavailable=new Set(['outside','substitution','bench','inactive']);
const epsilon=1e-5;

function config(options){
  const c={...AUGMENTATION_DEFAULTS,...options};
  for(const key of Object.keys(AUGMENTATION_DEFAULTS))if(!Number.isFinite(c[key]))throw Error(`Invalid ${key}`);
  if(c.targetRatio<0||c.targetRatio>1||c.courtWidth<=0||c.courtHeight<=0||c.width<1||c.height<1||!Number.isInteger(c.width)||!Number.isInteger(c.height)||c.profileWindowSeconds<=0||c.profileDecaySeconds<=0||c.profileSigma<=0||c.movementLimitSeconds<=0||c.minObservedSeconds<=0||c.maxSpeed<=0||c.sampleSeconds<=0)throw Error('Invalid augmentation parameters.');
  return c;
}
function validPositions(player){
  const points=player.positions||[];
  for(let i=0;i<points.length;i++){
    const p=points[i];
    if(![p.t,p.x,p.y,p.seconds].every(Number.isFinite)||p.seconds<=0||p.x<0||p.x>1||p.y<0||p.y>1||(i&&p.t<points[i-1].t+points[i-1].seconds-epsilon))throw Error('Invalid or overlapping observed coordinates.');
  }
  return points;
}
function velocity(points,anchor,left,c){
  const use=points.filter(p=>left?p.t<=anchor.t&&p.t>=anchor.t-1.5:p.t>=anchor.t&&p.t<=anchor.t+1.5);
  if(use.length<2)return [0,0];
  const mt=total(use.map(p=>p.t))/use.length,mx=total(use.map(p=>p.x))/use.length,my=total(use.map(p=>p.y))/use.length;
  let denominator=0,vx=0,vy=0;
  for(const p of use){const dt=p.t-mt;denominator+=dt*dt;vx+=dt*(p.x-mx)*c.courtWidth;vy+=dt*(p.y-my)*c.courtHeight;}
  if(denominator<1e-8)return [0,0];
  const v=[vx/denominator,vy/denominator],speed=Math.hypot(...v);
  return speed>c.maxSpeed?v.map(n=>n*c.maxSpeed/speed):v;
}
function motionDensity(points,gap,c){
  const {left:a,right:b,from,to}=gap;if(!a||!b)return null;
  const T=b.t-a.t;if(T<=0||dist(a,b,c)/T>c.maxSpeed)return null;
  const v0=velocity(points,a,true,c),v1=velocity(points,b,false,c),duration=to-from;
  const n=Math.max(1,Math.ceil(duration/c.sampleSeconds)),samples=[],blend=.5*Math.exp(-Math.max(0,T-3)/10);
  for(let i=0;i<n;i++){
    const t=from+(i+.5)*duration/n,u=Math.max(0,Math.min(1,(t-a.t)/T)),u2=u*u,u3=u2*u;
    const line=[a.x+(b.x-a.x)*u,a.y+(b.y-a.y)*u];
    const curve=[c.courtWidth,c.courtHeight].map((m,k)=>(2*u3-3*u2+1)*[a.x,a.y][k]+(u3-2*u2+u)*T*v0[k]/m+(-2*u3+3*u2)*[b.x,b.y][k]+(u3-u2)*T*v1[k]/m);
    let mean=line.map((v,k)=>(1-blend)*v+blend*curve[k]);
    // Do not accumulate out-of-court means at a clamped touchline.
    if(mean.some(v=>v<0||v>1))mean=line;
    samples.push({t,x:mean[0],y:mean[1],seconds:1/n,sigma:duration<=3?.15:Math.min(1.4,.2+.22*Math.sqrt(T)*Math.sin(Math.PI*u))});
  }
  return occupancyGrid(samples,c);
}
function personalDensity(points,gap,c){
  // Hidden interval is explicitly removed even when called directly by tests.
  let context=points.filter(p=>p.t+p.seconds<=gap.from+epsilon||p.t>=gap.to-epsilon);
  const age=p=>p.t<gap.from?Math.max(0,gap.from-p.t-p.seconds):Math.max(0,p.t-gap.to);
  const local=context.filter(p=>age(p)<=c.profileWindowSeconds);
  if(total(local.map(p=>p.seconds))>=c.minObservedSeconds)context=local;
  const evidenceSeconds=total(context.map(p=>p.seconds));
  if(evidenceSeconds<c.minObservedSeconds)return null;
  const cells=new Map();let weight=0;
  for(const p of context){
    const w=p.seconds*Math.exp(-age(p)/c.profileDecaySeconds),x=Math.min(c.width-1,Math.floor(p.x*c.width)),y=Math.min(c.height-1,Math.floor(p.y*c.height));
    const key=y*c.width+x,cell=cells.get(key)||{weight:0,x:0,y:0};cell.weight+=w;cell.x+=w*p.x;cell.y+=w*p.y;cells.set(key,cell);weight+=w;
  }
  if(weight<1e-12)return null;
  const samples=[...cells.values()].map(v=>({x:v.x/v.weight,y:v.y/v.weight,seconds:v.weight/weight,sigma:c.profileSigma}));
  return {grid:occupancyGrid(samples,c),evidenceSeconds,referenceFrom:context[0].t,referenceTo:context.at(-1).t+context.at(-1).seconds};
}

/** Return a unit-mass spatial distribution, never claimed frame positions. */
export function estimateActivityGap(player,gap,options={}){
  const c=config(options),points=validPositions(player);
  if(!Number.isFinite(gap.from)||!Number.isFinite(gap.to)||gap.to<=gap.from)throw Error('Invalid missing interval.');
  if(points.some(p=>p.t<gap.to-epsilon&&p.t+p.seconds>gap.from+epsilon))throw Error('Gap contains observed samples.');
  const duration=gap.to-gap.from;
  const motion=gap.hasExplicitAbsence?null:motionDensity(points,gap,c);
  if(motion&&duration<=c.movementLimitSeconds)return {grid:motion,kind:duration<=3?'shortMotion':'movementDensity',referenceSeconds:0};
  const prior=personalDensity(points,gap,c);
  if(!prior)return motion?{grid:motion,kind:'movementDensity',referenceSeconds:0}:null;
  // With long missing intervals, the personal activity pattern dominates. No
  // exact route is exported and no uniform background is added to the pitch.
  const movementWeight=motion?Math.min(.35,5/duration):0;
  const grid=Float64Array.from(prior.grid,(v,i)=>v*(1-movementWeight)+(motion?.[i]||0)*movementWeight);
  return {grid,kind:'activityPattern',referenceSeconds:prior.evidenceSeconds,referenceFrom:prior.referenceFrom,referenceTo:prior.referenceTo};
}

function mergeIntervals(intervals,from,to){
  const sorted=intervals.map(s=>({from:Math.max(from,s.from),to:Math.min(to,s.to)})).filter(s=>Number.isFinite(s.from)&&Number.isFinite(s.to)&&s.to>s.from).sort((a,b)=>a.from-b.from),merged=[];
  for(const s of sorted){const last=merged.at(-1);if(last&&s.from<=last.to+epsilon)last.to=Math.max(last.to,s.to);else merged.push(s);}
  return merged;
}
export function augmentPlayerActivity(player,options={}){
  const c=config(options),points=validPositions(player),{from,to}=options;
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)throw Error('Supply the analysis interval.');
  const duration=to-from,observedSeconds=points.reduce((s,p)=>s+Math.max(0,Math.min(to,p.t+p.seconds)-Math.max(from,p.t)),0);
  const targetBasis=options.targetBasis||'duration';
  if(!['duration','observed'].includes(targetBasis))throw Error('Invalid target basis.');
  const requestedSeconds=(targetBasis==='duration'?duration:observedSeconds)*c.targetRatio,estimatedGrid=new Float64Array(c.width*c.height);
  const blocks=mergeIntervals([...(player.blockedIntervals||[]).filter(s=>unavailable.has(s.reason)),...(player.inactiveIntervals||[])],from,to);
  const originalGaps=[];let cursor=from,left=null;
  for(const p of points){
    if(p.t+p.seconds<=from)continue;if(p.t>=to)break;
    if(p.t>cursor+epsilon)originalGaps.push({from:cursor,to:Math.min(to,p.t),left,right:p});
    cursor=Math.max(cursor,Math.min(to,p.t+p.seconds));left=p;
  }
  if(cursor<to-epsilon)originalGaps.push({from:cursor,to,left,right:null});
  const candidates=[];let knownAbsentSeconds=0;
  for(const g of originalGaps){
    let pieces=[{...g}];
    for(const b of blocks){
      const next=[];
      for(const s of pieces){
        const lo=Math.max(s.from,b.from),hi=Math.min(s.to,b.to);
        if(hi<=lo){next.push(s);continue;}knownAbsentSeconds+=hi-lo;
        if(s.from<lo)next.push({...s,to:lo,hasExplicitAbsence:true});
        if(hi<s.to)next.push({...s,from:hi,hasExplicitAbsence:true});
      }pieces=next;if(!pieces.length)break;
    }
    for(const s of pieces){const seconds=s.to-s.from,sameTrack=s.left?.trackId!=null&&s.left?.trackId===s.right?.trackId;
      const rank=s.hasExplicitAbsence?4:!s.left||!s.right?5:seconds<=3?(sameTrack?0:1):seconds<=c.movementLimitSeconds?2:3;
      candidates.push({...s,rank});}
  }
  candidates.sort((a,b)=>a.rank-b.rank||(a.to-a.from)-(b.to-b.from)||a.from-b.from);
  const eligibleSeconds=total(candidates.map(g=>g.to-g.from)),targetSeconds=Math.min(requestedSeconds,eligibleSeconds);
  const gaps=[],rejected={},byKind={shortMotion:0,movementDensity:0,activityPattern:0};let inferredSeconds=0;
  if(observedSeconds>=c.minObservedSeconds)for(const g of candidates){
    const remaining=targetSeconds-inferredSeconds;if(remaining<=epsilon)break;
    const estimated=estimateActivityGap(player,g,c);
    if(!estimated){const r=rejected.insufficientEvidence??={gaps:0,seconds:0};r.gaps++;r.seconds+=g.to-g.from;continue;}
    const seconds=Math.min(g.to-g.from,remaining),mass=total(estimated.grid);if(!(mass>0))continue;
    for(let i=0;i<estimatedGrid.length;i++)estimatedGrid[i]+=seconds*estimated.grid[i]/mass;
    inferredSeconds+=seconds;byKind[estimated.kind]+=seconds;
    gaps.push({from:g.from,to:g.to,intervalSeconds:g.to-g.from,inferredSeconds:seconds,
      contributionFraction:seconds/(g.to-g.from),kind:estimated.kind,sameTrack:!!g.left&&!!g.right&&g.left.trackId===g.right.trackId,
      referenceFrom:estimated.referenceFrom,referenceTo:estimated.referenceTo,referenceSeconds:estimated.referenceSeconds});
  }
  const missingSeconds=Math.max(0,duration-observedSeconds);
  return {schema:'fpa-heatmap-augmentation/experiment-2',algorithm:AUGMENTATION_VERSION,experimental:true,
    parameters:{...c,targetBasis},from,to,observedSeconds,requestedSeconds,eligibleSeconds,knownAbsentSeconds,inferredSeconds,
    targetReached:inferredSeconds>=requestedSeconds-epsilon,addedCoverage:inferredSeconds/duration,
    targetRatioAchieved:inferredSeconds/(targetBasis==='duration'?duration:observedSeconds||1),
    inferredVsObserved:observedSeconds?inferredSeconds/observedSeconds:0,
    estimatedGrid:Array.from(estimatedGrid),gaps,byKind,rejected,unfilledSeconds:Math.max(0,missingSeconds-inferredSeconds),
    interpretation:'Inferred occupancy contribution, including nearby personal activity patterns. Not observed time or an exact recovered path.',
    substitutionsApplied:false};
}
