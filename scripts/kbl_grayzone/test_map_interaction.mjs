import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dragStarted,positionDragPoint,positionTargets,placementTarget} from '../../apps/web/public/kbl-grayzone/map-interaction.mjs';
import {MAP,mapPoint,mapCourt} from '../../apps/web/public/kbl-grayzone/scene-map.mjs';
import {setCourtPosition} from '../../apps/web/public/kbl-grayzone/ground-position.mjs';
import {EditHistory} from '../../apps/web/public/kbl-grayzone/edit-history.mjs';

test('a click or small pointer jitter only selects; deliberate dragging crosses a CSS-pixel threshold',()=>{
 const drag={startClient:[100,100],moved:false};
 assert.equal(dragStarted(drag,{clientX:100,clientY:100}),false);
 assert.equal(dragStarted(drag,{clientX:103,clientY:102}),false);
 assert.equal(dragStarted(drag,{clientX:105,clientY:100}),true);
 assert.equal(dragStarted({...drag,moved:true},{clientX:100,clientY:100}),true);
});
test('off-centre grabbing has no snap and respects the map display scale',()=>{
 for(const cssScale of [.35,.75,1]){
  const person={x:12,y:7},pixel=mapPoint(person).map((v,i)=>v+[8,-5][i]);
  const grab=mapCourt(pixel),drag={offset:{x:person.x-grab.x,y:person.y-grab.y}};
  const start=positionDragPoint(drag,pixel);
  assert.ok(Math.hypot(start.x-12,start.y-7)<1e-10);
  const moved=positionDragPoint(drag,pixel.map((v,i)=>v+[2*MAP.scale,-MAP.scale][i]/cssScale));
  assert.ok(Math.abs(moved.x-(12+2/cssScale))<1e-10);
  assert.ok(Math.abs(moved.y-(7-1/cssScale))<1e-10);
 }
});
test('overlapping markers cycle on click but retain the chosen person when dragged',()=>{
 const bodies=[{id:'a',x:12,y:7},{id:'b',x:12.1,y:7},{id:'c',x:24,y:3}];
 assert.deepEqual(positionTargets(bodies,mapPoint(bodies[0]),.5,'a'),{dragId:'a',clickId:'b'});
 assert.deepEqual(positionTargets(bodies,mapPoint(bodies[0]),.5,'b'),{dragId:'b',clickId:'a'});
 assert.deepEqual(positionTargets(bodies,mapPoint(bodies[2]),.5,'a'),{dragId:'c',clickId:'c'});
 assert.equal(positionTargets(bodies,[0,0],.5,'a'),null);
});
test('court bounds include off-court referees, and moving keeps heading, pose and team',()=>{
 const entity={id:'ref',x:4,y:16,role:'referee',bodyHeading:.5,viewHeading:1.1,meshKey:'verified-pose',team:'unknown'};
 const history=new EditHistory(),before=structuredClone(entity),drag={offset:{x:0,y:0}};
 for(const p of [{x:8,y:16.2},{x:12,y:16.8}])setCourtPosition(entity,positionDragPoint(drag,mapPoint(p)));
 history.push(before);
 assert.ok(Math.abs(entity.y-16.8)<1e-10);
 assert.equal(entity.bodyHeading,before.bodyHeading);
 assert.equal(entity.viewHeading,before.viewHeading);
 assert.equal(entity.meshKey,before.meshKey);
 assert.equal(entity.team,before.team);
 assert.equal(entity.positionSource,'manual');
 assert.deepEqual(positionDragPoint(drag,mapPoint({x:-50,y:50})),{x:-4,y:19});
 assert.deepEqual(positionDragPoint(drag,mapPoint({x:50,y:-50})),{x:32,y:-3});
 assert.equal(history.past.length,1);
 assert.deepEqual(history.undo(entity),before);
});
test('placement selection follows eligible people and clears for staff or absent IDs',()=>{
 const boxes=[{id:'player',roleHint:'player'},{id:'ref',roleHint:'referee'},{id:'unplaced',roleHint:'referee'},{id:'staff',roleHint:'staff'}];
 for(const id of ['player','ref','unplaced'])assert.equal(placementTarget(boxes,id),id);
 for(const id of ['staff','missing',''])assert.equal(placementTarget(boxes,id),'');
 assert.equal(placementTarget([],undefined),'');
});
