import assert from 'node:assert/strict';
import fs from 'node:fs';import zlib from 'node:zlib';
import {deriveSubstitutionReport} from '../apps/web/public/fpa-cv/substitution-report.mjs';
function fixture({two=false,kick=false,early=false}={}){
 const roi=[[0,0],[1,0],[1,1],[0,1]],uniforms={home:[[255,0,0]],away:[[0,0,255]]},frames=[],people=Array.from({length:two?2:1},(_,i)=>({id:'home-'+i,group:'home',jersey:String(i+2),positions:[],grid:Array(3200).fill(0)}));
 const box=(id,x,y)=>({id,box:[x-.01,y-.02,x+.01,y+.02],confidence:.9,appearance:[{rgb:[255,0,0],weight:1}]});
 for(let i=0;i<150;i++){const t=i/5,boxes=[];for(let p=0;p<people.length;p++){
  const old=100+p,newTrack=kick?old:200+p,x=.35+p*.3;
  const y=t<9?.6:t<10? .6+(t-9)*.5:1.1;
  if(t<=10.8)boxes.push(box(old,x,y));
  const entry=early?10:12,ny=t<entry-1?1.1:t<entry?1.1-(t-(entry-1))*.2:.8;
  if(t>=entry-1&&(!kick||t>10.8))boxes.push(box(newTrack,x,ny));
  const observed=boxes.find(b=>b.id===old&&t<10)||boxes.find(b=>b.id===newTrack&&t>=entry);
  if(observed){const q={t,x,y:(observed.box[1]+observed.box[3])/2,seconds:.2,trackId:observed.id,source:'automatic'};if(q.y<=1){people[p].positions.push(q);people[p].grid[Math.floor(q.y*40)*80+Math.floor(x*80)]+=.2;}}
 }frames.push({t,boxes});}
 const video={name:'sample.mp4',duration:30,clipStart:0,clipEnd:30},data={datasetId:'fixture',video,detector:{sampleFps:5,roi},frames};
 const heatmap={schema:'fpa-heatmaps/v1',datasetId:'fixture',video:video.name,from:0,to:30,width:80,height:40,scale:1,point:'center',players:people};
 const snapshot={id:'a'.repeat(32),jobId:'b'.repeat(32),matchId:'match',heatmap,review:{uniforms,roster:[...people,{id:'home_gk-1',group:'home_gk',jersey:'1'}]}};
 const saved={revision:1,log:{schema:'fpa-substitution-log/v2',video:{name:video.name,duration:30,from:0,to:30},players:[],initialPlayers:[],substitutions:[{id:'event',time:11,team:'home',note:''},...(two?[{id:'event2',time:11.1,team:'home',note:''}]:[])]}};
 return {snapshot,data,saved};
}
const run=f=>deriveSubstitutionReport(f.snapshot,f.data,f.saved);
const f=fixture(),before=JSON.stringify(f),r=run(f);assert.equal(r.status,'ready');assert.equal(r.heatmap.players.length,2);assert.equal(r.events[0].outTrackId,100);assert.equal(r.events[0].inTrackId,200);assert.equal(JSON.stringify(f),before,'immutable input');
for(const p of r.heatmap.players)for(const q of p.positions)assert(q.t>=p.activeFrom&&q.t+q.seconds<=p.activeTo+.002);
assert.equal(run(fixture({kick:true})).status,'review','kick-in must not become substitution');
const ambiguous=fixture({two:true});assert.equal(run(ambiguous).status,'review','simultaneous swaps do not guess pairing');
for(const [i,e]of ambiguous.saved.log.substitutions.entries())e.tracking={snapshotId:ambiguous.snapshot.id,outPersonId:'home-'+i,outTrackId:100+i,inTrackId:200+i};
assert.equal(run(ambiguous).status,'ready','manual decisions resolve ambiguity');
ambiguous.saved.log.substitutions[0].tracking.snapshotId='c'.repeat(32);assert.equal(run(ambiguous).status,'review','old snapshot decisions expire');
f.saved.log.substitutions=[];assert.equal(run(f).heatmap.players.length,1,'deleting logs restores baseline instead of retaining old splits');
f.saved.log.substitutions=[{id:'event',time:11,team:'home',note:''}];f.saved.log.video.name='other.mp4';assert.throws(()=>run(f),/영상이 다릅니다/);
if(process.argv[2]){const b=JSON.parse(zlib.gunzipSync(fs.readFileSync(process.argv[2]))),out=deriveSubstitutionReport(b.snapshot,b.tracks,b.log);assert.equal(out.status,'ready');assert.deepEqual(out.events.map(e=>[e.outTrackId,e.inTrackId]),[[8282,8991],[14702,15650]]);assert.deepEqual(out.heatmap.players.filter(p=>p.id.startsWith('sub-')).map(p=>Math.round(p.observed)),[438,11]);console.log('PASS real Ulsan–Jeonbuk: both reviewed pairs and observed durations reproduced.');}
console.log('PASS: immutable source, distinct stints, ambiguous batch review, manual resolution, stale decision rejection, deletion reset and kick-in exclusion.');
