const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ts = require('../apps/web/node_modules/typescript');
const cache = new Map();
function load(file) {
  file = path.resolve(file); if (cache.has(file)) return cache.get(file);
  const m = { exports: {} }; cache.set(file, m.exports);
  const compiled = ts.transpile(fs.readFileSync(file, 'utf8'), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 });
  Function('exports', 'require', 'module', compiled)(m.exports, id => id.startsWith('.') ? load(path.resolve(path.dirname(file), id) + (path.extname(id) ? '' : '.ts')) : require(id), m);
  return m.exports;
}
const { createReportPersistence } = load('apps/web/lib/report-persistence.ts');
const r = load('apps/web/lib/futsal-report.ts');
const { applySubstitutionReport, preserveAndApplySubstitutions } = load('apps/web/lib/futsal-report-substitutions.ts');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const values = new Map(), storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
const base = { id: 'r1', title: 'first', updatedAt: '2026-01-01T00:00:00.000Z' };
const passed = name => console.log('PASS:', name);
(async () => {
  const writes = [], gates = [];
  const queue = createReportPersistence(async value => { writes.push(value); const gate = deferred(); gates.push(gate); await gate.promise; }, () => storage, 'test.', 60000);
  queue.stage(base); const saving = queue.flush(base.id);
  queue.stage({ ...base, title: 'latest edit while saving' });
  gates[0].resolve(); await tick();
  assert.equal(queue.state(base.id).dirty, true); assert.equal(writes.length, 2);
  assert.equal(JSON.parse(values.get('test.r1')).title, 'latest edit while saving');
  gates[1].resolve(); await saving;
  assert.equal(queue.state(base.id).dirty, false); assert.equal(values.has('test.r1'), false);
  passed('Old acknowledgement cannot mark newer input saved; writes are serialized');

  let fail = true, persisted;
  const failing = createReportPersistence(async value => { if (fail) throw Error('IDB unavailable'); persisted = value; }, () => storage, 'retry.', 60000);
  failing.stage({ ...base, title: 'recover me' });
  await assert.rejects(failing.flush(base.id)); assert.equal(failing.state(base.id).dirty, true);
  const reloaded = createReportPersistence(async () => {}, () => storage, 'retry.');
  assert.equal(reloaded.recover(base.id, base).title, 'recover me');
  fail = false; await failing.flush(base.id); assert.equal(persisted.title, 'recover me');
  storage.setItem('retry.r1', JSON.stringify(base)); assert.equal(reloaded.recover(base.id, persisted), persisted);
  passed('Failed IDB writes retain reload recovery; retry clears it and older journals never win');

  const quota = createReportPersistence(async () => { throw Error('IDB full'); }, () => { throw Error('storage full'); }, 'full.', 60000);
  quota.stage(base); assert.match(quota.state(base.id).message, /복구 공간 부족/);
  await assert.rejects(quota.flush(base.id)); assert.equal(quota.recover(base.id, undefined).title, base.title);
  passed('Dual storage failure remains unsaved and retains the in-memory draft');

  const large = { ...base, source: { toJSON() { throw Error('Coordinates must not be serialized on a prose edit'); } }, optional: 'old' };
  const deltaWrites = [], deltaGates = [];
  const delta = createReportPersistence(async record => { deltaWrites.push(record); const gate = deferred(); deltaGates.push(gate); await gate.promise; }, () => storage, 'delta.', 60000);
  delta.recover(base.id, large);
  delta.stage({ ...large, title: 'temporary title' }); const deltaSaving = delta.flush(base.id);
  delta.stage({ ...large, optional: undefined });
  const journal = JSON.parse(values.get('delta.r1'));
  assert.equal(journal.schema, 'fpc-report-journal/v1'); assert.equal(journal.changes.source, undefined); assert(values.get('delta.r1').length < 1000);
  deltaGates[0].resolve(); await tick();
  const afterReload = createReportPersistence(async () => {}, () => storage, 'delta.');
  const recovered = afterReload.recover(base.id, deltaWrites[0]);
  assert.equal(recovered.title, base.title); assert.equal('optional' in recovered, false); assert.equal(recovered.source, large.source);
  deltaGates[1].resolve(); await deltaSaving;
  passed('Compact edit journal skips unchanged coordinates and preserves reverted/deleted fields over an intermediate commit');

  const heat = { schema: 'fpa-heatmaps/v1', datasetId: 'one', video: 'synthetic', from: 0, to: 100, width: 1, height: 1, scale: 1,
    players: [{ id: 'home-1', group: 'home', jersey: '1', grid: [1], coverage: .01, observed: 1, positions: [{ t: 1, x: .5, y: .5, seconds: 1 }] }] };
  let draft = r.attachHeatmap(r.emptyDraft(), heat);
  draft.matchId = 'match-1'; draft.sourceSnapshot = { id: 'a'.repeat(32), version: 1, jobId: 'job-1', createdAt: base.updatedAt };
  draft.players['home-1'] = { ...draft.players['home-1'], name: '작성한 이름', jersey: '77', heatComment: '직접 쓴 코멘트', eventComment: '장면 설명', flaNumber: '12' };
  const result = { provenance: { algorithm: 'substitution-report/v1', snapshotId: draft.sourceSnapshot.id, jobId: 'job-1', matchId: 'match-1', logRevision: 1 }, status: 'ready', events: [],
    heatmap: { ...heat, players: [{ ...heat.players[0], activeFrom: 0, activeTo: 50, substitutionStint: { kind: 'starter', sourceId: 'home-1', from: 0, to: 50 } }] } };
  const derived = applySubstitutionReport(draft, result);
  assert.deepEqual(derived.players['home-1'], draft.players['home-1']);
  const entrant = { ...heat.players[0], id: 'sub-event-1', activeFrom: 50, activeTo: 100, substitutionStint: { kind: 'substitute', sourceId: null, entryTrackId: 22, eventId: 'event-1', from: 50, to: 100 } };
  const withSub = { ...derived, heatmap: { ...heat, players: [...derived.heatmap.players, entrant] }, players: { ...derived.players, [entrant.id]: { ...r.blankPlayer(entrant), heatComment: '투입 선수 메모' } } };
  const adjusted = { ...result, heatmap: { ...heat, players: [result.heatmap.players[0], { ...entrant, activeFrom: 51 }] } };
  assert.equal(applySubstitutionReport(withSub, adjusted).players[entrant.id].heatComment, '투입 선수 메모');
  adjusted.heatmap.players[1] = { ...entrant, substitutionStint: { ...entrant.substitutionStint, entryTrackId: 33 } };
  assert.equal(applySubstitutionReport(withSub, adjusted).players[entrant.id].heatComment, '');
  passed('Time boundary edits preserve the same player; a changed incoming track does not inherit prose');

  let latest = withSub, applied, backups = [], first = deferred();
  const removed = { ...result, provenance: { ...result.provenance, logRevision: 2 }, heatmap: heat, events: [] };
  const applying = preserveAndApplySubstitutions(() => latest, d => { applied = d; }, async copy => { backups.push(copy); if (backups.length === 1) await first.promise; }, removed);
  latest = { ...latest, players: { ...latest.players, [entrant.id]: { ...latest.players[entrant.id], heatComment: '백업을 기다리며 쓴 최신 내용' } } };
  first.resolve(); await applying;
  assert.equal(backups.length, 2); assert.equal(backups[0].id, backups[1].id);
  assert.equal(backups[1].players[entrant.id].heatComment, '백업을 기다리며 쓴 최신 내용');
  assert.equal(applied.players[entrant.id], undefined); assert.equal(applied.players['home-1'].heatComment, '직접 쓴 코멘트');
  passed('Removing the final substitution backs up the latest text, including edits during backup');

  applied = undefined;
  await assert.rejects(preserveAndApplySubstitutions(() => latest, d => { applied = d; }, async () => { throw Error('quota'); }, removed));
  assert.equal(applied, undefined);
  const gate = deferred();
  const switching = preserveAndApplySubstitutions(() => latest, d => { applied = d; }, async () => gate.promise, removed);
  latest = { ...latest, id: 'different-report' }; gate.resolve(); await switching; assert.equal(applied, undefined);
  passed('Failed backup or switching report prevents applying the pending calculation');
})().catch(error => { console.error(error); process.exitCode = 1; });
