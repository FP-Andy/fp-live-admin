/* Actual Chrome component -> MP4 -> decoded frame comparison; localhost only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('../apps/web/node_modules/playwright-core');
const origin = process.env.SCENE_QA_ORIGIN || 'http://127.0.0.1:4354';
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const output = process.env.SCENE_QA_OUTPUT || '/tmp/fpc-scene-native-qa';
fs.mkdirSync(output, { recursive: true });
const token = process.env.SCENE_MOTION_RENDER_TOKEN || 'fixture-render-token';
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const base = {
  v: 1, ours: 'away',
  players: [
    { team: 'away', x: 22, y: 18, toX: 52, toY: 28, number: '7' },
    { team: 'away', x: 60, y: 43, toX: 75, toY: 47, number: '10' },
    { team: 'home', x: 8, y: 34, toX: 12, toY: 35, number: '1', gk: true },
    { team: 'home', x: 62, y: 35, toX: 56, toY: 34, number: '4' },
  ],
  moves: [{ type: 'dribble', x: 45, y: 25, deg: -12 }, { type: 'penetrate', x: 65, y: 47, deg: -30 }],
  passes: [{ kind: 'pass', x1: 22, y1: 18, x2: 52, y2: 28 }, { kind: 'fail', x1: 52, y1: 28, x2: 75, y2: 47 }],
  ball: { path: [{ x: 22, y: 18 }, { x: 52, y: 28 }, { x: 75, y: 47 }] },
};
const cases = [
  { name: 'pass-dribble-away', data: base, times: [0, 0.28, 1.8, 4.0] },
  { name: 'goal-right', data: { ...base, shot: { gx: .84, gy: .72, dir: 'right', start: 'left' }, caption: '골! #7' }, times: [3.6, 4.4, 5.4] },
  { name: 'save-catch-left', data: { ...base, shot: { gx: .18, gy: .9, dir: 'left', start: 'right', save: 'catch' } }, times: [4.2, 5.4] },
  { name: 'save-punch-right', data: { ...base, shot: { gx: .7, gy: .5, dir: 'right', start: 'center', save: 'punch' } }, times: [4.2, 5.4] },
  { name: 'clear-defense', data: { ...base, passes: base.passes.map(p => ({ ...p, kind: 'defense' })), ball: { ...base.ball, exit: { x: 75, y: 68 } } }, times: [3.6, 4.7] },
];
const result = { passed: false, cases: [], unexpected: [] };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1708, height: 1106 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page.on('pageerror', e => result.unexpected.push(e.message));
    await page.goto(origin + '/render/scene-motion');
    await page.waitForFunction(() => Boolean(window.fpcSceneCapture));
    const endpoint = origin + '/api/internal/scene-motion-render';
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
    const headers = { 'content-type': 'application/json', 'x-scene-render-token': token };
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'null' })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ version: 'old', sceneData: base }) })).status, 400);
    for (const fixture of cases) {
      const duration = await page.evaluate(data => window.fpcSceneCapture.load(data, 1708), fixture.data);
      await page.evaluate(async () => { await document.fonts.load('700 40px Giants'); await document.fonts.ready; });
      await page.waitForFunction(() => [...document.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0));
      const sources = await page.locator('img').evaluateAll(images => images.map(image => image.getAttribute('src')));
      for (const asset of ['pitch.png', 'player_home_hexagon.svg', 'player_away_circle.svg', 'ball.svg', 'arrow_move_dribble.svg', 'arrow_move_penetrate.svg']) assert(sources.includes('/scene/' + asset));
      const pending = fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ version: 'fpc-native-v1', sceneData: fixture.data }) });
      if (fixture === cases[0]) {
        await new Promise(resolve => setTimeout(resolve, 700));
        const busy = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ version: 'fpc-native-v1', sceneData: fixture.data }) });
        assert.equal(busy.status, 429);
      }
      const response = await pending;
      if (!response.ok) throw Error(await response.text());
      assert.equal(response.headers.get('x-scene-renderer'), 'fpc-native-v1');
      const mp4 = path.join(output, fixture.name + '.mp4');
      fs.writeFileSync(mp4, Buffer.from(await response.arrayBuffer()));
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', mp4]));
      const stream = probe.streams.find(s => s.codec_type === 'video');
      assert.equal(stream.width, 1708); assert.equal(stream.height, 1106); assert.equal(stream.codec_name, 'h264');
      assert.equal(Number(stream.nb_frames), Math.ceil(duration * 25));
      const comparisons = [];
      for (const seconds of fixture.times) {
        const frame = Math.round(seconds * 25);
        await page.evaluate(seconds => window.fpcSceneCapture.seek(seconds), frame / 25);
        // SVG glove images are not HTMLImageElements; wait for their local resource.
        await page.evaluate(async () => { const img = new Image(); img.src = '/scene/gk_glove.png'; await img.decode(); });
        const reference = path.join(output, `${fixture.name}-${frame}-screen.png`);
        const decoded = path.join(output, `${fixture.name}-${frame}-mp4.png`);
        await page.screenshot({ path: reference });
        execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', mp4, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', decoded]);
        // ffmpeg emits filter statistics on stderr.
        const comparison = require('node:child_process').spawnSync(ffmpeg, ['-i', reference, '-i', decoded, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
        assert.equal(comparison.status, 0);
        const ssim = Number(comparison.stderr.match(/All:([0-9.]+)/)?.[1]);
        // H.264 yuv420p chroma subsampling/8-bit RGB conversion alone changes
        // this textured pitch by ~1.4/255 per channel. Compare the entire frame
        // at full resolution with a tolerance for those codec quantisations.
        assert(ssim >= .97, `${fixture.name} frame ${frame}: SSIM ${ssim}`);
        comparisons.push({ frame, ssim });
      }
      result.cases.push({ name: fixture.name, duration: Number(stream.duration), frames: Number(stream.nb_frames), comparisons });
      console.log('PASS', fixture.name, JSON.stringify(comparisons));
    }
    assert.deepEqual(result.unexpected, []);
    result.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
