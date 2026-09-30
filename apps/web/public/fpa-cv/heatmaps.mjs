import {classifyKit} from './keeper-context.mjs';
import {overlap} from './integrity.mjs';

import {courtProjection} from './court-projection.mjs';
export {courtProjection} from './court-projection.mjs';

/** Time-weighted observed occupancy; never interpolate missing time. Yielding
 * lets the UI stay responsive on a full match without duplicating its dataset.
 * Coverage describes usable observations, NOT measured identity accuracy.
 */
export function* heatmapSteps(data,review,{point='bottom',turn=0,manualOnly=false,from=data.video.clipStart,to=data.video.clipEnd}={}) {
  const project=courtProjection(data.detector.roi,turn),width=80,height=40,step=1/data.detector.sampleFps;
  from=Math.max(from,review.setup?.time??from,data.video.clipStart);to=Math.min(to,data.video.clipEnd);
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)throw Error('히트맵 시간 범위를 확인하세요.');
  const players=review.roster.filter(p=>p.group==='home'||p.group==='away').map(p=>({...p,grid:new Float64Array(width*height),observed:0,manual:0,automatic:0,excluded:0,excludedReasons:{duplicate:0,lowConfidence:0,teamConflict:0,overlap:0,outside:0,automaticFiltered:0},positions:[],blockedIntervals:[],longestMissing:0,longestUnassigned:0,lastObservedTo:from,lastIdentityTo:from}));
  const byPerson=new Map(players.map(p=>[p.id,p])),segments=new Map();
  for(const s of review.segments){const list=segments.get(s.trackId)||[];list.push(s);segments.set(s.trackId,list);}
  for(const [index,frame] of data.frames.entries()) {
    const dt=Math.max(0,Math.min(to,frame.t+step,data.frames[index+1]?.t??to)-Math.max(from,frame.t));
    if(!dt)continue;
    const matches=frame.boxes.map(box=>({box,identity:segments.get(box.id)?.find(s=>s.from<=frame.t&&frame.t<s.to)}));
    const counts=new Map();for(const {identity} of matches)if(identity?.personId)counts.set(identity.personId,(counts.get(identity.personId)||0)+1);
    for(const {box,identity} of matches) {
      const player=byPerson.get(identity?.personId);if(!player||identity.team==='ignore')continue;
      player.longestUnassigned=Math.max(player.longestUnassigned,Math.max(from,frame.t)-player.lastIdentityTo);
      player.lastIdentityTo=Math.max(player.lastIdentityTo,Math.max(from,frame.t)+dt);
      const color=classifyKit(box,frame.t,review.uniforms,data.keeperContext);
      const conflict=color.group&&color.group!==player.group&&color.strength>=.22&&color.margin>=.5;
      const collision=frame.boxes.some(other=>other.id!==box.id&&overlap(box.box,other.box)>.55);
      const xy=project([(box.box[0]+box.box[2])/2,point==='center'?(box.box[1]+box.box[3])/2:box.box[3]]);
      const blockedReason=!xy||xy.some(v=>v<0||v>1)?'outside':manualOnly&&identity.source==='auto'?'automaticFiltered':null;
      if(blockedReason){
        const start=Math.max(from,frame.t),end=start+dt,last=player.blockedIntervals.at(-1);
        if(last?.reason===blockedReason&&start<=last.to+.00001)last.to=Math.max(last.to,end);
        else player.blockedIntervals.push({from:start,to:end,reason:blockedReason});
      }
      const reason=counts.get(player.id)!==1?'duplicate':box.confidence<.35?'lowConfidence':conflict?'teamConflict':collision?'overlap':!xy||xy.some(v=>v<0||v>1)?'outside':manualOnly&&identity.source==='auto'?'automaticFiltered':null;
      if(reason){const seconds=dt/counts.get(player.id);player.excluded+=seconds;player.excludedReasons[reason]+=seconds;continue;}
      const cell=Math.min(height-1,Math.floor(xy[1]*height))*width+Math.min(width-1,Math.floor(xy[0]*width));
      player.grid[cell]+=dt;player.observed+=dt;player[identity.source==='auto'?'automatic':'manual']+=dt;
      player.longestMissing=Math.max(player.longestMissing,Math.max(from,frame.t)-player.lastObservedTo);player.lastObservedTo=Math.max(from,frame.t)+dt;
      player.positions.push({t:frame.t,x:xy[0],y:xy[1],seconds:dt,trackId:box.id,source:identity.source==='auto'?'automatic':'manual',...(identity.checkpoint?{checkpoint:true}:{}),...(identity.checkpointSupport?{checkpointSupport:true}:{})});
    }
    if(index%128===0)yield {completed:index,total:data.frames.length};
  }
  return {schema:'fpa-heatmaps/v1',datasetId:data.datasetId,video:data.video.name,resultVersion:(review.batch?.round||0)+1,substitutionsApplied:false,from,to,duration:to-from,width,height,point,turn,manualOnly,confirmedScenes:review.checkpoints?.length||0,
    note:'고정 카메라·교체 없는 명단 기준. 유효 관측률은 신원 정확도가 아닙니다. 원근 보정된 관측 위치만 사용하며 누락 구간은 보간하지 않습니다.',
    players:players.map(({lastObservedTo,lastIdentityTo,...p})=>({...p,longestMissing:Math.max(p.longestMissing,to-lastObservedTo),longestUnassigned:Math.max(p.longestUnassigned,to-lastIdentityTo),grid:Array.from(p.grid),coverage:p.observed/(to-from),identityCoverage:(p.observed+p.excluded)/(to-from),unassigned:Math.max(0,to-from-p.observed-p.excluded),missing:Math.max(0,to-from-p.observed)}))};
}
export function buildHeatmaps(data,review,options){const steps=heatmapSteps(data,review,options);let next;do{next=steps.next();}while(!next.done);return next.value;}
