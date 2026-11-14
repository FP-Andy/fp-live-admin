import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const root=resolve('apps/web/public/kbl-grayzone');
test('published Courtside module imports are present',()=>{
 for (const entry of readdirSync(root,{withFileTypes:true})) {
  if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
  const file=resolve(root,entry.name);
  for (const match of readFileSync(file,'utf8').matchAll(/(?:from\s*|import\s*\()["'](\.[^"']+)["']/g)) {
   assert.ok(existsSync(resolve(dirname(file),match[1])),`${entry.name} imports missing ${match[1]}`);
  }
 }
});
test('published Courtside package excludes local game data and legacy defaults',()=>{
 for (const forbidden of ['frames','posters','review-survey','assets/poses','data','index.html','case.html','case.mjs'])
  assert.equal(existsSync(resolve(root,forbidden)),false,`${forbidden} must stay private`);
 for (const name of ['pose-review.mjs','reconstruction.mjs','report-review.mjs','workflow.mjs'])
  assert.doesNotMatch(readFileSync(resolve(root,name),'utf8'),/game034/);
});
