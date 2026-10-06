/* Real report page and IndexedDB, synthetic data, localhost APIs only. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { chromium } = require('../apps/web/node_modules/playwright-core');
const origin = process.env.FPC_QA_ORIGIN || 'http://127.0.0.1:4354';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const output = process.env.FPC_REPORT_QA_OUTPUT || '/tmp/fpc-report-recovery-qa';
fs.mkdirSync(output, { recursive: true });
const path = '/admin/fcm/futsal/reports', snapshotId = 'a'.repeat(32);
const cases = [], errors = [], unexpected = [];
const passed = name => { cases.push(name); console.log('PASS:', name); };
const heat = { schema: 'fpa-heatmaps/v1', datasetId: 'synthetic', video: 'fixture.mp4', from: 0, to: 10, width: 1, height: 1, scale: 1,
  players: [{ id: 'home-1', group: 'home', jersey: '1', grid: [1], coverage: .1, observed: 1, positions: [{ t: 1, x: .5, y: .5, seconds: 1 }] }] };
const snapshot = { id: snapshotId, title: '늦게 도착할 A', version: 1, createdAt: '2026-01-01T00:00:00.000Z', jobId: 'fixture-job', matchId: null,
  matchName: '', homeName: '', awayName: '', heatmap: heat, fpa: { rows: [], logs: [] }, roster: [], meanCoverage: .1, eventCount: 0 };
let snapshotGate = null, snapshotStarted = null, snapshotFails = false, browser, page;
async function stored(page, id) { return page.evaluate(async id => (await import('/fpa-cv/report-store.mjs')).loadReport(id), id); }
async function savedComment(page, id, text) {
  await page.waitForFunction(async ({ id, text }) => { const d = await (await import('/fpa-cv/report-store.mjs')).loadReport(id); return d?.players[d.selected]?.heatComment === text; }, { id, text });
}
async function navigate(page) {
  await page.evaluate(() => document.querySelector('a[href="/admin/futsal/fla/video"]').click());
  await page.waitForURL('**/admin/futsal/fla/video');
}
async function showNavigation(page) {
  if (!await page.locator('a[href="/admin/futsal/fla/video"]').count()) await page.getByRole('button', { name: /FLA.*Live Analytics/ }).click();
}
(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()), headless: true });
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', viewport: { width: 1366, height: 768 } });
  await context.addCookies([{ name: 'live_admin_session', value: 'fixture-session', url: origin }]);
  await context.addInitScript(() => {
    localStorage.setItem('fineplay.selectedSport', 'FUTSAL');
    window.__failReportWrites = sessionStorage.getItem('qa-fail-report-writes') === 'yes';
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'reports' && window.__failReportWrites) throw new DOMException('Synthetic IDB quota', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/session/me') return route.fulfill({ json: { id: 'report-fixture-user', name: '검증 관리자', role: 'SUPERADMIN' } });
    if (url.pathname === '/api/futsal/fla-video/fixtures') return route.fulfill({ json: { fixtures: [] } });
    if (url.pathname === '/api/futsal/analysis-snapshots') return route.fulfill({ json: { snapshots: [snapshot] } });
    if (url.pathname === '/api/futsal/analysis-snapshots/' + snapshotId) {
      snapshotStarted?.(); if (snapshotGate) await snapshotGate;
      return route.fulfill(snapshotFails ? { status: 503, json: { detail: 'Old A request failed' } } : { json: snapshot });
    }
    if (url.pathname === '/api/outbox') return route.fulfill({ json: [] });
    unexpected.push(url.pathname); return route.fulfill({ status: 404, json: { detail: 'Missing test fixture' } });
  });
  try {
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin + path);
    const comment = () => page.getByLabel('히트맵 코멘트', { exact: true });
    await comment().waitFor();
    await showNavigation(page);
    const reportURL = page.url(), reportId = new URL(reportURL).searchParams.get('report');
    await comment().fill('저장된 이전 문장'); await savedComment(page, reportId, '저장된 이전 문장');
    await comment().fill('메뉴 이동 직전의 최신 문장'); await navigate(page);
    assert.equal((await stored(page, reportId)).players.manual.heatComment, '메뉴 이동 직전의 최신 문장');
    await page.goBack(); await comment().waitFor();
    assert.equal(await comment().inputValue(), '메뉴 이동 직전의 최신 문장');
    passed('Immediate sidebar navigation saves and restores the latest comment');
    await comment().fill('브라우저 앞으로 이동 직전 문장'); await page.goForward();
    await page.waitForURL('**/admin/futsal/fla/video'); await page.goBack(); await comment().waitFor();
    assert.equal(await comment().inputValue(), '브라우저 앞으로 이동 직전 문장');
    await savedComment(page, reportId, '브라우저 앞으로 이동 직전 문장');
    passed('Browser forward/back preserves the latest input across component unmount');

    await showNavigation(page);
    await page.evaluate(() => { window.__failReportWrites = true; sessionStorage.setItem('qa-fail-report-writes', 'yes'); });
    await comment().fill('실패해도 유지할 입력');
    await page.getByRole('button', { name: '지금 저장', exact: true }).click();
    await page.getByLabel('리포트 저장 상태').filter({ hasText: '저장 실패' }).waitFor();
    await page.evaluate(() => document.querySelector('a[href="/admin/futsal/fla/video"]').click());
    await page.getByText('이동 전에 저장하지 못했습니다.', { exact: false }).waitFor();
    assert.equal(page.url(), reportURL); assert.equal(await comment().inputValue(), '실패해도 유지할 입력');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '리포트 JSON 저장', exact: true }).click();
    const download = await downloadEvent; await download.saveAs(output + '/failed-save-recovery.json');
    assert.equal(JSON.parse(fs.readFileSync(output + '/failed-save-recovery.json')).players.manual.heatComment, '실패해도 유지할 입력');
    assert.equal((await stored(page, reportId)).players.manual.heatComment, '브라우저 앞으로 이동 직전 문장');
    passed('IDB quota blocks internal navigation, keeps the draft and exports its latest text');

    await page.reload(); await comment().waitFor();
    assert.equal(await comment().inputValue(), '실패해도 유지할 입력');
    await page.getByText('이 탭에 남아 있던 최신 입력을 복구했습니다.', { exact: false }).waitFor();
    await page.evaluate(() => { window.__failReportWrites = false; sessionStorage.removeItem('qa-fail-report-writes'); });
    await page.getByRole('button', { name: '지금 저장', exact: true }).click();
    await savedComment(page, reportId, '실패해도 유지할 입력');
    await page.getByLabel('리포트 저장 상태').filter({ hasText: '이 브라우저에 저장됨' }).waitFor();
    assert.equal(await page.evaluate(id => sessionStorage.getItem('fpc.report-recovery.v1.report-fixture-user.' + id), reportId), null);
    passed('Reload after failed IDB restores the tab journal; retry saves and clears it');

    // A real snapshot fetch is held while the user selects an existing IDB report.
    await page.evaluate(async id => { const store = await import('/fpa-cv/report-store.mjs'); const original = await store.loadReport(id); await store.saveReport({ ...original, id: 'fixture-report-b', title: '최종 선택 B' }); }, reportId);
    await page.reload(); await comment().waitFor();
    for (const fails of [false, true]) {
      let release; snapshotFails = fails;
      snapshotGate = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { snapshotStarted = resolve; });
      await page.getByLabel('완료된 분석 스냅샷', { exact: true }).selectOption(snapshotId);
      await page.getByRole('button', { name: '히트맵·이벤트맵 함께 불러오기', exact: true }).click();
      await requested;
      await page.getByLabel('저장된 작업', { exact: true }).selectOption('fixture-report-b');
      await page.waitForFunction(() => document.querySelector('input[aria-label="작업 이름"]')?.value === '최종 선택 B');
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/futsal/analysis-snapshots/' + snapshotId);
      release(); await response; await page.waitForTimeout(100);
      assert.equal(await page.getByLabel('작업 이름', { exact: true }).inputValue(), '최종 선택 B');
      assert.equal(new URL(page.url()).searchParams.get('report'), 'fixture-report-b');
      assert.equal(await page.getByText('Old A request failed', { exact: false }).count(), 0);
      snapshotGate = null;
    }
    passed('Late snapshot success and failure cannot replace a newer report selection');
    snapshotFails = false;
    await page.getByLabel('완료된 분석 스냅샷', { exact: true }).selectOption(snapshotId);
    await page.getByRole('button', { name: '히트맵·이벤트맵 함께 불러오기', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="작업 이름"]')?.value === '늦게 도착할 A · 확정 v1');
    assert.notEqual(new URL(page.url()).searchParams.get('report'), 'fixture-report-b');
    passed('An uncontested snapshot selection still opens normally');
    await page.getByRole('button', { name: '지금 저장', exact: true }).click();
    await page.screenshot({ path: output + '/report-save-status.png', fullPage: false });
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } catch (error) {
    if (page) { await page.screenshot({ path: output + '/failure.png', fullPage: true }); fs.writeFileSync(output + '/failure.txt', await page.locator('body').innerText()); }
    throw error;
  } finally {
    fs.writeFileSync(output + '/results.json', JSON.stringify({ cases, errors, unexpected }, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
