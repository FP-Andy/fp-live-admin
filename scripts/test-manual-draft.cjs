const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../apps/web/node_modules/typescript');
const mod = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('apps/web/lib/manual-draft.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
Function('exports', 'module', code)(mod.exports, mod);
const { parseManualWork, storeManualWork } = mod.exports;
const allowed = ['home_goal', 'section'];
const original = { tags: [{ id: 'tag-one', t: 25, before: 3, after: 4, kind: 'home_goal' }], padBefore: 10, padAfter: 3,
  scoreboard: { homeName: '홈', startHome: 1, logoUrl: 'data:image/png;base64,synthetic' },
  cards: { values: { cup: { title: '대회', logo: 'data:image/png;base64,synthetic' } }, boxes: { cup: { title: { x: 3, y: 5, scale: 80 } } }, colors: { cup: '#ffffff' } },
  watermark: { enabled: true, opacity: .6 } };
assert.deepEqual(parseManualWork(JSON.stringify(original), allowed), original);
assert.equal(parseManualWork(JSON.stringify(original.tags), allowed).padAfter, 2);
assert.equal(parseManualWork(JSON.stringify({ tags: [], scoreboard: { homeName: '빈 태그 설정' } }), allowed).scoreboard.homeName, '빈 태그 설정');
for (const mutate of [
  work => work.tags.push({ ...work.tags[0] }),
  work => work.tags[0].t = -1,
  work => work.tags[0].kind = 'bb_home_3',
  work => work.padBefore = 'ten',
  work => work.scoreboard.startHome = {},
  work => work.cards.values.cup.title = 42,
  work => work.cards.boxes.cup.title.x = 'invalid',
]) { const bad = structuredClone(original); mutate(bad); assert.throws(() => parseManualWork(JSON.stringify(bad), allowed)); }
let calls = 0, saved;
assert.equal(storeManualWork({ setItem(key, value) { saved = JSON.parse(value); } }, 'draft', original), 'saved');
assert.deepEqual(saved, original);
assert.equal(storeManualWork({ setItem(key, value) { calls++; if (calls === 1) throw Error('quota'); saved = JSON.parse(value); } }, 'draft', original), 'partial');
assert.equal(saved.scoreboard.logoUrl, ''); assert.equal(saved.cards.values.cup.logo, '');
assert.equal(saved.cards.values.cup.title, '대회'); assert.deepEqual(saved.cards.boxes, original.cards.boxes);
assert.equal(original.scoreboard.logoUrl, 'data:image/png;base64,synthetic');
assert.equal(storeManualWork({ setItem() { throw Error('quota'); } }, 'draft', original), 'failed');
console.log('PASS: legacy/current/empty drafts, invalid imports, exact full save, partial image omission, persistent failure and unchanged in-memory original');
