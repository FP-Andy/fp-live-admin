import {courtProjection} from './court-projection.mjs';
import {classifyUniform} from './colors.mjs';

const side=g=>g?.startsWith('home')?'home':g?.startsWith('away')?'away':null;
const distance=(a,b)=>Math.hypot((a[0]-b[0])*40,(a[1]-b[1])*20);
const lower=(a,t)=>{let lo=0,hi=a.length;while(lo<hi){const mid=(lo+hi)>>1;if(a[mid].t<t)lo=mid+1;else hi=mid;}return lo;};
const point=(box,bottom)=>[(box[0]+box[2])/2,bottom?box[3]:(box[1]+box[3])/2];

/** Build conservative short-gap paths. Colours establish team compatibility,
 * never an individual identity. A join must be unique in both directions. */
export function substitutionEvidence(snapshot,data,events){
 const original=snapshot.heatmap,step=1/data.detector.sampleFps,camera=courtProjection(data.detector.roi),project=courtProjection(data.detector.roi,original.turn||0),bottom=original.point!=='center';
 const tracks=new Map(),owners=new Map(),people=new Map(original.players.map(p=>[p.id,p]));
 for(const p of original.players)for(const q of p.positions){const a=owners.get(q.trackId)||[];a.push({t:q.t,to:q.t+q.seconds,id:p.id});owners.set(q.trackId,a);}
 for(const list of owners.values())list.sort((a,b)=>a.t-b.t);
 for(const f of data.frames)for(const b of f.boxes){const dt=Math.max(0,Math.min(b.observationStep||step,(b.observationEnd??original.to)-f.t));if(!dt)continue;const xy=camera(point(b.box,bottom));if(!xy)continue;const a=tracks.get(b.id)||[];a.push({t:f.t,dt,b,xy,heatXY:project(point(b.box,bottom))});tracks.set(b.id,a);}
 // An unrelated detector's interleaved frame must not halve this track's
 // observation time or delay the sustained opposite-kit stop.
 for(const list of tracks.values())for(let i=0;i<list.length-1;i++)list[i].dt=Math.min(list[i].dt,list[i+1].t-list[i].t);
 const votes=(ids,t,from=-6,to=2)=>{const counts=new Map();for(const id of ids){const list=owners.get(id)||[];for(let i=Math.max(0,lower(list,t+from)-1);i<list.length&&list[i].t<=t+to;i++){const q=list[i],duration=Math.min(q.to,t+to)-Math.max(q.t,t+from);if(duration>0)counts.set(q.id,(counts.get(q.id)||0)+duration*Math.exp(-Math.abs(q.t-t)/6));}}return [...counts].sort((a,b)=>b[1]-a[1]);};
 const certain=v=>!!v[0]&&v[0][1]>=Math.min(.12,step)&&(!v[1]||v[0][1]>v[1][1]*3);
 const color=(list,t,window=2)=>{const groups=new Map();let last=-Infinity;for(const o of list){if(Math.abs(o.t-t)>window||o.t-last<.2)continue;last=o.t;const c=classifyUniform(o.b.appearance,snapshot.review?.uniforms||{});if(c.group&&c.strength>=.15)groups.set(c.group,(groups.get(c.group)||0)+c.strength);}const ranked=[...groups].sort((a,b)=>b[1]-a[1]);return ranked[0]&&ranked[0][1]>(ranked[1]?.[1]||0)*1.5?ranked[0][0]:null;};
 const ends=[...tracks].map(([id,list])=>({id,list,t:list.at(-1).t,end:list.at(-1),start:list[0]})),starts=[...ends].sort((a,b)=>a.start.t-b.start.t).map(x=>({...x,t:x.start.t}));
 const edges=[];
 for(const a of ends){if(a.list.length<3)continue;const before=a.list[Math.max(0,lower(a.list,a.end.t-.6))],dt=a.end.t-before.t;if(dt<=0)continue;const v=[(a.end.xy[0]-before.xy[0])/dt,(a.end.xy[1]-before.xy[1])/dt];if(distance([0,0],v)>11)continue;
  for(let j=lower(starts,a.end.t+.001);j<starts.length&&starts[j].t-a.end.t<=1.5;j++){
   const b=starts[j],gap=b.t-a.end.t;if(a.id===b.id||b.list.length<3)continue;
   if([a.end.xy,b.start.xy].some(p=>p[0]<0||p[0]>1||p[1]<0||p[1]>1.08))continue;
   const predicted=[a.end.xy[0]+v[0]*gap,a.end.xy[1]+v[1]*gap],error=distance(predicted,b.start.xy),travel=distance(a.end.xy,b.start.xy);
   if(error>.6+gap*.8||travel>.8+gap*8)continue;
   const after=b.list[Math.min(b.list.length-1,lower(b.list,b.start.t+.6))],v2=[after.xy[0]-b.start.xy[0],after.xy[1]-b.start.xy[1]];
   // At the substitution line, an exiting and an entering player are different
   // people even when the boxes touch. Require the same crossing direction.
   if(Math.max(a.end.xy[1],b.start.xy[1])>.93&&(Math.abs(v[1])<.025||v[1]*v2[1]<=0))continue;
   const av=votes([a.id],a.end.t,-2,.1),bv=votes([b.id],b.start.t,-.1,2);
   if(certain(av)&&certain(bv)&&av[0][0]!==bv[0][0])continue;
   const ac=color(a.list,a.end.t,1),bc=color(b.list,b.start.t,1);if(ac&&bc&&side(ac)!==side(bc))continue;
   const ab=a.end.b.box,bb=b.start.b.box,ratio=((bb[2]-bb[0])*(bb[3]-bb[1]))/((ab[2]-ab[0])*(ab[3]-ab[1]));if(ratio<.45||ratio>2.2)continue;
   edges.push({a:a.id,b:b.id,score:error/(.6+gap*.8)+gap*.15+Math.abs(Math.log(ratio))*.2});
  }
 }
 const outgoing=new Map(),incoming=new Map();for(const e of edges){for(const [map,key]of [[outgoing,e.a],[incoming,e.b]]){const a=map.get(key)||[];a.push(e);map.set(key,a);}}
 const unique=rows=>{rows?.sort((a,b)=>a.score-b.score);return rows?.length&&(!rows[1]||(rows[1].score-rows[0].score>.35&&rows[1].score>rows[0].score*1.5))?rows[0]:null;};
 const next=new Map(),prev=new Map();for(const e of edges)if(unique(outgoing.get(e.a))===e&&unique(incoming.get(e.b))===e){next.set(e.a,e.b);prev.set(e.b,e.a);}
 const parent=new Map([...tracks.keys()].map(id=>[id,id])),membersOf=new Map([...tracks.keys()].map(id=>[id,[id]])),root=id=>{let p=id;while(parent.get(p)!==p)p=parent.get(p);return p;};
 const conflicts=new Map();
 const simultaneousPeople=(a,b)=>{
  const key=[a,b].sort((a,b)=>a-b).join(':');if(conflicts.has(key))return conflicts.get(key);
  const aa=tracks.get(a),bb=tracks.get(b);let mismatches=0,first=null,last=-Infinity;
  // Reject transitive crop bridges between original people seen simultaneously.
  for(let i=lower(aa,bb[0].t-step*.5);i<aa.length&&aa[i].t<=bb.at(-1).t+step*.5;i++){
   const q=aa[i];if(q.t-last<.2||q.b.recovery)continue;last=q.t;
   const at=lower(bb,q.t),r=[bb[at-1],bb[at]].filter(Boolean).sort((a,b)=>Math.abs(a.t-q.t)-Math.abs(b.t-q.t))[0];
   if(!r||r.b.recovery||Math.abs(r.t-q.t)>step*.55||distance(q.xy,r.xy)<1.2)continue;
   first??=q.t;if(++mismatches>=3&&q.t-first>=.4){conflicts.set(key,true);return true;}
  }
  conflicts.set(key,false);return false;
 };
 const join=(a,b)=>{if(!parent.has(a)||!parent.has(b))return;const ar=root(a),br=root(b);if(ar===br)return;
  const aa=membersOf.get(ar),bb=membersOf.get(br);if(aa.some(x=>bb.some(y=>simultaneousPeople(x,y))))return;
  parent.set(br,ar);membersOf.set(ar,[...aa,...bb]);membersOf.delete(br);
 };
 for(const [a,b]of next)join(a,b);
 const aliases=data.recoveryAliases||[];
 for(const a of aliases){
  // A crop track overlapping two distinct original people at the same time
  // is not a reliable identity bridge, even if both are near the touchline.
  if(aliases.some(b=>b.trackId===a.trackId&&b.originalId!==a.originalId&&b.from<a.to-.2&&a.from<b.to-.2))continue;
  join(a.originalId,a.trackId);
 }
 const members=new Map();for(const id of tracks.keys()){const r=root(id),ids=members.get(r)||[];ids.push(id);members.set(r,ids);}
 const paths=new Map(),pathOf=new Map();for(const [id,ids]of members){const observations=ids.flatMap(k=>tracks.get(k)).sort((a,b)=>a.t-b.t),list=[];
  // Keep original geometry/colour at shared times. The new pass fills missing
  // observations and joins fragments without replacing established detections.
  for(const o of observations){const last=list.at(-1);if(last&&Math.abs(last.t-o.t)<=step*.5+1e-6){if(last.b.recovery&&!o.b.recovery||o.b.recovery===last.b.recovery&&o.b.confidence>last.b.confidence)list[list.length-1]=o;}else list.push(o);}
  for(let i=0;i<list.length-1;i++)list[i]={...list[i],dt:Math.min(list[i].dt,list[i+1].t-list[i].t)};
  const path={id,ids,list};paths.set(id,path);for(const k of ids)pathOf.set(k,path);
 }
 const positions=new Map(original.players.map(p=>[p.id,[...p.positions].sort((a,b)=>a.t-b.t)]));
 const spatialOwner=(path,t,kind)=>{
  const rows=path.list.filter(o=>o.t>=t+(kind==='out'?-8:0)&&o.t<=t+(kind==='out'?0:20)),ranked=[];
  for(const p of original.players){const saved=positions.get(p.id);let count=0,seconds=0,close=0,error=0,last=-Infinity;
   for(const o of rows){if(o.t-last<.2)continue;last=o.t;const at=lower(saved,o.t),near=[saved[at-1],saved[at]].filter(q=>q&&q.t<=o.t+step*.6&&q.t+q.seconds>=o.t-step*.6);if(!near.length)continue;const d=Math.min(...near.map(q=>distance(o.heatXY,[q.x,q.y])));count++;if(d<=1.0){close++;seconds+=Math.min(.2,near[0].seconds);error+=d;}}
   if(close>=4&&seconds>=.25&&close/count>=.8)ranked.push({id:p.id,error:error/close,close,seconds});
  }
  ranked.sort((a,b)=>a.error-b.error);
  // Several time-aligned observations and a clear margin over every teammate
  // are required; one nearest point or uniform colour alone cannot assign a name.
  return ranked[0]&&ranked[0].error<=.65&&(!ranked[1]||ranked[1].error-ranked[0].error>.35)?ranked[0]:null;
 };
 const crossings=[];
 const add=(path,o,kind,evidence)=>{const owner=votes(path.ids,o.t,kind==='out'?-6:-.2,kind==='out'?.2:8),past=kind==='out'&&!certain(owner)?votes(path.ids,o.t,-20,.2):owner,spatial=!certain(past)?spatialOwner(path,o.t,kind):null,source=certain(past)?people.get(past[0][0]):spatial?people.get(spatial.id):null,uniform=color(path.list,o.t),team=side(uniform)||side(source?.group),conflict=!!uniform&&!!source&&side(uniform)!==side(source.group);
  crossings.push({trackId:o.b.id,pathId:path.id,pathIds:path.ids,time:o.t,kind,evidence,team,sourceId:source?.id||null,sourceEvidence:spatial?'spatial-continuity':'track-ownership',ownerCertain:!!source,colorConflict:conflict,box:[...o.b.box],x:o.xy[0],y:o.xy[1]});};
 for(const path of paths.values()){let last=null,lastT=-Infinity,lastStateT=-Infinity;
  for(let i=0;i<path.list.length;i++){const o=path.list[i],xy=o.xy;if(!events.some(e=>Math.abs(e.time-o.t)<=28))continue;
   if(o.t-lastT>2)last=null;lastT=o.t;
   if(xy[0]<0||xy[0]>1||xy[1]<.65){last=null;continue;}
   const state=xy[1]<.97?'inside':xy[1]>1.025?'outside':null;if(!state)continue;
   if(last&&last!==state){const kind=state==='inside'?'in':'out';let held=0;for(let j=i;j<path.list.length&&path.list[j].t<=o.t+1.5;j++){const q=path.list[j];if(kind==='in'?q.xy[1]<1:q.xy[1]>1)held+=q.dt;}
    if(held>=Math.min(.2,original.to-o.t-.1)){
     add(path,o,kind,'crossing');
     if(!events.some(e=>Math.abs(e.time-lastStateT)<=16)){crossings.at(-1).reviewOnly=true;if(kind==='in')crossings.at(-1).evidence='boundary-wait';}
    }}
   last=state;lastStateT=o.t;
  }
  // A substitute can wait ON the line without ever entering the outside state.
  // Stable waiting followed by sustained inward travel is reviewable evidence.
  for(const event of events){
   const near=path.list.slice(lower(path.list,event.time-20),lower(path.list,event.time+9));
   const pre=near.filter(o=>o.t>=event.time-8&&o.t<=event.time-2),post=near.filter(o=>o.t>=event.time-2&&o.t<=event.time+8);
   if(pre.length<6||pre.at(-1).t-pre[0].t<2||!post.length)continue;
   const ys=pre.map(o=>o.xy[1]).sort((a,b)=>a-b),xs=pre.map(o=>o.xy[0]).sort((a,b)=>a-b),y=ys[Math.floor(ys.length/2)];
   // Walking along the line while waiting is allowed; inward travel is tested separately.
   if(y<.95||y>1.08||xs[0]<0||xs.at(-1)>1||ys.at(-1)-ys[0]>.06||xs.at(-1)-xs[0]>.25)continue;
   if(near.some(o=>o.t<event.time-8&&o.xy[1]<.90))continue;
   const inside=post.filter(o=>o.xy[1]<Math.min(.9,y-.12));
   if(inside.length<4||inside.at(-1).t-inside[0].t<1||inside.reduce((s,o)=>s+o.dt,0)<.6)continue;
   if(crossings.some(c=>c.pathId===path.id&&c.kind==='in'&&Math.abs(c.time-inside[0].t)<6))continue;
   const at=post.find(o=>o.t<=inside[0].t&&o.xy[1]<y-.04)||inside[0];
   add(path,at,'in','boundary-wait');crossings.at(-1).reviewOnly=true;
  }
  // The detector may drop a person at the touchline. Require an observed,
  // directed approach/arrival at that line; a disappearance in the field is not enough.
  for(const kind of ['in','out']){const endpoint=kind==='in'?path.list[0]:path.list.at(-1);if(endpoint.t<original.from+2||endpoint.t>original.to-2||endpoint.xy[0]<0||endpoint.xy[0]>1||endpoint.xy[1]<.96||endpoint.xy[1]>1.08||!events.some(e=>Math.abs(e.time-endpoint.t)<=12))continue;
   if(crossings.some(c=>c.pathId===path.id&&c.kind===kind&&Math.abs(c.time-endpoint.t)<3))continue;
   // Crop detections can reveal a player slowly walking out from behind a
   // sideline person. Allow six seconds to establish the directed arrival;
   // still require the first/last observation at the boundary and motion inside.
   const recovered=path.ids.some(id=>tracks.get(id)?.some(o=>o.b.recovery&&Math.abs(o.t-endpoint.t)<1)),approach=recovered?6:2;
   const near=path.list.filter(o=>kind==='in'?o.t>endpoint.t&&o.t<=endpoint.t+approach:o.t<endpoint.t&&o.t>=endpoint.t-approach);
   // For the supplementary pass require at least 1.2m of inward depth on a
   // 20m court, instead of demanding a fast run two metres past the line.
   const inside=recovered?Math.min(.94,endpoint.xy[1]-.06):.90;
   if(near.length>=3&&near.some(o=>o.xy[1]<=inside)&&near.reduce((n,o)=>n+o.dt,0)>=.4)add(path,endpoint,kind,'boundary-endpoint');
  }
 }
 for(const c of crossings)c.returning=crossings.some(q=>q.pathId===c.pathId&&q.kind!==c.kind&&Math.abs(q.time-c.time)<12);
 return {tracks,paths,pathOf,owners,people,crossings,step,votes,certain,camera,spatialOwner};
}
