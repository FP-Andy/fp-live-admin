import {courtPosition} from './boundary.mjs';
import {overlap} from './integrity.mjs';
import {classifyKit} from './keeper-context.mjs';
export const CHECKPOINT_PLAN_VERSION=4;

const secondsLabel=seconds=>{const rounded=Math.round(seconds);return rounded>=60?`${Math.floor(rounded/60)}분 ${rounded%60}초`:`${seconds.toFixed(1)}초`;};

// Rank opportunities for HUMAN confirmation. Unassigned seconds describe the
// affected intervals, not predicted recovery or identity accuracy. A clear BB
// and a matching colour only suggest that a scene may be worth inspecting.
export function planCheckpoints(data,review,segments,onProgress=()=>{}) {
  const from=Math.max(data.video.clipStart,review.setup?.time??0),to=data.video.clipEnd;
  const step=1/data.detector.sampleFps,aspect=data.video.width/data.video.height,index=new Map();
  for(const s of segments){const list=index.get(s.trackId)||[];list.push(s);index.set(s.trackId,list);}
  const field=review.roster.filter(p=>p.group==='home'||p.group==='away');
  const active=new Map(),candidates=[],saved=review.checkpoints||[];
  let last=-Infinity,cursor=from;
  function observe(start,end,present){
    if(end<=start)return;
    for(const person of field){
      if(present.has(person.id)){active.delete(person.id);continue;}
      let gap=active.get(person.id);
      if(!gap){gap={personId:person.id,group:person.group,jersey:person.jersey,from:start,to:end,seconds:0};active.set(person.id,gap);}
      gap.to=end;gap.seconds+=end-start;
    }
  }
  for(const [i,frame] of data.frames.entries()){
    const start=Math.max(from,frame.t),end=Math.min(to,frame.t+step,data.frames[i+1]?.t??to);
    if(end<=start)continue;
    if(i%128===0)onProgress({phase:'미연결 구간과 확인 장면 찾기',completed:i,total:data.frames.length});
    observe(cursor,start,new Set());
    const visible=frame.boxes.map(box=>({box,label:index.get(box.id)?.find(s=>s.from<=frame.t&&frame.t<s.to)})).filter(({box,label})=>
      label?.team!=='ignore'&&(label?.personId||courtPosition(box.box,data.detector.roi,aspect)?.inside!==false));
    const counts=new Map();
    for(const {label} of visible)if(label?.personId)counts.set(label.personId,(counts.get(label.personId)||0)+1);
    observe(start,end,new Set([...counts].filter(([,n])=>n===1).map(([id])=>id)));cursor=end;
    if(frame.t<from||frame.t-last<.9)continue;last=frame.t;
    const gaps=field.map(p=>active.get(p.id)).filter(Boolean);
    if(!gaps.length)continue;
    const clear=visible.filter(({box,label})=>box.confidence>=.35&&(!label?.personId||counts.get(label.personId)>1)&&
      courtPosition(box.box,data.detector.roi,aspect)?.inside!==false&&
      !visible.some(other=>other.box.id!==box.id&&overlap(box.box,other.box.box)>.3));
    const capacity={home:0,away:0,unknown:0},trackIds=[];
    for(const {box} of clear){
      const color=classifyKit(box,frame.t,review.uniforms,data.keeperContext);
      const group=color.strength>=.22&&color.margin>=.5?color.group:null;
      // Clear goalkeeper/referee colours cannot stand in for field players.
      // Weak colour remains available for human judgement.
      if(group&&group!=='home'&&group!=='away')continue;
      capacity[group||'unknown']++;trackIds.push(box.id);
    }
    if(!trackIds.length)continue;
    const quality=clear.filter(({box})=>trackIds.includes(box.id)).reduce((sum,{box})=>sum+box.confidence,0)/trackIds.length;
    candidates.push({time:frame.t,gaps,capacity,trackIds,quality,visible:visible.length});
  }
  observe(cursor,to,new Set());

  const recommendations=[],covered=new Set();
  // One suggestion per missing interval in a round. After applying it, the
  // remaining intervals supply new choices. Do not fill the budget with
  // repeated guesses inside the same long gap.
  while(recommendations.length<15){
    let best=null;
    for(const c of candidates){
      if(recommendations.some(r=>Math.abs(r.time-c.time)<step*3))continue;
      const available=c.gaps.filter(g=>!covered.has(g)&&!saved.some(s=>Math.abs(s.time-c.time)<step*1.5&&s.assignments.some(a=>a.personId===g.personId)));
      // Prefer an identifiable scene soon after a long disconnection, while
      // allowing a later, better separated scene to beat an occluded one.
      const weight=g=>g.seconds*(.25+.75*Math.exp(-Math.max(0,c.time-g.from)/20));
      available.sort((a,b)=>weight(b)-weight(a));
      const targets=[],capacity={...c.capacity};
      for(const g of available)if(capacity[g.group]>0){targets.push(g);capacity[g.group]--;}
      for(const g of available)if(!targets.includes(g)&&capacity.unknown>0){targets.push(g);capacity.unknown--;}
      if(!targets.length)continue;
      const score=targets.reduce((sum,g)=>sum+weight(g),0)*c.quality;
      if(!best||score>best.score)best={c,targets,score};
    }
    if(!best)break;
    const {c,targets,score}=best;
    for(const g of targets)covered.add(g);
    const relatedSeconds=targets.reduce((sum,g)=>sum+g.seconds,0);
    // Include same-team alternatives: a candidate BB does not prove that a
    // particular missing person is visible. Never create truth labels here.
    const possible=c.gaps.filter(g=>c.capacity[g.group]||c.capacity.unknown);
    const people=['home','away'].map(group=>{
      const jerseys=targets.filter(g=>g.group===group).map(g=>g.jersey);
      return jerseys.length?`${group==='home'?'홈':'원정'} ${jerseys.join('·')}번`:null;
    }).filter(Boolean).join(' / ');
    recommendations.push({time:c.time,missing:possible.map(g=>g.personId),clear:c.trackIds.length,visible:c.visible,quality:c.quality,score,
      trackIds:c.trackIds,relatedSeconds,intervals:targets.map(g=>({...g})),
      reason:`우선 확인 후보 ${people} · 미연결 ${secondsLabel(relatedSeconds)}${targets.length>1?' (선수 합계)':''} · 분리된 미연결 BB ${c.trackIds.length}개`});
  }
  return {version:CHECKPOINT_PLAN_VERSION,budgetDefault:5,confirmed:saved.length,recommendations,scope:{from,to},
    note:'긴 미연결 구간과 분리된 BB를 기준으로 추천합니다. 표시 시간은 관련 미연결 시간이며 회복 보장량이 아닙니다. 확인을 반영하면 남은 구간에서 다시 추천합니다.'};
}
