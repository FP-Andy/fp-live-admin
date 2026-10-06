const assert = require('node:assert/strict'), fs = require('node:fs');
const { chromium } = require('../apps/web/node_modules/playwright-core');
const origin = process.env.FPC_QA_ORIGIN || 'http://127.0.0.1:4354';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const output = process.env.FPC_DIALOG_QA_OUTPUT || '/tmp/fpc-completion-dialog-qa';
fs.mkdirSync(output, { recursive: true });
const html = fs.readFileSync('apps/web/public/fpa-cv/index.html', 'utf8');
const section = html.match(/<section id="heatmap-workspace"[\s\S]*?<\/section>/)[0].replace(' hidden', '');
const fixture = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fpa-cv/brand.css"><link rel="stylesheet" href="/fpa-cv/style.css">
<div style="height:1400px">합성 긴 분석 작업 화면</div>${section}<div style="height:4000px"></div>
<script type="module">
import {connectConsole} from '/fpa-cv/console-embed.mjs';
import {heatmapUI} from '/fpa-cv/heatmap-ui.mjs';
connectConsole();
const data={datasetId:'test',video:{name:'test',clipStart:0,clipEnd:2},detector:{sampleFps:10,roi:[[0,0],[1,0],[1,1],[0,1]]},frames:Array.from({length:20},(_,i)=>({t:i/10,boxes:i<10?[{id:1,box:[.3,.3,.32,.4],confidence:.9}]:[]}))};
const review={setup:{time:0},uniforms:{},roster:Array.from({length:10},(_,i)=>({id:'home-'+(i+1),jersey:String(i+1),group:'home'})),segments:[{trackId:1,personId:'home-1',source:'manual',from:0,to:2}],events:[],batch:{round:2}};
window.notices=[];
heatmapUI({getData:()=>data,getWorking:()=>review,getRecovery:()=>({status:'complete',issues:[],data}),prepareSnapshot:async()=>({jobId:'a'.repeat(32),reviewVersion:7}),message:m=>window.notices.push(m)}).open();
</script>`;
const cases = [], errors = [], unexpected = [];
let browser;
async function visible(locator, viewport) {
  const b = await locator.boundingBox(); assert(b, 'Control has a bounding box');
  assert(b.y >= 0 && b.y + b.height <= viewport.height + 1 && b.x >= 0 && b.x + b.width <= viewport.width + 1, `Outside visible viewport: ${JSON.stringify(b)}`);
}
(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()), headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1366, height: 768 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.addCookies([{ name: 'live_admin_session', value: 'fixture-session', url: origin }]);
      await context.addInitScript(() => localStorage.setItem('fineplay.selectedSport', 'FUTSAL'));
      const requests = []; let release, gate = new Promise(r => { release = r; }), fail = true;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url()); if (url.origin !== origin) return route.abort();
        if (url.pathname === '/fpa-cv/index.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (url.pathname === '/api/session/me') return route.fulfill({ json: { id: 'fixture-user', name: '검증 관리자', role: 'SUPERADMIN' } });
        if (url.pathname === '/api/futsal/analysis-snapshots' && route.request().method() === 'POST') {
          requests.push(route.request().postDataJSON()); await gate;
          return route.fulfill(fail ? { status: 503, json: { detail: '검증용 저장 실패 · 다시 시도하세요' } } : { json: { id: 'a'.repeat(32), version: 1 } });
        }
        unexpected.push(url.pathname); return route.fulfill({ status: 404, json: {} });
      });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin + '/admin/futsal/fpa/tracking');
      const embedded = page.frameLocator('iframe[title="풋살 FPA 영상 분석"]');
      const complete = embedded.locator('#heatmap-complete'), dialog = embedded.locator('#analysis-complete-dialog');
      await embedded.locator('#heatmap-complete:enabled').waitFor();
      await complete.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => { const el = document.querySelector('iframe[title="풋살 FPA 영상 분석"]'); return el?.contentDocument?.documentElement.style.getPropertyValue('--console-visible-top'); });
      await complete.click();
      const check = embedded.locator('#analysis-complete-checked'), confirm = embedded.locator('#analysis-complete-confirm'), cancel = embedded.locator('#analysis-complete-cancel');
      await visible(check, viewport); await visible(confirm, viewport); await visible(cancel, viewport);
      assert(await confirm.isDisabled());
      await check.focus(); await page.keyboard.press('Space'); assert.equal(await confirm.isDisabled(), false);
      await confirm.click();
      await embedded.locator('#analysis-complete-confirm').filter({ hasText: '저장 중' }).waitFor();
      await confirm.evaluate(button => { button.click(); button.click(); });
      await page.keyboard.press('Escape'); assert(await dialog.evaluate(d => d.open)); assert(await cancel.isDisabled());
      await page.waitForTimeout(100); assert.equal(requests.length, 1); release();
      const error = embedded.locator('#analysis-complete-error'); await error.waitFor(); await visible(error, viewport); await visible(cancel, viewport); await visible(confirm, viewport);
      await page.screenshot({ path: `${output}/dialog-${viewport.width}x${viewport.height}.png` });
      await cancel.click(); assert.equal(await dialog.evaluate(d => d.open), false); assert(await complete.evaluate(button => document.activeElement === button));
      await complete.click(); await page.keyboard.press('Escape'); assert.equal(await dialog.evaluate(d => d.open), false); assert(await complete.evaluate(button => document.activeElement === button));
      fail = false; gate = Promise.resolve();
      await complete.click(); await check.check(); await confirm.click(); await embedded.locator('#analysis-snapshot-link').waitFor();
      assert.equal(requests.length, 2); assert.equal(requests[0].requestId, requests[1].requestId); assert.equal(requests[1].confirmed, true);
      assert.equal(await dialog.evaluate(d => d.open), false);
      const name = `${viewport.width}×${viewport.height}: visible checkbox/actions/error, keyboard/Escape/focus, single save and same-ID retry`;
      cases.push(name); console.log('PASS:', name); await context.close();
    }
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } finally {
    fs.writeFileSync(output + '/results.json', JSON.stringify({ cases, errors, unexpected }, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
