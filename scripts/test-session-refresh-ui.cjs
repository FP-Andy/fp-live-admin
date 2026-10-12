/* Delayed session responses must not blank an already verified workspace. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('../apps/web/node_modules/playwright-core');
const origin = process.env.FPC_QA_ORIGIN || 'http://127.0.0.1:4354';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const output = process.env.FPC_SESSION_QA_OUTPUT || '/tmp/fpc-session-refresh-qa';
fs.mkdirSync(output, { recursive: true });
const result = { passed: false, cases: [], errors: [] };
let user = { id: 'account-a', name: '사용자 A', role: 'SUPERADMIN' };
let release, gate;
const hold = () => { gate = new Promise(resolve => { release = resolve; }); };
hold();
const matches = { items: [], total: 0, active_total: 0, archived_total: 0, assigned_total: 0, rtmp_total: 0, class_options: [] };
let browser, page;
(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()), headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'live_admin_session', value: 'synthetic', url: origin }]);
    await context.addInitScript(() => {
      sessionStorage.setItem('fpc.sidebar.open', 'false');
      // Invoke the actual installed minute timer without speeding up other timers.
      const original = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
      window.sessionTimers = new Map();
      window.setInterval = (fn, ms, ...args) => {
        const id = original(fn, ms, ...args);
        if (ms === 60000) window.sessionTimers.set(id, () => fn(...args));
        return id;
      };
      window.clearInterval = id => { window.sessionTimers.delete(id); clear(id); };
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/session/me') {
        const response = user;
        await gate;
        return route.fulfill(response ? { json: response } : { status: 401, json: { detail: 'expired' } });
      }
      if (url.pathname === '/api/dashboard/bootstrap') return route.fulfill({ json: { user, matches, competition_classes: [], schedule_entries: [], stream_status: {} } });
      if (url.pathname === '/api/dashboard/matches') return route.fulfill({ json: matches });
      if (url.pathname === '/api/admin/streams/status') return route.fulfill({ json: {} });
      throw Error(`Unexpected fixture API: ${url.pathname}`);
    });
    page = await context.newPage();
    page.on('pageerror', error => result.errors.push(error.message));
    const requested = () => page.waitForRequest(r => new URL(r.url()).pathname === '/api/session/me');
    const initial = requested();
    await page.goto(origin + '/admin/dashboard#create-match');
    await initial;
    assert.equal(await page.locator('.console-dashboard').count(), 0);
    release();
    await page.locator('.console-dashboard').waitFor();
    result.cases.push('Initial unverified session does not mount the workspace');
    await page.locator('#create-match > summary').click();
    const round = page.locator('#create-match input[type=number]').first();
    await round.fill('7');
    await round.focus();
    await page.evaluate(() => {
      window.originalRound = document.querySelector('#create-match input[type=number]');
      window.hiddenFrames = 0;
      const sample = () => {
        const content = document.querySelector('.app-content');
        if (!content || getComputedStyle(content).visibility !== 'visible' || content.getAttribute('aria-hidden') === 'true') window.hiddenFrames++;
        window.sampleFrame = requestAnimationFrame(sample);
      };
      window.sampleFrame = requestAnimationFrame(sample);
    });
    for (const trigger of ['focus', 'minute timer']) {
      hold();
      const request = requested();
      await page.evaluate(trigger => {
        if (trigger === 'focus') window.dispatchEvent(new Event('focus'));
        else { if (!window.sessionTimers.size) throw Error('Session timer missing'); window.sessionTimers.forEach(fn => fn()); }
      }, trigger);
      await request;
      await page.waitForTimeout(350);
      const state = await page.evaluate(() => ({ hiddenFrames: window.hiddenFrames, sameInput: window.originalRound === document.querySelector('#create-match input[type=number]'), focused: document.activeElement === window.originalRound }));
      await page.screenshot({ path: `${output}/${trigger.replace(' ', '-')}-pending.png` });
      assert.equal(state.hiddenFrames, 0, `${trigger} revalidation blanked the verified workspace`);
      assert(state.sameInput && state.focused, `${trigger} disturbed the input`);
      assert.equal(await round.inputValue(), '7');
      const completed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/session/me');
      release(); await completed; await page.waitForTimeout(50);
      result.cases.push(`${trigger}: delayed response leaves content visible, mounted and focused with draft intact`);
    }
    await page.evaluate(() => cancelAnimationFrame(window.sampleFrame));
    hold(); user = { id: 'account-b', name: '사용자 B', role: 'OPERATOR' };
    const switched = requested();
    await page.evaluate(() => { const channel = new BroadcastChannel('fpc-session'); channel.postMessage({ id: 'account-b' }); channel.close(); });
    await switched;
    assert.equal(await page.locator('.console-dashboard').count(), 0);
    release();
    await page.getByText('사용자 B · OPERATOR', { exact: true }).waitFor();
    await page.locator('#create-match > summary').click();
    assert.equal(await round.inputValue(), '1');
    result.cases.push('Cross-tab account change removes A immediately; B receives a fresh workspace');
    hold(); user = null;
    const expired = requested();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expired; release();
    await page.waitForURL('**/login?next=*');
    assert.equal(await page.locator('.console-dashboard').count(), 0);
    result.cases.push('Confirmed expired session removes the workspace and redirects to login');
    assert.deepEqual(result.errors, []);
    result.passed = true;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    release();
    fs.writeFileSync(output + '/results.json', JSON.stringify(result, null, 2));
    await browser?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
