// A confirmed entry path can coexist with an old roster slot's observations.
// Prefer the observed entry path, and count each instant at most once.
export function reconcileStintObservations(input, {direct, preferredTrack} = {}) {
 const points=[...input].sort((a,b)=>a.t-b.t),output=[];let removedSeconds=0;
 if(points.every((q,i)=>!i||q.t>=points[i-1].t+points[i-1].seconds-1e-7))return {positions:points,removedSeconds};
 const cuts=[...new Set(points.flatMap(q=>[q.t,q.t+q.seconds]))].sort((a,b)=>a-b),current=new Set();let cursor=0;
  for(let j=0;j<cuts.length-1;j++){
   const from=cuts[j],to=cuts[j+1];if(to-from<1e-7)continue;
   while(cursor<points.length&&points[cursor].t<=from+1e-8)current.add(points[cursor++]);
   for(const q of current)if(q.t+q.seconds<=from+1e-8)current.delete(q);
   const active=[...current].filter(q=>q.t+q.seconds>=to-1e-8);if(!active.length)continue;
   let candidates=active;
   if(active.length>1){
    const exact=active.filter(q=>direct?.(q));
    // A real identity conflict must not be hidden by dropping an arbitrary row.
    if(!exact.length)throw Error('출전 구간의 관측 좌표가 겹칩니다. 입장 경로 연결을 확인하세요.');
    candidates=exact;
   }
   const preferred=preferredTrack?.((from+to)/2),chosen=candidates.find(q=>q.trackId===preferred)||candidates[0];
   output.push({...chosen,t:from,seconds:to-from});removedSeconds+=(active.length-1)*(to-from);
  }
 return {positions:output,removedSeconds};
}
