import {classifyUniform} from './colors.mjs';
export const REDETECTION_VERSION='fpa-substitution-redetection/v1';
export const substitutionLogContext=log=>log?{video:Object.fromEntries(['name','duration','from','to'].map(k=>[k,log.video[k]])),events:log.substitutions.map(({id,time,team})=>({id,time,team})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)}:null;
const sameContext=(a,b)=>!!a&&JSON.stringify(substitutionLogContext({video:a.video,substitutions:a.events}))===JSON.stringify(substitutionLogContext(b));
const side=g=>g?.startsWith('home')?'home':g?.startsWith('away')?'away':null;
const overlap=(a,b)=>{const i=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return i/Math.max(1e-10,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i);};
const lower=(rows,t)=>{let a=0,b=rows.length;while(a<b){const m=(a+b)>>1;if(rows[m].t<t)a=m+1;else b=m;}return a;};
/** Only unresolved logs are scheduled. Nearby windows share one inference run. */
export function planSubstitutionRedetection(snapshot,data,saved,result){
 if(result.provenance.snapshotId!==snapshot.id||result.provenance.logRevision!==saved.revision||data.datasetId!==snapshot.heatmap.datasetId)throw Error('재탐지 원본과 교체로그 버전이 다릅니다.');
 const pending=new Set(result.events.filter(e=>e.status==='review'||e.trackingStatus==='partial').map(e=>e.id)),windows=[];
 for(const e of [...(saved.log?.substitutions||[])].sort((a,b)=>a.time-b.time)){
  if(!pending.has(e.id))continue;
  const from=Math.max(snapshot.heatmap.from,e.time-16),to=Math.min(snapshot.heatmap.to,e.time+24),last=windows.at(-1);
  if(last&&from<=last.to&&to-last.from<=80){last.to=Math.max(last.to,to);last.eventIds.push(e.id);}
  else windows.push({from,to,eventIds:[e.id]});
 }
 return {schema:REDETECTION_VERSION,datasetId:data.datasetId,snapshotId:snapshot.id,logRevision:saved.revision,logContext:substitutionLogContext(saved.log),video:{name:data.video.name,duration:data.video.duration},model:data.detector.model,roi:data.detector.roi,uniforms:snapshot.review?.uniforms||{},windows:windows.map((w,i)=>({...w,id:i+1})),totalSeconds:windows.reduce((n,w)=>n+w.to-w.from,0)};
}
/** Compare new track IDs against simultaneous original boxes, never ID numbers.
 * The caller retains the original snapshot; this only creates a derived input. */
export function mergeSubstitutionRedetection(snapshot,data,saved,recovery){
 if(typeof recovery?.id!=='string'||!recovery.id||recovery.id.length>128||recovery?.schema!==REDETECTION_VERSION||recovery.datasetId!==data.datasetId||recovery.snapshotId!==snapshot.id||(recovery.logContext?!sameContext(recovery.logContext,saved.log):recovery.logRevision!==saved.revision)||recovery.video?.name!==data.video.name||Math.abs(recovery.video.duration-data.video.duration)>.2)throw Error('다른 원본 또는 오래된 교체 재탐지 결과입니다.');
 // Tracker metadata stores float32 corners; setup and GPU plans retain float64.
 // One millionth of a frame is below 0.004 px even for 4K video.
 const sameCourt=Array.isArray(recovery.roi)&&recovery.roi.length===4&&Array.isArray(data.detector.roi)&&data.detector.roi.length===4&&recovery.roi.every((p,i)=>Array.isArray(p)&&p.length===2&&p.every((v,j)=>Number.isFinite(v)&&Number.isFinite(data.detector.roi[i]?.[j])&&Math.abs(v-data.detector.roi[i][j])<=1e-6));
 if(!sameCourt||recovery.model!==data.detector.model)throw Error('재탐지 코트 또는 모델 설정이 원본과 다릅니다.');
 const originalIds=new Set(data.frames.flatMap(f=>f.boxes.map(b=>b.id))),frames=new Map(data.frames.map(f=>[f.t,{...f,boxes:[...f.boxes]}])),seen=new Map(),evidence=new Map(),tolerance=.49/data.detector.sampleFps;
 for(const w of recovery.windows){
  if(!Number.isFinite(w.from)||!Number.isFinite(w.to)||w.to<=w.from||w.from<snapshot.heatmap.from-1e-6||w.to>snapshot.heatmap.to+1e-6||w.to-w.from>80.01)throw Error('재탐지 구간 범위를 확인하세요.');
  for(const f of w.frames){
   if(!Number.isFinite(f.t)||f.t<w.from-1e-6||f.t>=w.to+1e-6)throw Error('재탐지 프레임이 구간 밖에 있습니다.');
   const i=lower(data.frames,f.t),near=[data.frames[i-1],data.frames[i]].filter(Boolean).sort((a,b)=>Math.abs(a.t-f.t)-Math.abs(b.t-f.t))[0],original=near&&Math.abs(near.t-f.t)<=tolerance?near:null,t=original?.t??f.t,row=frames.get(t)||{t,boxes:[]};
   for(const b of f.boxes){
    if(!Number.isSafeInteger(b.id)||b.id<=0||originalIds.has(b.id)||!Array.isArray(b.box)||b.box.length!==4||!b.box.every(n=>Number.isFinite(n)&&n>=0&&n<=1)||b.box[2]<=b.box[0]||b.box[3]<=b.box[1]||!Number.isFinite(b.confidence)||b.confidence<0||b.confidence>1)throw Error('재탐지 객체 또는 ID 범위가 잘못되었습니다.');
    if(seen.has(b.id)&&seen.get(b.id)!==w.id)throw Error('재탐지 구간 사이의 ID가 중복됩니다.');seen.set(b.id,w.id);
    if(row.boxes.some(q=>q.id===b.id))throw Error('재탐지 관측이 중복됩니다.');
    const added={...b,recovery:true};row.boxes.push(added);
    if(!original)continue;
    const color=classifyUniform(b.appearance,snapshot.review?.uniforms||{}),rank=original.boxes.map(q=>({q,score:overlap(b.box,q.box)})).filter(q=>q.score>.45).sort((a,b)=>b.score-a.score);
    if(!rank[0]||rank[1]&&rank[0].score-rank[1].score<.2)continue;
    const old=rank[0].q,oldColor=classifyUniform(old.appearance,snapshot.review?.uniforms||{});
    if(color.strength>.3&&oldColor.strength>.3&&side(color.group)&&side(oldColor.group)&&side(color.group)!==side(oldColor.group))continue;
    // A crop changes the background sampled by the colour descriptor. Preserve
    // original-frame colour evidence for the same overlapping body; keep the
    // new descriptor separately so a geometry repair cannot silently flip team.
    if(rank[0].score>=.6&&old.appearance?.length){added.appearance=old.appearance;added.redetectedAppearance=b.appearance;added.appearanceSource='original-overlap';}
    const key=b.id+':'+old.id,list=evidence.get(key)||[];list.push({t,score:rank[0].score,newId:b.id,oldId:old.id});evidence.set(key,list);
   }frames.set(t,row);
  }
 }
 const aliases=[];
 for(const rows of evidence.values()){
  const unique=[...new Map(rows.map(q=>[q.t,q])).values()].sort((a,b)=>a.t-b.t),first=unique[0];
  // Sustained overlap is required; crossing at one frame cannot bridge identities.
  if(unique.length<6||unique.at(-1).t-first.t<.45||unique.reduce((s,q)=>s+q.score,0)/unique.length<.6)continue;
  const rivals=[...evidence.values()].filter(r=>r[0].oldId===first.oldId&&r[0].newId!==first.newId&&r.some(q=>q.t>=first.t&&q.t<=unique.at(-1).t));
  if(rivals.some(r=>r.length>=unique.length*.35))continue;
  aliases.push({trackId:first.newId,originalId:first.oldId,samples:unique.length,from:first.t,to:unique.at(-1).t});
 }
 return {...data,frames:[...frames.values()].sort((a,b)=>a.t-b.t),recoveryAliases:aliases,substitutionRecovery:{id:recovery.id,ancestorIds:recovery.ancestorIds||[],schema:recovery.schema,snapshotId:recovery.snapshotId,logRevision:recovery.logRevision,windows:recovery.windows.map(({frames,...w})=>w),aliases}};
}
