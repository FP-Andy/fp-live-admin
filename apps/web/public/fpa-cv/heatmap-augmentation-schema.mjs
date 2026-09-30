// Validate the separate density layer at import/snapshot boundaries. The
// original positions and grid remain the sole source of measured statistics.
export function validateHeatmapAugmentation(h) {
  const fail=()=>{throw Error('히트맵 활동 분포와 시간 합계를 확인하세요.');};
  const policy=h.augmentation,players=h.players;
  if(!policy){if(players.some(p=>p.augmentation))fail();return;}
  if(policy.enabled!==true||policy.algorithm!=='personal-activity-density/v1'||policy.targetBasis!=='duration'||policy.use!=='heatmap-only'||![.2,.3].includes(policy.targetRatio))fail();
  const duration=h.to-h.from,tol=.002;
  for(const p of players){
    const a=p.augmentation,observed=p.positions.reduce((s,o)=>s+o.seconds,0);
    if(!a||a.schema!=='fpa-heatmap-augmentation/v1'||a.algorithm!==policy.algorithm||a.from!==h.from||a.to!==h.to||!Number.isFinite(a.inferredSeconds)||a.inferredSeconds<0||a.inferredSeconds>Math.min(duration-observed,duration*policy.targetRatio)+tol||!Array.isArray(a.estimatedGrid)||a.estimatedGrid.length!==h.width*h.height||!a.estimatedGrid.every(n=>Number.isFinite(n)&&n>=0)||Math.abs(a.estimatedGrid.reduce((s,n)=>s+n,0)-a.inferredSeconds)>tol||!Array.isArray(a.gaps)||a.gaps.length>1000000)fail();
    const unavailable=p.positions.map(o=>({from:o.t,to:o.t+o.seconds}));
    for(const block of [...(p.blockedIntervals||[]),...(p.inactiveIntervals||[])]){
      if(!block||!Number.isFinite(block.from)||!Number.isFinite(block.to)||block.to<=block.from)fail();
      if((p.inactiveIntervals||[]).includes(block)||['outside','substitution','bench','inactive','automaticFiltered'].includes(block.reason))unavailable.push(block);
    }
    unavailable.sort((a,b)=>a.from-b.from);
    let cursor=h.from,index=0,seconds=0;
    for(const g of [...a.gaps].sort((a,b)=>a.from-b.from)){
      if(!g||![g.from,g.to,g.inferredSeconds].every(Number.isFinite)||g.from<cursor-tol||g.to<=g.from||g.to>h.to+tol||g.inferredSeconds<=0||g.inferredSeconds>g.to-g.from+tol||!['shortMotion','movementDensity','activityPattern'].includes(g.kind))fail();
      while(index<unavailable.length&&unavailable[index].to<=g.from+tol)index++;
      if(index<unavailable.length&&unavailable[index].from<g.to-tol)fail();
      cursor=g.to;seconds+=g.inferredSeconds;
    }
    if(Math.abs(seconds-a.inferredSeconds)>tol)fail();
  }
}
