/* Real football/futsal controls with delayed, revision-checked fixture writes. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { chromium } = require('../apps/web/node_modules/playwright-core');
const origin = process.env.FPC_QA_ORIGIN || 'http://127.0.0.1:4354';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const output = process.env.FPC_CLOCK_QA_OUTPUT || '/tmp/fpc-possession-clock-qa';
fs.mkdirSync(output, { recursive: true });
const id = '11111111-1111-4111-8111-111111111111';
const result = { passed: false, cases: [], failures: [], errors: [] };
let browser;
async function run(sport, scenario) {
  let state = { clock_ms: 10000, running: scenario !== 'queued-start', possession_team: 'NONE', selected_team: 'HOME', attack_lr: 'L2R' };
  let revision = 0, delay = scenario === 'queued-start' ? 450 : 1400;
  const requests = [], events = [], totals = { HOME: 0, AWAY: 0 };
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'live_admin_session', value: 'fixture-only', url: origin }]);
  await context.addInitScript(sport => { localStorage.setItem('fineplay.selectedSport', sport); sessionStorage.setItem('fpc.sidebar.open', 'false'); }, sport);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (url.origin !== origin) return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    const respond = json => route.fulfill({ json });
    if (path === '/api/session/me') return respond({ id: 'fixture-admin', name: '검증 관리자', role: 'SUPERADMIN' });
    if (path === '/api/outbox') return respond([]);
    if (path === `/api/matches/${id}`) return respond({ id, name: '합성 홈 vs 합성 원정', sport, archived: false, competition_class: sport === 'FUTSAL' ? 'FUTSAL-QUEENCUP' : 'K3', first_half_minutes: 45, second_half_minutes: 45, metadata: { stream_mode: 'MANUAL', fla_clock_revision: revision, home_team: '합성 홈', away_team: '합성 원정' } });
    if (path === `/api/matches/${id}/summary`) return respond({ state, events, markers: [], possession: { home_pct: totals.HOME + totals.AWAY ? 100 * totals.HOME / (totals.HOME + totals.AWAY) : 0, away_pct: totals.HOME + totals.AWAY ? 100 * totals.AWAY / (totals.HOME + totals.AWAY) : 0 }, lanes: { home: {}, away: {} } });
    if (path === `/api/matches/${id}/dominance`) return respond({ bins: [], split_halves: true });
    if (path === `/api/matches/${id}/highlights`) return respond({ highlights: [] });
    if (path === `/api/matches/${id}/events/attack_lane` || path === `/api/matches/${id}/events/xg`) {
      const body = route.request().postDataJSON();
      await new Promise(resolve => setTimeout(resolve, delay));
      events.push({ ...body, id: body.event_id, type: path.endsWith('/xg') ? 'XG' : 'ATTACK_LANE', created_at: new Date().toISOString() });
      return respond({ ok: true });
    }
    if (path === `/api/matches/${id}/state`) {
      const body = route.request().postDataJSON(); requests.push(body);
      await new Promise(resolve => setTimeout(resolve, delay));
      if (body.command_revision !== revision) return route.fulfill({ status: 409, json: { detail: 'stale revision' } });
      if (body.update_kind === 'sample' && (body.clock_ms < state.clock_ms || ['running', 'possession_team', 'selected_team', 'attack_lr'].some(key => body[key] !== state[key]))) return respond({ ok: true, ignored: true, state, command_revision: revision });
      const time = body.allow_clock_rewind ? body.clock_ms : Math.max(state.clock_ms, body.clock_ms);
      if (state.running && state.possession_team !== 'NONE') totals[state.possession_team] += time - state.clock_ms;
      state = { clock_ms: time, running: body.running, possession_team: body.possession_team, selected_team: body.selected_team, attack_lr: body.attack_lr };
      if (body.update_kind === 'command') revision++;
      return respond({ ok: true, state, command_revision: revision });
    }
    throw Error(`Unexpected API: ${path}`);
  });
  const page = await context.newPage(); page.on('pageerror', e => result.errors.push(e.message));
  const home = () => page.locator('.fla-possession-buttons .fla-home');
  const away = () => page.locator('.fla-possession-buttons .fla-away');
  const request = () => page.waitForRequest(r => new URL(r.url()).pathname === `/api/matches/${id}/state`);
  const clock = async () => (await page.locator('.fla-clock-value').innerText()).split(' ')[0];
  try {
    await page.goto(origin + `/admin/match/${id}`);
    await home().waitFor(); await page.waitForFunction(() => !document.querySelector('.fla-possession-buttons .fla-home')?.disabled);
    if (scenario === 'queued-start') {
      const started = request();
      await page.getByRole('button', { name: '경기 시작', exact: true }).click(); await started;
      await home().click();
      await page.waitForFunction(() => document.querySelector('.fla-possession-buttons .fla-home')?.getAttribute('aria-pressed') === 'true');
      assert.equal(requests[1].running, true, 'A possession click queued behind start must inherit the accepted running state');
      const before = await clock(); await page.waitForTimeout(1200);
      assert.notEqual(await clock(), before, 'Clock must keep advancing after selecting possession');
      const stopped = request();
      await page.getByRole('button', { name: '일시정지', exact: true }).click(); await stopped;
      await away().click();
      await page.waitForFunction(() => document.querySelector('.fla-possession-buttons .fla-away')?.getAttribute('aria-pressed') === 'true');
      assert.equal(state.running, false, 'A possession click queued behind pause must not restart the clock');
      const paused = await clock(); await page.waitForTimeout(1200); assert.equal(await clock(), paused);
    } else {
      await page.evaluate(() => {
        window.clockSamples = [];
        const tick = () => { const value = document.querySelector('.fla-clock-value')?.textContent; if (value && window.clockSamples.at(-1) !== value) window.clockSamples.push(value); window.clockFrame = requestAnimationFrame(tick); };
        window.clockFrame = requestAnimationFrame(tick);
      });
      if (scenario === 'events') {
        const direction = page.getByRole('button', { name: '← 왼쪽', exact: true });
        await direction.click();
        await page.waitForTimeout(1700);
        assert.equal(state.attack_lr, 'R2L');
        const attack = page.getByRole('group', { name: '공격 방향 기록', exact: true });
        await attack.getByRole('button', { name: '합성 원정', exact: true }).click();
        await page.waitForTimeout(1700);
        assert.equal(state.selected_team, 'AWAY');
        await attack.getByRole('button', { name: /공격 기록/ }).click();
        await page.getByText('어웨이 · 중앙 공격을 기록했습니다.', { exact: true }).waitFor();
        await page.getByLabel(sport === 'FUTSAL' ? '풋살 슛 위치 입력 피치' : '슈팅 위치 선택', { exact: true }).click({ position: { x: 120, y: 80 } });
        await page.getByRole('button', { name: '슈팅 기록', exact: true }).click();
        await page.getByText('슈팅을 기록했습니다. 기록 탭에서 확인할 수 있습니다.', { exact: true }).waitFor();
        assert.equal(events.length, 2);
        assert(events.every(e => e.team === 'AWAY' && e.clock_ms >= 10000));
      } else {
      await home().click();
      await page.waitForFunction(() => document.querySelector('.fla-possession-buttons .fla-home')?.getAttribute('aria-pressed') === 'true');
      const changed = request(); await page.keyboard.press('w'); await changed;
      // Another team command is queued while the first response is delayed.
      await page.waitForTimeout(400); await page.keyboard.press('q');
      await page.waitForTimeout(3100);
      await page.keyboard.press('w');
      await page.waitForFunction(() => document.querySelector('.fla-possession-buttons .fla-away')?.getAttribute('aria-pressed') === 'true');
      await page.waitForTimeout(1600); await page.keyboard.press('e');
      await page.waitForFunction(() => document.querySelector('.fla-possession-buttons button:last-child')?.getAttribute('aria-pressed') === 'true');
      }
      const samples = await page.evaluate(() => { cancelAnimationFrame(window.clockFrame); return window.clockSamples; });
      const times = samples.map(s => { const [m, sec] = s.split(':').map(Number); return m * 60 + sec; });
      assert(times.length >= 5, 'Clock must advance while possession requests are in flight');
      assert(times.every((t, i) => !i || t >= times[i - 1]), `Clock moved backwards: ${samples.join(', ')}`);
      assert(requests.every(r => r.running), 'Possession and periodic samples must not stop the running clock');
      if (scenario === 'continuity') assert(totals.HOME > 0 && totals.AWAY > 0, 'Both possession teams must accumulate time');
      fs.writeFileSync(`${output}/${sport}-${scenario}-clock.json`, JSON.stringify({ samples, requests, events, totals }, null, 2));
    }
    await page.screenshot({ path: `${output}/${sport}-${scenario}.png` });
    result.cases.push(`${sport} ${scenario}: pass`);
  } catch (error) {
    result.failures.push({ sport, scenario, error: error.message });
    await page.screenshot({ path: `${output}/${sport}-${scenario}-failure.png` }).catch(() => {});
  } finally { await context.close(); }
}
(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()), headless: true });
  try {
    for (const sport of ['FOOTBALL', 'FUTSAL']) for (const scenario of ['queued-start', 'continuity', 'events']) await run(sport, scenario);
    result.passed = !result.failures.length && !result.errors.length;
    console.log(JSON.stringify(result, null, 2));
    assert(result.passed, 'Possession clock regression failed');
  } finally { fs.writeFileSync(output + '/results.json', JSON.stringify(result, null, 2)); await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
