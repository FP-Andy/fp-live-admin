import test from 'node:test';
import assert from 'node:assert/strict';
import {focusCrop,focusToImage,imageToFocus} from '../../apps/web/public/kbl-grayzone/pose-focus.mjs';
import {hitJoint} from '../../apps/web/public/kbl-grayzone/frame-hit.mjs';
import {forwardNeutralArm,solveArm} from '../../apps/web/public/kbl-grayzone/arm-ik.mjs';

test('portrait focus contains the selected body and supported extended wrists without distortion',()=>{
 const p={pixelBox:[600,200,760,800],keypoints:Array.from({length:17},()=>[680,500]),scores:Array(17).fill(.9)};p.keypoints[9]=[580,340];
 const c=focusCrop(p);assert.ok(c.x<=580);assert.ok(c.x+c.width>=760);assert.ok(c.y<=200);assert.ok(c.y+c.height>=800);
 assert.ok(Math.abs(c.width/c.height-2/3)<1e-9);
 for(const q of [[580,340],[680,500],[760,800]]){const back=focusToImage(imageToFocus(q,c,480,720),c,480,720);assert.ok(Math.hypot(...back.map((v,i)=>v-q[i]))<1e-9);}
});
test('edge crops remain inside source and do not stretch partial bodies',()=>{
 for(const box of [[0,0,90,200],[1740,780,1920,1080],[0,0,1920,1080]]){
  const c=focusCrop({pixelBox:box});assert.ok(c.x>=0&&c.y>=0&&c.x+c.width<=1920&&c.y+c.height<=1080);
  assert.ok(Math.abs(c.width/c.height-2/3)<1e-9);
 }
 assert.equal(focusCrop(null),null);assert.equal(focusCrop({pixelBox:[0,NaN,2,3]}),null);
});
test('zoom drag gives identical source coordinates regardless of viewport size and ignores other people',()=>{
 const p={id:'selected',pixelBox:[600,200,760,800],keypoints:Array.from({length:17},()=>[680,500])};p.keypoints[9]=[720,400];
 const other={...p,id:'other'},c=focusCrop(p),source=[720,400];
 for(const width of [300,330,480]){
  const height=width*1.5,screen=imageToFocus(source,c,width,height),q=focusToImage(screen,c,width,height);
  const hit=hitJoint([p],q,width/c.width,height/c.height,'selected');assert.equal(hit.personId,'selected');assert.equal(hit.joint,9);
  assert.equal(hitJoint([other],q,width/c.width,height/c.height,'selected').personId,'other');
  const moved=focusToImage([screen[0]+8,screen[1]+12],c,width,height);
  assert.ok(Math.abs(moved[0]-source[0]-8/width*c.width)<1e-9);
 }
});
test('explicit front arm preset respects bone lengths and never mutates source rig or inferred joints',()=>{
 for(const side of ['l','r']){
  const s=side==='l'?1:-1,rig={upperLength:.28,lowerLength:.30,neutralUpper:[-.23,s*.33,-.91],neutralLower:[-.05,s*.1,-.99]},before=structuredClone(rig);
  const a=forwardNeutralArm(rig,side);assert.ok(a.elbow[0]>0&&a.wrist[0]>0);
  assert.ok(Math.abs(Math.hypot(...a.elbow)-rig.upperLength)<1e-9);
  assert.ok(Math.abs(Math.hypot(...a.wrist.map((v,i)=>v-a.elbow[i]))-rig.lowerLength)<1e-9);
  assert.ok(a.flexionDegrees<=145&&Math.abs(a.twistDegrees)<=110);
  const resaved=solveArm({elbow:a.elbow,wrist:a.wrist},rig);assert.ok(Math.hypot(...resaved.wrist.map((v,i)=>v-a.wrist[i]))<1e-7);
  assert.deepEqual(rig,before);
 }
});
