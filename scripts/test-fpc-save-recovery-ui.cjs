/* Original UI, fixture-only API responses, synthetic video, isolated browser. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { chromium } = require('../apps/web/node_modules/playwright-core');
const origin = process.env.FPC_QA_ORIGIN || 'http://127.0.0.1:4354';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const output = process.env.FPC_QA_OUTPUT || '/tmp/fpc-save-recovery-qa';
fs.mkdirSync(output, { recursive: true });
const mediaFile = output + '/synthetic.mp4';
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=8',
  '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile]);
const matchId = '11111111-1111-4111-8111-111111111111';
const cases = [], errors = [], unexpected = [];
let mode = 'fail', deleteFailure = false;
const requests = [], rows = new Map();
const report = name => { cases.push(name); console.log('PASS:', name); };
let browser, phase = 'start';

async function context(sport, quota = 'none', seeded = null) {
  const c = await browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 768 }, serviceWorkers: 'block' });
  await c.addCookies([{ name: 'live_admin_session', value: 'fixture-only-session', url: origin }]);
  await c.addInitScript(({ sport, quota, seeded }) => {
    localStorage.setItem('fineplay.selectedSport', sport);
    if (seeded && !sessionStorage.getItem('qa-seeded')) {
      for (const [key, value] of Object.entries(seeded)) localStorage.setItem(key, JSON.stringify(value));
      sessionStorage.setItem('qa-seeded', '1');
    }
    window.__quotaMode = quota;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('fhl.manual.tags.') && (window.__quotaMode === 'all'
        || (window.__quotaMode === 'images' && value.includes('data:image/')))) {
        throw new DOMException('Synthetic quota exceeded', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  }, { sport, quota, seeded });
  await c.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname, method = route.request().method();
    const respond = data => route.fulfill({ json: data });
    if (path === '/api/session/me') return respond({ id: 'fixture-admin', name: '검증 관리자', role: 'SUPERADMIN' });
    if (path === '/api/highlight/card-templates') return respond({ templates: [], default: 'fineplay' });
    if (path === '/api/highlight/card-preview') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#ddd"/></svg>' });
    if (path.startsWith('/api/recordings/') && method === 'GET') return respond({ recordings: [], receiver_ready: false });
    if (path === '/api/outbox') return respond([]);
    if (path === `/api/matches/${matchId}`) return respond({ id: matchId, name: '[K3 | 1R] 합성 홈 vs 합성 원정', sport: 'FOOTBALL', archived: false,
      competition_class: 'K3', first_half_minutes: 45, second_half_minutes: 45, operator_id: null, metadata: { stream_mode: 'MANUAL', home_team: '합성 홈', away_team: '합성 원정' } });
    if (path === `/api/matches/${matchId}/summary`) return respond({ state: { clock_ms: 123456, running: false, possession_team: 'NONE', selected_team: 'HOME', attack_lr: 'L2R' },
      events: [], markers: [], possession: { home_pct: 0, away_pct: 0 }, lanes: { home: { total_count: 0, left_pct: 0, center_pct: 0, right_pct: 0 }, away: { total_count: 0, left_pct: 0, center_pct: 0, right_pct: 0 } } });
    if (path === `/api/matches/${matchId}/dominance`) return respond({ bins: [], split_halves: true });
    if (path === `/api/matches/${matchId}/highlights`) {
      if (method === 'GET') return respond({ highlights: [...rows.values()] });
      const body = route.request().postDataJSON(); requests.push(body);
      if (mode === 'fail') return route.fulfill({ status: 503, json: { detail: 'Synthetic failure' } });
      if (!rows.has(body.request_id)) rows.set(body.request_id, { id: body.request_id, clock_ms: body.clock_ms });
      if (mode === 'lost') return route.abort('failed');
      return respond({ ok: true, highlight: rows.get(body.request_id) });
    }
    if (path.startsWith(`/api/matches/${matchId}/highlights/`) && method === 'DELETE') {
      if (deleteFailure) return route.fulfill({ status: 403, json: { detail: 'Synthetic rejection' } });
      rows.delete(path.split('/').pop()); return respond({ ok: true });
    }
    unexpected.push({ path, method });
    return route.fulfill({ status: 404, json: { detail: 'No fixture for this request' } });
  });
  return c;
}
async function pageIn(c, path) {
  const page = await c.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + path);
  return page;
}
async function loadVideo(page) {
  await page.locator('input[type=file]').first().setInputFiles(mediaFile);
  await page.getByRole('button', { name: /＋ 태깅/ }).waitFor();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
}
async function exportDraft(page, name) {
  const done = page.waitForEvent('download');
  await page.getByRole('button', { name: '작업 복구 파일 저장', exact: true }).click();
  const download = await done; await download.saveAs(output + '/' + name);
  return JSON.parse(fs.readFileSync(output + '/' + name, 'utf8'));
}
async function tagKey(page, code, key, time) {
  await page.locator('video').evaluate((video, time) => { video.currentTime = time; }, time);
  await page.evaluate(({ code, key }) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true })), { code, key });
}

(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()), headless: true });
  try {
    phase = 'highlight HTTP failure and persisted retry';
    const c = await context('FOOTBALL');
    const page = await pageIn(c, `/admin/match/${matchId}`);
    await page.getByRole('button', { name: '⭐ 지금 하이라이트', exact: true }).click();
    await page.getByText('저장을 확인하지 못했습니다.', { exact: false }).waitFor();
    assert.equal(rows.size, 0);
    assert.equal(await page.getByText('하이라이트를 서버에 저장했습니다.', { exact: true }).count(), 0);
    const original = requests[0]; assert(original.request_id && original.clock_ms >= 0);
    await page.reload();
    await page.getByRole('button', { name: '같은 시각으로 다시 요청', exact: true }).waitFor();
    mode = 'lost';
    await page.getByRole('button', { name: '같은 시각으로 다시 요청', exact: true }).click();
    await page.getByText('저장을 확인하지 못했습니다.', { exact: false }).waitFor();
    assert.equal(rows.size, 1);
    mode = 'ok';
    await page.getByRole('button', { name: '같은 시각으로 다시 요청', exact: true }).click();
    await page.getByText('하이라이트를 서버에 저장했습니다.', { exact: true }).waitFor();
    assert.equal(rows.size, 1); assert.deepEqual(requests[1], original); assert.deepEqual(requests[2], original);
    assert.equal(await page.getByRole('button', { name: '같은 시각으로 다시 요청', exact: true }).count(), 0);
    report('503 and lost response: retained original timestamp/ID, reload and retry without duplicate');
    await page.getByRole('button', { name: '⭐ 지금 하이라이트', exact: true }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('저장 미확인'));
    assert.equal(rows.size, 2); assert.notEqual(requests[3].request_id, original.request_id);
    deleteFailure = true;
    await page.getByRole('button', { name: '지우기', exact: true }).first().click();
    await page.getByText('삭제를 확인하지 못했습니다.', { exact: false }).waitFor();
    assert.equal(rows.size, 2);
    report('Separate click has a new ID; rejected deletion never displays success');
    await page.screenshot({ path: output + '/highlight-recovery.png', fullPage: true });
    await c.close();

    phase = 'quota warning and basketball shortcuts';
    const q = await context('BASKETBALL', 'all');
    const manual = await pageIn(q, '/admin/highlight/manual');
    await loadVideo(manual);
    await manual.getByText('일반 장면은', { exact: false }).waitFor();
    assert.match(await manual.getByText('아직 태그가 없습니다.', { exact: false }).innerText(), /X.*S 원정 2점/);
    await tagKey(manual, 'KeyX', 'x', 1);
    await tagKey(manual, 'KeyX', 'ㅌ', 2);
    await tagKey(manual, 'KeyS', 'ㄴ', 3);
    await manual.getByText('태그 3개', { exact: true }).waitFor();
    await manual.getByText('브라우저에 저장하지 못함', { exact: true }).waitFor();
    const exported = await exportDraft(manual, 'quota-recovery.json');
    assert.equal(exported.work.tags.length, 3);
    assert.equal(exported.work.tags[0].kind, undefined); assert.equal(exported.work.tags[1].kind, undefined);
    assert.equal(exported.work.tags[2].kind, 'bb_away_2');
    assert(exported.work.scoreboard && exported.work.cards && exported.work.watermark);
    await manual.screenshot({ path: output + '/manual-storage-failure.png', fullPage: true });
    const dialog = manual.waitForEvent('dialog');
    const click = manual.locator('a[href="/admin/highlight/results"]').first().click();
    await (await dialog).dismiss(); await click;
    assert(new URL(manual.url()).pathname === '/admin/highlight/manual');
    report('Repeated quota errors stay visible; basketball X/ㅌ are unscored and S/ㄴ is away two points; export and navigation warning');
    await manual.evaluate(() => { window.__quotaMode = 'none'; });
    await manual.getByRole('button', { name: '브라우저 저장 다시 시도', exact: true }).click();
    await manual.getByText('이 브라우저에 저장됨', { exact: true }).waitFor();
    await manual.reload(); await loadVideo(manual);
    await manual.getByText('태그 3개', { exact: true }).waitFor();
    assert.deepEqual((await exportDraft(manual, 'restored.json')).work, exported.work);
    report('Storage recovery saves latest revision; reload restores all fields without an empty overwrite');
    await q.close();

    phase = 'restore JSON and partial image fallback';
    exported.work.padBefore = 7; exported.work.padAfter = 4;
    exported.work.tags[0].before = 2; exported.work.tags[1].label = '복구 메모';
    exported.work.scoreboard.homeName = '복구 홈'; exported.work.scoreboard.startAway = 12;
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2eQAAAAASUVORK5CYII=';
    exported.work.scoreboard.logoUrl = image;
    exported.work.cards.values = { fineplay: { title: '복구 카드', logo: image } };
    exported.work.cards.boxes = { fineplay: { title: { x: 15, y: 20, scale: 95 } } };
    exported.work.cards.colors = { fineplay: '#123456' };
    exported.work.watermark.opacity = .4;
    const r = await context('BASKETBALL', 'images');
    const restored = await pageIn(r, '/admin/highlight/manual');
    await loadVideo(restored);
    await restored.getByLabel('수동 태깅 복구 파일').setInputFiles({ name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await restored.getByText('그림을 제외하고 저장됨', { exact: true }).waitFor();
    assert.deepEqual((await exportDraft(restored, 'with-images.json')).work, exported.work);
    const saved = await restored.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('fhl.manual.tags.')))));
    assert.equal(saved.scoreboard.logoUrl, ''); assert.equal(saved.cards.values.fineplay.logo, '');
    assert.equal(saved.cards.values.fineplay.title, '복구 카드');
    report('JSON roundtrip preserves tags/padding/scoreboard/card placements/images/watermark; partial autosave is explicitly labeled');
    const wrong = { ...exported, sport: 'FOOTBALL' };
    await restored.getByLabel('수동 태깅 복구 파일').setInputFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(wrong)) });
    await restored.getByText('종목과 원본 영상의 이름·크기·순서가 같은 복구 파일을 선택하세요.', { exact: true }).waitFor();
    assert.deepEqual((await exportDraft(restored, 'unchanged.json')).work, exported.work);
    report('Wrong-sport recovery file is rejected without changing existing work');
    await r.close();

    phase = 'football shortcuts';
    const f = await context('FOOTBALL');
    const football = await pageIn(f, '/admin/highlight/manual');
    await loadVideo(football);
    assert.match(await football.getByText('아직 태그가 없습니다.', { exact: false }).innerText(), /S.*Q 홈 골.*R 원정 골/);
    await tagKey(football, 'KeyS', 'ㄴ', 1);
    await tagKey(football, 'KeyQ', 'q', 2);
    const footballWork = (await exportDraft(football, 'football.json')).work;
    assert.equal(footballWork.tags[0].kind, undefined); assert.equal(footballWork.tags[1].kind, 'home_goal');
    report('Football help and Korean/English shortcuts keep existing meanings');
    await f.close();
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } catch (error) {
    console.error(phase, error); process.exitCode = 1;
    fs.writeFileSync(output + '/failure.txt', phase + '\n' + error.stack);
  } finally {
    fs.writeFileSync(output + '/results.json', JSON.stringify({ passed: !process.exitCode, phase, cases, errors, unexpected }, null, 2));
    await browser?.close();
  }
})();
