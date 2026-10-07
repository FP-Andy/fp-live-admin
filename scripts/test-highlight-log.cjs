const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../apps/web/node_modules/typescript');
function load(file, deps = {}) {
  const mod = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  Function('exports', 'module', 'require', js)(mod.exports, mod, name => {
    if (!(name in deps)) throw Error('Unexpected dependency ' + name);
    return deps[name];
  });
  return mod.exports;
}
const drafts = load('apps/web/lib/manual-draft.ts');
const logs = load('apps/web/lib/highlight-log.ts', { './manual-draft': drafts });
(async () => {
  const sources = [{ file: new File(['synthetic-one'], 'first.mp4'), duration: 30 },
    { file: new File(['synthetic-two'], 'second.mp4'), duration: 20 }];
  const allowed = ['home_goal', 'away_goal_only', 'substitution', 'section'];
  const work = { tags: [{ id: 'goal', t: 12, kind: 'home_goal', before: 3, after: 4 },
    { id: 'score', t: 20, kind: 'away_goal_only' }, { id: 'section', t: 30, kind: 'section', label: '후반전' },
    { id: 'sub', t: 35, kind: 'substitution', before: 4, after: 2 }], padBefore: 10, padAfter: 3,
    clipTransition: false, introDuration: 2.5, musicVolume: 45, originalVolume: 75,
    scoreboard: { enabled: true, startHome: 2, startAway: 1, homeName: '홈', template: 'queencup', posPxX: 87 },
    watermark: { enabled: true, opacity: .4 }, cards: { enabled: false } };
  const intro = new File([new Uint8Array([0,1,128,255])], 'intro.png', { type:'image/png' });
  const music = new File(['synthetic music'], 'music.mp3', { type:'audio/mpeg' });
  const log = await logs.createHighlightLog('FOOTBALL', sources, work, { intro, music });
  const raw = await logs.logBlob(log).text();
  const restored = await logs.readHighlightLog(raw, 'FOOTBALL', sources, allowed);
  assert.deepEqual(restored.work, work);
  assert.deepEqual(await restored.intro.arrayBuffer(), await intro.arrayBuffer());
  assert.deepEqual(await restored.music.arrayBuffer(), await music.arrayBuffer());
  assert.deepEqual(work.tags[3], log.work.tags[3]);
  // Same bytes renamed or copied remain valid; timing is bound to order/content.
  await logs.readHighlightLog(raw, 'FOOTBALL', sources.map(s => ({ ...s, file:new File([s.file],'copy-'+s.file.name) })), allowed);
  await assert.rejects(logs.readHighlightLog(raw,'BASKETBALL',sources,allowed));
  await assert.rejects(logs.readHighlightLog(raw,'FOOTBALL',[...sources].reverse(),allowed));
  const wrong = sources.map(s => ({ ...s, file:new File(['different-one'],s.file.name) }));
  await assert.rejects(logs.readHighlightLog(raw,'FOOTBALL',wrong,allowed));
  for (const change of [
    l => l.work.tags[0].t = 999, l => l.work.tags[3].kind = 'unknown',
    l => l.work.musicVolume = -1, l => l.attachments.music.size++,
    l => l.sources[0].duration = '30', l => l.version = 9,
  ]) { const bad = structuredClone(log); change(bad); await assert.rejects(logs.readHighlightLog(JSON.stringify(bad),'FOOTBALL',sources,allowed)); }
  const legacy = { format:'fpc-manual-draft',version:1,sport:'FOOTBALL',
    sources:sources.map(s => ({ name:s.file.name,size:s.file.size })),work };
  assert.deepEqual((await logs.readHighlightLog(JSON.stringify(legacy),'FOOTBALL',sources,allowed)).work,work);
  console.log('PASS: exact log round-trip, substitution/score-only/sections, settings and attachment bytes, renamed source, wrong source/order/sport rejection, malformed logs, legacy recovery');
})().catch(error => { console.error(error); process.exit(1); });
