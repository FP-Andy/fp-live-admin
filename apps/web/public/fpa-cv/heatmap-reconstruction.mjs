/** Experimental offline occupancy reconstruction. Observations are immutable.
 * No inferred point may be passed to tracking, distance, or event statistics.
 * Parameters are in metres/seconds, never match names, player IDs or pixels.
 */
export const RECONSTRUCTION_VERSION='occupancy-bridge/experiment-1';
export const DEFAULT_RECONSTRUCTION=Object.freeze({method:'linear',diffusion:0,maxGapSeconds:2,
  contextSeconds:1.2,minContextSeconds:.5,maxSpeed:8,maxSigma:1.5,measurementSigma:.2,
  sampleSeconds:.1,courtWidth:40,courtHeight:20,width:80,height:40});
const finite=Number.isFinite;
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const xy=(p,c)=>[p.x*c.courtWidth,p.y*c.courtHeight];
const inside=(p,c)=>p[0]>=0&&p[0]<=c.courtWidth&&p[1]>=0&&p[1]<=c.courtHeight;

function velocity(points,c){
  const mt=points.reduce((s,p)=>s+p.t,0)/points.length;
  const mean=[0,0];for(const p of points){mean[0]+=p.x*c.courtWidth/points.length;mean[1]+=p.y*c.courtHeight/points.length;}
  let denominator=0;const v=[0,0];
  for(const p of points){const dt=p.t-mt,q=xy(p,c);denominator+=dt*dt;v[0]+=dt*(q[0]-mean[0]);v[1]+=dt*(q[1]-mean[1]);}
  if(denominator<1e-8)return null;
  return v.map(n=>n/denominator);
}

function validateContext(points,c){
  if(points.length<3||points.at(-1).t-points[0].t<c.minContextSeconds-1e-6)return 'shortContext';
  for(let i=0;i<points.length;i++){
    const p=points[i];
    if(![p.t,p.x,p.y,p.seconds].every(finite)||p.seconds<=0||!inside(xy(p,c),c))return 'invalidObservation';
    if(i){const prev=points[i-1],dt=p.t-prev.t;
      if(dt<=0||p.t-(prev.t+prev.seconds)>.03)return 'brokenContext';
      if(prev.trackId!==p.trackId)return 'identityBoundary';
      if(distance(xy(prev,c),xy(p,c))/dt>c.maxSpeed)return 'unstableAnchor';
    }
  }
  return null;
}

/** left/right must contain ONLY visible context; hidden reference samples must
 * never enter this function. Uses offline endpoints, not a future forecast. */
export function reconstructGap(left,right,options={},blockedIntervals=[]){
  const c={...DEFAULT_RECONSTRUCTION,...options};
  const fail=reason=>({accepted:false,reason});
  if(!['linear','hermite','bridge-linear','bridge-hermite'].includes(c.method))throw Error('Unknown reconstruction method.');
  if(![c.maxGapSeconds,c.minContextSeconds,c.contextSeconds,c.maxSpeed,c.maxSigma,c.measurementSigma,c.sampleSeconds,c.courtWidth,c.courtHeight,c.diffusion].every(finite)||c.maxGapSeconds<=0||c.minContextSeconds<=0||c.maxSpeed<=0||c.sampleSeconds<=0||c.courtWidth<=0||c.courtHeight<=0||c.measurementSigma<0||c.diffusion<0)throw Error('Invalid reconstruction parameters.');
  if(!left.length||!right.length)return fail('missingAnchor');
  const a=left.at(-1),b=right[0],from=a.t+a.seconds,to=b.t,gap=to-from,T=b.t-a.t;
  if(!finite(gap)||gap<=.03)return fail('noGap');
  if(gap>c.maxGapSeconds+1e-6)return fail('longGap');
  // A roster label alone is not sufficient evidence to bridge an ID change.
  if(a.trackId==null||a.trackId!==b.trackId)return fail('identityBoundary');
  const contextProblem=validateContext(left,c)||validateContext(right,c);if(contextProblem)return fail(contextProblem);
  if(blockedIntervals.some(s=>s.from<to&&s.to>from))return fail('blockedInterval');
  const p0=xy(a,c),p1=xy(b,c),v0=velocity(left,c),v1=velocity(right,c);
  if(!v0||!v1)return fail('shortContext');
  if(distance(p0,p1)/T>c.maxSpeed||Math.hypot(...v0)>c.maxSpeed||Math.hypot(...v1)>c.maxSpeed)return fail('implausibleMotion');
  const curved=c.method.endsWith('hermite'),spread=c.method.startsWith('bridge-');
  const n=Math.ceil(gap/c.sampleSeconds),dt=gap/n,samples=[];
  let previous=p0,previousTime=a.t,maxSigma=0;
  for(let i=0;i<n;i++){
    const t=from+(i+.5)*dt,u=(t-a.t)/T,u2=u*u,u3=u2*u;
    const line=p0.map((v,j)=>v+(p1[j]-v)*u);
    const curve=p0.map((v,j)=>(2*u3-3*u2+1)*v+(u3-2*u2+u)*T*v0[j]+(-2*u3+3*u2)*p1[j]+(u3-u2)*T*v1[j]);
    // Blend bounded endpoint tangents with the straight bridge. This avoids
    // allowing a noisy velocity fit to dominate an otherwise plausible gap.
    const mean=curved?line.map((v,j)=>.5*v+.5*curve[j]):line;
    if(!inside(mean,c))return fail('outsidePath');
    if(distance(mean,previous)/(t-previousTime)>c.maxSpeed)return fail('implausibleMotion');
    const sigma=spread?Math.sqrt(c.measurementSigma**2+c.diffusion*T*u*(1-u)):0;
    if(sigma>c.maxSigma)return fail('uncertainPath');
    maxSigma=Math.max(maxSigma,sigma);
    samples.push({t,x:mean[0]/c.courtWidth,y:mean[1]/c.courtHeight,seconds:dt,sigma});
    previous=mean;previousTime=t;
  }
  if(distance(previous,p1)/(b.t-previousTime)>c.maxSpeed)return fail('implausibleMotion');
  return {accepted:true,from,to,seconds:gap,trackId:a.trackId,maxSigma,samples};
}

/** Normalised density: each sample contributes exactly its elapsed seconds.
 * Court clipping conditions density on remaining inside; means are never
 * clamped to the touchline. Known exits are blocked before this stage. */
export function occupancyGrid(samples,options={}){
  const c={...DEFAULT_RECONSTRUCTION,...options},grid=new Float64Array(c.width*c.height);
  if(!Number.isInteger(c.width)||!Number.isInteger(c.height)||c.width<1||c.height<1)throw Error('Invalid grid shape.');
  for(const p of samples){
    if(![p.x,p.y,p.seconds].every(finite)||p.seconds<0||p.x<0||p.x>1||p.y<0||p.y>1)throw Error('Invalid occupancy sample.');
    const sigma=p.sigma??0;if(!finite(sigma)||sigma<0)throw Error('Invalid occupancy uncertainty.');
    if(!sigma){const x=Math.min(c.width-1,Math.floor(p.x*c.width)),y=Math.min(c.height-1,Math.floor(p.y*c.height));grid[y*c.width+x]+=p.seconds;continue;}
    const cellX=c.courtWidth/c.width,cellY=c.courtHeight/c.height,mx=p.x*c.courtWidth,my=p.y*c.courtHeight;
    const x0=Math.max(0,Math.floor((mx-3*sigma)/cellX)),x1=Math.min(c.width-1,Math.floor((mx+3*sigma)/cellX));
    const y0=Math.max(0,Math.floor((my-3*sigma)/cellY)),y1=Math.min(c.height-1,Math.floor((my+3*sigma)/cellY));
    let mass=0;const cells=[];
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const r2=(((x+.5)*cellX-mx)**2+((y+.5)*cellY-my)**2)/(sigma*sigma);
      const weight=Math.exp(-r2/2);cells.push([y*c.width+x,weight]);mass+=weight;
    }
    if(mass<=0)throw Error('Empty uncertainty kernel.');
    for(const [index,weight] of cells)grid[index]+=p.seconds*weight/mass;
  }
  return grid;
}

/** Returns a separate estimate layer; leaves grid/coverage/positions untouched. */
export function reconstructPlayer(player,options={}){
  const c={...DEFAULT_RECONSTRUCTION,...options},points=player.positions||[],estimatedGrid=new Float64Array(c.width*c.height),gaps=[],rejected={};
  let inferredSeconds=0;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i];if(b.t-a.t-a.seconds<=.03)continue;
    let l=i-1,r=i;
    while(l>0&&a.t-points[l-1].t<=c.contextSeconds+1e-6&&points[l].t-points[l-1].t-points[l-1].seconds<=.03&&points[l-1].trackId===a.trackId)l--;
    while(r+1<points.length&&points[r+1].t-b.t<=c.contextSeconds+1e-6&&points[r+1].t-points[r].t-points[r].seconds<=.03&&points[r+1].trackId===b.trackId)r++;
    const result=reconstructGap(points.slice(l,i),points.slice(i,r+1),c,player.blockedIntervals||[]);
    if(!result.accepted){const reason=result.reason;const entry=rejected[reason]??={gaps:0,seconds:0};entry.gaps++;entry.seconds+=b.t-a.t-a.seconds;continue;}
    const grid=occupancyGrid(result.samples,c);for(let k=0;k<grid.length;k++)estimatedGrid[k]+=grid[k];
    inferredSeconds+=result.seconds;
    const {samples,...summary}=result;gaps.push(summary);
  }
  return {schema:'fpa-heatmap-estimate/experiment-1',algorithm:RECONSTRUCTION_VERSION,experimental:true,
    parameters:c,inferredSeconds,estimatedGrid:Array.from(estimatedGrid),gaps,rejected,
    // Overall coverage and all source measurements remain in the original object.
    unfilledSeconds:Math.max(0,(player.missing??0)-inferredSeconds)};
}
