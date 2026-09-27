import {identityAt,personIdentity} from './core.mjs';
import {classifyUniform} from './colors.mjs';
import {appearanceSimilarity,overlap,teamConflict,uniformAt,effectiveSegments} from './integrity.mjs';

const centre=b=>[(b[0]+b[2])/2,(b[1]+b[3])/2];
const area=b=>(b[2]-b[0])*(b[3]-b[1]);
function coincident(a,b,aspect,established=false) {
  const pa=centre(a),pb=centre(b),scale=Math.min(Math.hypot((a[2]-a[0])*aspect,a[3]-a[1]),Math.hypot((b[2]-b[0])*aspect,b[3]-b[1]));
  // Hysteresis: acquiring a duplicate needs close containment; maintaining a
  // confirmed pair tolerates box shape noise, while spatial separation ends it.
  return overlap(a,b)>=(established?.5:.82)&&Math.min(area(a),area(b))/Math.max(area(a),area(b))>=.50&&Math.hypot((pa[0]-pb[0])*aspect,pa[1]-pb[1])<=scale*(established?.5:.3);
}
const samples=observations=>observations.flatMap(o=>(o.box.appearance||[]).map(p=>({...p,weight:p.weight/observations.length})));
function append(spans,value,step) {
  const prev=spans.findLast(s=>s.trackId===value.trackId&&s.canonicalTrackId===value.canonicalTrackId&&s.personId===value.personId);
  if(prev&&prev.trackId===value.trackId&&prev.canonicalTrackId===value.canonicalTrackId&&prev.personId===value.personId&&Math.abs(prev.to-value.from)<step*.1)prev.to=value.to;
  else spans.push(value);
}

/** Collapse only a new fragment born on an established track. Two established
 * players meeting are never deduplicated. Lookahead is explicit: these are
 * offline suggestions and confirmedAt records when evidence became available.
 */
export function consolidate(data,review,timeline,masks) {
  const step=1/data.detector.sampleFps,aspect=data.video.width/data.video.height;
  const observations=new Map(),summary=new Map(data.tracks.map(t=>[t.id,t])),framesByTime=new Map(data.frames.map(f=>[f.t,f]));
  for(const frame of data.frames)for(const box of frame.boxes){const list=observations.get(box.id)||[];list.push({time:frame.t,box});observations.set(box.id,list);}
  const indexed=new Map([...observations].map(([id,list])=>[id,new Map(list.map(o=>[o.time,o]))]));
  const anchors={...review,segments:effectiveSegments(review,{masks,segments:[]})};
  const pairs=[];
  for(const [id,list] of observations) {
    const birth=list[0],future=list.filter(o=>o.time-birth.time<=.55&&o.box.confidence>=.3);
    if(future.length<3)continue;
    const color=classifyUniform(samples(future),review.uniforms);
    if(!color.group||color.margin<.45)continue;
    const first=framesByTime.get(birth.time),options=[];
    for(const old of first.boxes) {
      if(old.id===id||birth.time-summary.get(old.id).first<.5||!coincident(old.box,birth.box.box,aspect))continue;
      const a=identityAt(anchors,old.id,birth.time),b=identityAt(anchors,id,birth.time);
      if(a?.team==='ignore'||b?.team==='ignore'||(a?.personId&&b?.personId&&a.personId!==b.personId))continue;
      const history=observations.get(old.id).filter(o=>o.time<=birth.time&&birth.time-o.time<=.55&&o.box.confidence>=.3);
      if(history.length<3)continue;
      const previous=classifyUniform(samples(history),review.uniforms);
      if(previous.group!==color.group||(appearanceSimilarity(samples(history),samples(future))??0)<.65)continue;
      if((a&&teamConflict(a,color))||(b&&teamConflict(b,color)))continue;
      const together=list.filter(o=>o.time-birth.time<=.7).map(o=>({o,old:indexed.get(old.id).get(o.time)})).filter(p=>p.old);
      // Repeated agreement, or one overlap at an immediate handoff with three
      // subsequent detections. Reject two boxes that separate into two people.
      if(together.some(p=>!coincident(p.old.box.box,p.o.box.box,aspect)))continue;
      if(together.length<2&&summary.get(old.id).last>birth.time+step*.5)continue;
      const oldEnd=summary.get(old.id).last;
      const split=list.some(o=>{const other=indexed.get(old.id).get(o.time);return other&&o.time>=birth.time&&o.time<=oldEnd&&!coincident(other.box.box,o.box.box,aspect,true);});
      if(split)continue;
      const origin=a?.personId?a:null;
      options.push({older:old.id,newer:id,from:birth.time,to:data.video.clipEnd,group:color.group,confirmedAt:future.at(-1).time,origin,score:appearanceSimilarity(samples(history),samples(future))});
    }
    // Ambiguous overlaps never choose an arbitrary parent.
    if(options.length===1)pairs.push(options[0]);
  }
  // A parent's identity cannot fan out into two children at the same time.
  const safe=pairs.filter(p=>!pairs.some(q=>q!==p&&q.older===p.older&&Math.abs(q.from-p.from)<.7)).sort((a,b)=>a.from-b.from);
  const duplicates=[],segments=[],frames=[],lastSeen=new Map();
  for(const frame of data.frames) {
    const visible=new Map(frame.boxes.map(b=>[b.id,b])),hidden=new Set();
    for(const p of safe) {
      if(frame.t<p.from)continue;
      const old=visible.get(p.older),next=visible.get(p.newer);
      const prior=lastSeen.get(p.newer)??frame.t;
      if(old||next)lastSeen.set(p.newer,frame.t);
      if(!next||teamConflict({group:p.group},uniformAt(timeline,p.newer,frame.t)))continue;
      const stored=identityAt(anchors,p.newer,frame.t);
      if(stored?.checkpoint)continue; // Protect the confirmed frame, not this ID's entire lifetime.
      if(stored?.team==='ignore'||(stored?.personId&&stored.personId!==p.origin?.personId))continue;
      if(old&&coincident(old.box,next.box,aspect,true)) {
        hidden.add(p.newer);
        append(duplicates,{trackId:p.newer,canonicalTrackId:p.older,from:frame.t,to:Math.min(data.video.clipEnd,frame.t+step),confirmedAt:p.confirmedAt},step);
      }
      if(!review.autoReconnect||!p.origin?.personId||hidden.has(p.newer)||stored)continue;
      // Do not continue through another occurrence of the same roster player,
      // an operator rejection, or a sustained team-colour contradiction.
      if(frame.boxes.some(b=>b.id!==p.newer&&identityAt(anchors,b.id,frame.t)?.personId===p.origin.personId))continue;
      if(review.rejections.some(r=>r.trackId===p.newer&&r.personId===p.origin.personId&&r.from<=frame.t&&frame.t<r.to))continue;
      const id=personIdentity(review,p.origin.personId);
      append(segments,{...id,trackId:p.newer,from:frame.t,to:Math.min(data.video.clipEnd,frame.t+step),source:'auto',mode:'continuity',previousTrack:p.older,time:p.confirmedAt,score:p.score,gap:Math.max(0,frame.t-prior),uniform:p.group,colorScore:1},step);
    }
    frames.push({...frame,boxes:frame.boxes.filter(b=>!hidden.has(b.id))});
  }
  return {data:{...data,frames},duplicates,segments,pairs:safe};
}
