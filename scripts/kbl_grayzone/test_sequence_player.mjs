import assert from 'node:assert/strict';
import {targetSegment,activeSequenceAnchor} from '../../apps/web/public/kbl-grayzone/sequence-sync.mjs';
const a={id:'a',startSeconds:0,firstPts:0,endPts:4,previousBoundary:null};
const b={id:'b',startSeconds:4,firstPts:0,endPts:4,previousBoundary:{state:'contiguous-metadata',gapSeconds:0}};
assert.deepEqual(targetSegment([a,b],4.5,'a'),{segment:b,seconds:.5});
assert.equal(targetSegment([a,{...b,previousBoundary:{state:'gap'}}],4.5,'a').error.includes('끊김'),true);
assert.equal(targetSegment([a,b],9,'b').error.includes('없습니다'),true);
const c={...b,startSeconds:3.999,previousBoundary:{state:'contiguous-metadata',gapSeconds:-.001}};
assert.equal(targetSegment([a,c],3.9995,'a').segment.id,'b');
const d={...b,startSeconds:3.9,previousBoundary:{state:'overlap',gapSeconds:-.1}};
assert.equal(targetSegment([a,d],3.95,'a').error.includes('겹친'),true);
console.log('5 sequence boundary tests passed');

const state={segments:[{id:'w',sha256:'sha'}],anchor:{broadcast:{pts:1},wideGlobalPts:10},record:{breaks:[{broadcast:{pts:2}}],extraAnchors:[]}};
assert.ok(activeSequenceAnchor(state,2.5).error);
state.record.extraAnchors.push({id:'F60',broadcast:{pts:2},wideGlobalPts:14,wideSourceId:'w',wideSha256:'sha'});
assert.equal(activeSequenceAnchor(state,2.5).anchor.id,'F60');
assert.equal(activeSequenceAnchor(state,1.5).anchor.id,'start');
state.segments=[];assert.ok(activeSequenceAnchor(state,2.5).error);
