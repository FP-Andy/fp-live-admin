// Report feasibility probe. Uses exported, time-weighted observations; no YOLO
// run, gap interpolation, extrapolated match distance or inferred positions.
const sum=xs=>xs.reduce((a,b)=>a+b,0);
const weight=ps=>sum(ps.map(p=>p.seconds));
const mean=(ps,key)=>weight(ps)?sum(ps.map(p=>p[key]*p.seconds))/weight(ps):null;
function quantile(ps,key,q){const sorted=[...ps].sort((a,b)=>a[key]-b[key]),target=weight(ps)*q;let total=0;for(const p of sorted){total+=p.seconds;if(total>=target)return p[key];}return sorted.at(-1)?.[key]??null;}
const bands=(ps,key)=>{const bins=[0,0,0];for(const p of ps)bins[Math.min(2,Math.floor(p[key]*3))]+=p.seconds;return bins.map(s=>weight(ps)?s/weight(ps):null);};
const median=xs=>{const sorted=[...xs].sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:null;};

export function distanceProbe(positions,court,{windowSeconds=.6,maxSpeed=12}={}){
  const runs=[];let run=[],gaps=0,switches=0,jumps=0;
  for(const p of positions){const old=run.at(-1);let cut=false;
    if(old){const dt=p.t-old.t,expected=old.seconds;
      if(p.trackId!==old.trackId){cut=true;switches++;}
      else if(dt<=0||Math.abs(dt-expected)>Math.max(.005,expected*.15)){cut=true;gaps++;}
      else if(Math.hypot((p.x-old.x)*court.lengthM,(p.y-old.y)*court.widthM)/dt>maxSpeed){cut=true;jumps++;}
    }
    if(cut&&run.length){runs.push(run);run=[];}run.push(p);
  }
  if(run.length)runs.push(run);
  let distance=0,connectedSeconds=0,rawDistance=0;
  for(const path of runs){
    let lo=0,hi=0;
    const smoothed=path.map(p=>{
      while(lo<path.length&&path[lo].t<p.t-windowSeconds/2-1e-9)lo++;
      while(hi<path.length&&path[hi].t<=p.t+windowSeconds/2+1e-9)hi++;
      const nearby=path.slice(lo,hi);
      return {...p,x:median(nearby.map(q=>q.x)),y:median(nearby.map(q=>q.y))};
    });
    let start=0,end=0;const radius=Math.min(.2,windowSeconds/2);
    const filtered=smoothed.map(p=>{
      if(!windowSeconds)return p;
      while(start<smoothed.length&&smoothed[start].t<p.t-radius-1e-9)start++;
      while(end<smoothed.length&&smoothed[end].t<=p.t+radius+1e-9)end++;
      const local=smoothed.slice(start,end);
      return {...p,x:sum(local.map(q=>q.x))/local.length,y:sum(local.map(q=>q.y))/local.length};
    });
    for(let i=1;i<path.length;i++){
      const a=path[i-1],b=path[i],x=filtered[i-1],y=filtered[i];
      rawDistance+=Math.hypot((b.x-a.x)*court.lengthM,(b.y-a.y)*court.widthM);
      distance+=Math.hypot((y.x-x.x)*court.lengthM,(y.y-x.y)*court.widthM);
      connectedSeconds+=b.t-a.t;
    }
  }
  return {metres:distance,rawMetres:rawDistance,connectedSeconds,runs:runs.length,gaps,idChanges:switches,rejectedJumps:jumps,windowSeconds,maxSpeedGuardMps:maxSpeed,validatedAgainstReference:false};
}

export function reportMetrics(h,{court,directions,positions={}}={}){
  if(h.schema!=='fpa-heatmaps/v1'||!Array.isArray(h.players)||!(h.to>h.from))throw Error('히트맵 좌표 파일을 확인하세요.');
  if(!court||![court.lengthM,court.widthM].every(v=>Number.isFinite(v)&&v>0))throw Error('코트 크기를 확인하세요.');
  if(!directions||!['right','left'].includes(directions.home)||!['right','left'].includes(directions.away)||directions.home===directions.away)throw Error('양 팀 공격 방향을 확인하세요.');
  const duration=h.to-h.from,mid=(h.from+h.to)/2;
  const players=h.players.map(player=>{
    if(!['home','away'].includes(player.group)||!Array.isArray(player.positions))throw Error('선수 팀과 관측 목록을 확인하세요.');
    const ps=player.positions.map(p=>{
      if(![p.t,p.x,p.y,p.seconds].every(Number.isFinite)||p.x<0||p.x>1||p.y<0||p.y>1||p.seconds<=0||p.t<h.from-.001||p.t>=h.to||p.t+p.seconds>h.to+.002)throw Error('관측 좌표를 확인하세요.');
      const right=directions[player.group]==='right';return {...p,forward:right?p.x:1-p.x,lateral:right?p.y:1-p.y};
    }).sort((a,b)=>a.t-b.t);
    for(let i=1;i<ps.length;i++)if(ps[i].t<ps[i-1].t+ps[i-1].seconds-.002)throw Error('중복된 선수 관측입니다.');
    const observed=weight(ps),coverage=observed/duration;
    const periods=[[h.from,mid],[mid,h.to]].map(([from,to])=>{
      const samples=ps.map(p=>({...p,seconds:Math.max(0,Math.min(to,p.t+p.seconds)-Math.max(from,p.t))})).filter(p=>p.seconds>0);
      return {from,to,observedSeconds:weight(samples),coverage:weight(samples)/(to-from),meanX:mean(samples,'x'),meanY:mean(samples,'y'),meanForward:mean(samples,'forward')};
    });
    const zones=Array(9).fill(0);for(const p of ps)zones[Math.min(2,Math.floor(p.y*3))*3+Math.min(2,Math.floor(p.x*3))]+=p.seconds;
    const peak=observed?zones.indexOf(Math.max(...zones)):null;
    const rawRange=ps.length?{x:[quantile(ps,'x',.05),quantile(ps,'x',.95)],y:[quantile(ps,'y',.05),quantile(ps,'y',.95)]}:null;
    const distances=[.3,.6,1.2].map(windowSeconds=>distanceProbe(ps,court,{windowSeconds}));
    const m=distances.map(d=>d.metres),sensitivity=m[1]?(Math.max(...m)-Math.min(...m))/m[1]:null;
    const position=positions[player.id]||player.position||null;
    if(position&&!['DF','MF','FW','GK'].includes(position))throw Error('포지션은 DF/MF/FW/GK 중 하나로 입력하세요.');
    const trendUsable=periods.every(p=>p.coverage>=.6&&p.observedSeconds>=60);
    const longitudinal=bands(ps,'forward'),lateral=bands(ps,'lateral');
    const shift=trendUsable?(periods[1].meanForward-periods[0].meanForward)*court.lengthM:null;
    const comments=reportComments({observedSeconds:observed,coverage,longitudinalShare:{back:longitudinal[0],middle:longitudinal[1],front:longitudinal[2]},timeComparisonAllowed:trendUsable,forwardShiftMetres:shift},{position});
    return {id:player.id,team:player.group,jersey:player.jersey,name:player.name||null,position,observedSeconds:observed,coverage,automaticSeconds:player.automatic??null,pointConfirmedObservations:ps.filter(p=>p.checkpoint).length,meanPosition:observed?{x:mean(ps,'x'),y:mean(ps,'y'),xM:mean(ps,'x')*court.lengthM,yM:mean(ps,'y')*court.widthM}:null,lateralShare:{left:lateral[0],centre:lateral[1],right:lateral[2]},longitudinalShare:{back:longitudinal[0],middle:longitudinal[1],front:longitudinal[2]},mainDisplayZone:peak===null?null:{column:peak%3,row:Math.floor(peak/3),share:zones[peak]/observed},central90Range:rawRange?{...rawRange,lengthM:(rawRange.x[1]-rawRange.x[0])*court.lengthM,widthM:(rawRange.y[1]-rawRange.y[0])*court.widthM}:null,periods,timeComparisonAllowed:trendUsable,forwardShiftMetres:shift,distance:{status:'validation_required',variants:distances,smoothingSensitivity:sensitivity,publishedMetres:null},commentDraft:comments};
  });
  return {schema:'fpa-report-probe/v1',datasetId:h.datasetId,sourceResultVersion:h.resultVersion??null,sourceVideo:h.video,from:h.from,to:h.to,duration,court,directions,orientation:{longAxis:'exported x',point:h.point,turn:h.turn},positionProvidedAtCommentTime:true,substitutionsApplied:h.substitutionsApplied===true,policy:{comparisonMinimumCoverage:.6,comparisonMinimumObservedSeconds:60,status:'provisional product guard, not validated measurement accuracy'},commentsMethod:'deterministic metric-grounded draft; no deployed AI generator',players};
}

// Additional position context only changes prose; the measured report is fixed.
export function reportComments(player,{position=player.position||null}={}){
  if(position&&!['DF','MF','FW','GK'].includes(position))throw Error('포지션을 확인하세요.');
  const comments=[],observed=player.observedSeconds;
  if(!observed)return ['사용 가능한 관측 좌표가 없어 활동 특징을 작성하지 않았습니다.'];
  const zones=[player.longitudinalShare.back,player.longitudinalShare.middle,player.longitudinalShare.front],k=zones.indexOf(Math.max(...zones));
  comments.push(`관측된 ${Math.round(observed)}초 동안 ${['후방','중앙','전방'][k]} 구역 체류 비율이 ${(zones[k]*100).toFixed(1)}%로 가장 높았습니다.`);
  if(player.timeComparisonAllowed){const change=player.forwardShiftMetres;comments.push(`분석 뒤 절반의 평균 위치는 앞 절반보다 공격 방향으로 ${change>=0?'앞쪽':'뒤쪽'} ${Math.abs(change).toFixed(1)}m에 위치했습니다.`);}
  else comments.push(`유효 관측률은 ${(player.coverage*100).toFixed(1)}%이며, 앞뒤 구간 중 관측이 부족한 구간이 있어 시간대 변화 해석은 보류합니다.`);
  if(position)comments.push(`${position} 관점에서는 ${position==='DF'?'전진한 뒤의 위치 복귀':position==='MF'?'전후방 구역 사이의 이동':position==='FW'?'전방에서 중앙과 측면을 오가는 움직임':'골문과의 위치 관계'}을 해당 장면과 함께 확인해 보세요. 좌표만으로 플레이의 성공 여부는 판단하지 않았습니다.`);
  else comments.push('포지션을 추가하면 역할에 맞는 영상 확인 포인트를 붙일 수 있습니다.');
  return comments;
}
