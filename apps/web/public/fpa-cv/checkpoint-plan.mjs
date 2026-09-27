import {courtPosition} from './boundary.mjs';
import {overlap} from './integrity.mjs';
export const CHECKPOINT_PLAN_VERSION=3;

// Recommendations allocate HUMAN effort; they are not automatic truth labels.
// First five spread over the match, further choices refine uncovered intervals.
export function planCheckpoints(data,review,segments,onProgress=()=>{}) {
  const from=Math.max(data.video.clipStart,review.setup?.time??0),to=data.video.clipEnd,duration=to-from;
  const step=1/data.detector.sampleFps,aspect=data.video.width/data.video.height,index=new Map();
  for(const s of segments){const list=index.get(s.trackId)||[];list.push(s);index.set(s.trackId,list);}
  const field=review.roster.filter(p=>p.group==='home'||p.group==='away'),candidates=[];
  let last=-Infinity;
  for(const [i,frame] of data.frames.entries()){
    if(frame.t<from||frame.t-last<.9)continue;last=frame.t;
    if(i%128===0)onProgress({phase:'확인할 장면 추천',completed:i,total:data.frames.length});
    const visible=frame.boxes.filter(b=>{
      const label=index.get(b.id)?.find(s=>s.from<=frame.t&&frame.t<s.to);
      return label?.team!=='ignore'&&(label?.personId||courtPosition(b.box,data.detector.roi,aspect)?.inside!==false);
    });
    const counts=new Map();
    for(const box of visible){const id=index.get(box.id)?.find(s=>s.from<=frame.t&&frame.t<s.to)?.personId;if(id)counts.set(id,(counts.get(id)||0)+1);}
    const missing=field.filter(p=>counts.get(p.id)!==1).map(p=>p.id);
    const clear=visible.filter(b=>b.confidence>=.35&&!visible.some(o=>o.id!==b.id&&overlap(b.box,o.box)>.3));
    if(!missing.length||clear.length<2)continue;
    const quality=Math.min(1,clear.length/13)*(clear.reduce((s,b)=>s+b.confidence,0)/clear.length);
    const risk=missing.length+2*[...counts.values()].filter(v=>v>1).length;
    candidates.push({time:frame.t,missing,clear:clear.length,visible:visible.length,quality,risk});
  }
  const chosen=[from,...(review.checkpoints||[]).map(c=>c.time)],recommendations=[];
  // Scene spacing adapts to clip duration, not a particular timestamp or ID.
  const minimumSeparation=Math.max(step*3,duration/60);
  // Weighted facility coverage: favour the reduction in uncertain time's
  // distance to a confirmed scene, instead of repeatedly selecting the highest
  // missing count. A partial checkpoint only covers the people confirmed in it.
  const nearest=candidates.map(c=>c.missing.reduce((sum,id)=>sum+Math.min(Math.abs(c.time-from),...(review.checkpoints||[]).filter(s=>s.assignments.some(a=>a.personId===id)).map(s=>Math.abs(c.time-s.time))),0)/c.missing.length);
  // This is a per-round suggestion count, never a lifetime annotation limit.
  while(recommendations.length<15){
    let best=null,bestScore=0;
    for(const c of candidates){
      if(c.time-from<minimumSeparation||chosen.some(t=>Math.abs(t-c.time)<minimumSeparation))continue;
      let gain=0;
      for(let i=0;i<candidates.length;i++){const other=candidates[i];gain+=other.risk*Math.max(0,nearest[i]-Math.abs(other.time-c.time));}
      const score=gain*(.2+.8*c.quality);
      if(score>bestScore){best=c;bestScore=score;}
    }
    if(!best)break;
    chosen.push(best.time);recommendations.push({...best,reason:`필드 선수 ${best.missing.length}명 미연결 · 분리된 BB ${best.clear}개`});
    for(let i=0;i<candidates.length;i++)nearest[i]=Math.min(nearest[i],Math.abs(candidates[i].time-best.time));
  }
  return {version:CHECKPOINT_PLAN_VERSION,budgetDefault:5,confirmed:(review.checkpoints||[]).length,recommendations,scope:{from,to},note:'추천 장면 수는 정확도 보장이 아닙니다. 보이지 않는 선수는 확인하지 않아도 됩니다.'};
}
