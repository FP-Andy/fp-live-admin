import test from 'node:test';
import assert from 'node:assert/strict';
import {addOverlapLinks} from '../apps/web/public/fpa-cv/substitution-refinement.mjs';
const observation=(id,t,x=.4)=>({t,dt:.1,xy:[x,.5],b:{id,box:[x-.01,.47,x+.01,.5],confidence:.9}});
const path=(id,from,to,x=.4)=>({id,list:Array.from({length:Math.round((to-from)*10)+1},(_,i)=>observation(id,Number((from+i*.1).toFixed(5)),x))});
const graph=(paths,qualityReason=()=>null)=>addOverlapLinks({paths:new Map(paths.map(p=>[p.id,p])),step:.1,team:()=> 'home',distance:(a,b)=>Math.hypot((a[0]-b[0])*40,(a[1]-b[1])*20),qualityReason},{},{next:new Map(),links:[]});
test('two detector copies of the same body do not veto the continuation',()=>{const g=graph([path(1,0,1),path(2,.1,1.1),path(3,.2,3)]);assert.equal(g.next.get(1)?.b,3);assert.equal(g.next.get(2)?.b,3);});
test('contact tail uses last matched body observation, not the contaminated endpoint',()=>{const g=graph([path(1,0,1.5),path(2,0,3)],q=>q.b.id===1&&q.t>1?'contact-overlap':null);assert.equal(g.next.get(1)?.b,2);assert.equal(g.next.get(1)?.at,1);});
test('people seen apart before touching do not become the same identity',()=>{const a=path(1,0,3),b=path(2,0,5);for(const q of a.list)if(q.t<1.5){q.xy[0]+=.07;q.b.box[0]+=.07;q.b.box[2]+=.07;}assert.equal(graph([a,b]).next.size,0);});

import {buildContinuationGraph} from '../apps/web/public/fpa-cv/substitution-continuity.mjs';
const uniformSnapshot={review:{uniforms:{home:[[255,0,0]],away:[[0,0,255]]}}};
function turnPath(id,start,end,{incoming=false,offset=0,team='home'}={}){
 const list=[];for(let i=0;i<=Math.round((end-start)*10);i++){const t=start+i*.1,x=(incoming?.255-(t-start)*.05:.2+t*.05)+offset;list.push({t,dt:.1,xy:[x,.5],b:{id,confidence:.9,appearance:[{rgb:team==='home'?[255,0,0]:[0,0,255],weight:1}],box:[x-.01,.47,x+.01,.5]}});}return {id,ids:[id],list};
}
function turnGraph(paths,contact=true){return buildContinuationGraph({step:.1,paths:new Map(paths.map(p=>[p.id,p])),qualityReason:o=>contact&&[1,3].includes(o.b.id)&&o.t>1?'contact-overlap':null,team:o=>o.b.appearance[0].rgb[0]?'home':'away'},uniformSnapshot);}
test('a short contact turn can continue through duplicate detector endpoints',()=>{const g=turnGraph([turnPath(1,0,1.1),turnPath(3,0,1.1),turnPath(2,2,4,{incoming:true}),turnPath(4,2,4,{incoming:true})]);assert.equal(g.next.get(1)?.method,'contact-turn');assert.equal(g.next.get(3)?.b,g.next.get(1)?.b);});
test('a sharp turn without contact evidence remains unresolved',()=>{assert.equal(turnGraph([turnPath(1,0,1),turnPath(2,2,4,{incoming:true})],false).next.has(1),false);});
test('contact-turn recovery rejects an opponent or two distinct same-team candidates',()=>{
 assert.equal(turnGraph([turnPath(1,0,1.1),turnPath(2,2,4,{incoming:true,team:'away'})]).next.has(1),false);
 assert.equal(turnGraph([turnPath(1,0,1.1),turnPath(2,2,4,{incoming:true}),turnPath(4,2,4,{incoming:true,offset:.01})]).next.has(1),false);
});
