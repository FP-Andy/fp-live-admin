import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeShadowBodies} from '../apps/web/public/fpa-cv/shadow-bodies.mjs';
import {packRecovery,hydrateRecovery,recoverySignature} from '../apps/web/public/fpa-cv/recovery-protocol.mjs';

const bodyAppearance=[{rgb:[60,45,140],weight:.8},{rgb:[10,12,20],weight:.2}];
const shadowAppearance=[{rgb:[4,18,8],weight:.85},{rgb:[60,45,140],weight:.15}];
function fixture(){
 const frames=Array.from({length:10},(_,i)=>({t:i/15,boxes:Array.from({length:3},(_,j)=>{
  const x=.1+j*.27+i*.001,y=.2;
  return [{id:j*2+1,box:[x,y,x+.02,y+.05],confidence:.5,appearance:bodyAppearance},
  {id:j*2+2,box:[x,y-.005,x+.08,y+.05],confidence:.8,appearance:shadowAppearance}];
 }).flat()}));
 const data={video:{clipStart:0,clipEnd:10/15,width:1000,height:1000},detector:{sampleFps:15},frames,tracks:Array.from({length:6},(_,i)=>({id:i+1,first:0,last:.6,samples:10}))};
 const review={shadowCorrection:true,segments:[],roster:[],checkpoints:[],rejections:[]};return {data,review};
}
test('retains bodies even when shadow-inclusive detection has higher confidence',()=>{
 const {data,review}=fixture(),original=structuredClone(data),out=normalizeShadowBodies(data,review);
 assert.equal(out.shadowBodies.hidden,30);for(const f of out.data.frames)assert.deepEqual(f.boxes.map(b=>b.id),[1,3,5]);assert.deepEqual(data,original);
});
test('does not remove standalone dark players or force a roster count',()=>{
 const {data,review}=fixture();data.frames=data.frames.map(f=>({...f,boxes:f.boxes.filter(b=>b.id%2===0)}));
 assert.equal(normalizeShadowBodies(data,review).shadowBodies.hidden,0);
});
test('independent labelled people and locked operator choices survive a duel',()=>{
 for(const segments of [[{trackId:1,personId:'p1',team:'home',from:0,to:1},{trackId:2,personId:'p2',team:'away',from:0,to:1}],[{trackId:2,personId:'p2',team:'away',from:0,to:1,locked:true}]]){
  const {data,review}=fixture();review.segments=segments;const out=normalizeShadowBodies(data,review);
  for(const f of out.data.frames){assert(f.boxes.some(b=>b.id===1));assert(f.boxes.some(b=>b.id===2));}
 }
});
test('a broad box containing two bodies is not suppressed',()=>{
 const {data,review}=fixture();for(const f of data.frames){const b=f.boxes[0];f.boxes.push({...b,id:7,box:b.box.map((v,i)=>v+(i%2===0?.035:0))});}
 assert(normalizeShadowBodies(data,review).data.frames.every(f=>f.boxes.some(b=>b.id===2)));
});
test('tracks observed separately before contact are not merged',()=>{
 const {data,review}=fixture();data.frames[0].boxes[1]={...data.frames[0].boxes[1],box:[.85,.7,.93,.755]};
 assert(normalizeShadowBodies(data,review).data.frames.every(f=>f.boxes.some(b=>b.id===2)));
});
test('camera rotation does not change the learned shadow direction decision',()=>{
 const {data,review}=fixture();for(const f of data.frames)for(const b of f.boxes)b.box=[b.box[1],1-b.box[2],b.box[3],1-b.box[0]];
 assert.equal(normalizeShadowBodies(data,review).shadowBodies.hidden,30);
});
test('an inherited number is bounded to the observed pair, keeps provenance and obeys rejection',()=>{
 const {data,review}=fixture();review.segments=[{trackId:2,personId:'p1',group:'away',team:'away',jersey:'3',source:'manual',from:0,to:1}];
 const out=normalizeShadowBodies(data,review);assert(out.segments.length);assert(out.segments.every(s=>s.trackId===1&&s.source==='auto'&&s.previousTrack===2&&s.to<=data.video.clipEnd));
 review.rejections=[{trackId:1,personId:'p1',from:0,to:1}];const rejected=normalizeShadowBodies(data,review);assert.equal(rejected.segments.length,0);assert(rejected.data.frames.every(f=>f.boxes.some(b=>b.id===2)));
});
test('nearby manual locks retain their original colour evidence',()=>{
 const {data,review}=fixture();review.segments=[{trackId:2,personId:'p1',team:'away',from:0,to:.1,locked:true}];
 const out=normalizeShadowBodies(data,review);assert.deepEqual(out.data.frames[0].boxes.find(b=>b.id===2),data.frames[0].boxes.find(b=>b.id===2));
});
test('worker cache preserves corrected colour and original data remains untouched',()=>{
 const {data}=fixture(),copy=structuredClone(data),corrected={...data,frames:data.frames.map((f,i)=>i?f:{...f,boxes:f.boxes.slice(1).map(b=>b.id===2?{...b,appearance:[],shadowColourMuted:true}:b)})};
 const packed=packRecovery({data:corrected,segments:[]},data);assert.deepEqual(hydrateRecovery(packed,data).data.frames,corrected.frames);assert.deepEqual(data,copy);
});
test('feature is opt in and participates in the applied-review cache key',()=>{
 const {data,review}=fixture();assert.equal(normalizeShadowBodies(data,{...review,shadowCorrection:false}).data,data);
 assert.notEqual(recoverySignature(review),recoverySignature({...review,shadowCorrection:false}));
});
