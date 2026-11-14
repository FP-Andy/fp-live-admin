import assert from 'node:assert/strict';
import {hitBoxes,hitJoint} from '../../apps/web/public/kbl-grayzone/frame-hit.mjs';
import {EditHistory} from '../../apps/web/public/kbl-grayzone/edit-history.mjs';
import {resolveBodyDirection,facingRelation,cameraPosition,wrapAngle} from '../../apps/web/public/kbl-grayzone/body-direction.mjs';

const outer={id:'outer',pixelBox:[0,0,100,100]},inner={id:'inner',pixelBox:[20,20,40,40]},excluded={...inner,id:'excluded',excluded:true};
assert.deepEqual(hitBoxes([outer,excluded,inner],[30,30]).map(o=>o.id),['inner','outer']);
assert.equal(hitBoxes([outer],[200,200]).length,0);
const points=Array.from({length:17},()=>[800,800]);points[9]=[100,100];
const people=[{id:'a',keypoints:points},{id:'b',keypoints:points}];
assert.deepEqual(hitJoint(people,[120,100],.5,.5,'b'),{personId:'b',joint:9,distance:10});
assert.equal(hitJoint(people,[125,100],.5,.5,'b'),null);
// A complete drag is one transaction, selection/no-op is no history entry.
const history=new EditHistory(),before={people:structuredClone(people)};
people[1].keypoints=structuredClone(points);people[1].keypoints[9]=[140,160];history.push(before);
assert.equal(history.undo({people}).people[1].keypoints[9][0],100);
assert.equal(history.redo(before).people[1].keypoints[9][0],140);
const pose={bodyHeading:1,meshBodyHeading:1,bodyDirection:{heading:1,status:'estimated'}};
assert.equal(resolveBodyDirection({bodyHeading:-2,bodyDirectionSource:'assumed'},pose).heading,1);
assert.equal(resolveBodyDirection({bodyHeading:-2,bodyDirectionSource:'manual'},pose).heading,-2);
assert.equal(resolveBodyDirection({},null).status,'unresolved');
assert.equal(resolveBodyDirection({}, {bodyHeading:1}).status,'uncertain');
assert.equal(facingRelation({x:14,y:7.5},{x:26.425,y:7.5},0),'front');
assert.equal(facingRelation({x:14,y:7.5},{x:1.575,y:7.5},0),'back');
assert.equal(facingRelation({x:14,y:7.5},{x:14,y:15},0),'side');
assert.deepEqual(cameraPosition({worldToCamera:[[1,0,0],[0,1,0],[0,0,1]],translation:[-2,-3,-4]}),{x:2,y:3});
assert.ok(Math.abs(wrapAngle(2*Math.PI+.2)-.2)<1e-10);
console.log('Frame hit testing, drag history, body direction provenance and relations passed.');
