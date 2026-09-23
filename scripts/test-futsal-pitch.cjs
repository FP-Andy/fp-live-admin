const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('../apps/web/node_modules/typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../apps/web/lib/futsal-pitch.ts'), 'utf8');
const output = { exports: {} };
Function('exports', ts.transpile(source, {module: ts.ModuleKind.CommonJS}))(output.exports);
const {futsalPitchPoint: point, futsalPitchMarker: marker} = output.exports;
assert.deepEqual(point(.5, 2/24), {x:20,y:10}); // Goal line center.
assert.deepEqual(point(.5, 8/24), {x:14,y:10}); // Six metres from goal.
assert.deepEqual(point(.5, 12/24), {x:10,y:10});
assert.deepEqual(point(.5, 22/24), {x:0,y:10}); // Halfway line.
assert.equal(point(.5, 0), null);
assert.equal(point(0, .5), null);
assert.equal(point(1, .5), null);
assert.equal(point(.5, 1), null);
for (const p of [{x:14,y:10},{x:20,y:0},{x:0,y:20},{x:7.23,y:4.56}]) {
  const pos = marker(p);
  assert.deepEqual(point(parseFloat(pos.left)/100,parseFloat(pos.top)/100),p);
}
console.log('Futsal goal/penalty/halfway coordinates, surround exclusion and marker round-trips passed');
