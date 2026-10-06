/* Browser contracts with fixture-only APIs and downloads. No live requests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { chromium } = require('../apps/web/node_modules/playwright-core');
const origin = process.env.CLIP_QA_ORIGIN || 'http://127.0.0.1:4352';
assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const output = process.env.CLIP_QA_OUTPUT || '/tmp/fpc-clip-feature-qa';
fs.mkdirSync(output, { recursive: true });
const mediaFile = output + '/synthetic.mp4';
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=5',
  '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile]);
const media = fs.readFileSync(mediaFile);
const jobId = 'fixture-manual-job';
const clipId = `manual-${jobId}-clip_001`;
const clips = [1, 2].map((n) => ({ id: `manual-${jobId}-clip_00${n}`, order_index: n - 1,
  team_side: n === 1 ? 'home' : 'away', start_sec: 60 * n, end_sec: 60 * n + 5,
  duration_seconds: 5, title: `검증 클립 ${n}`, action_count: n === 1 ? 1 : 0 }));
const actions = [{ seq: 1, action: 'Shot', actionLabel: '슈팅', teamSide: 'home', jersey: '7', startOffset: 0, endOffset: 5 }];
const sceneData = { v: 1, players: [{ team: 'home', x: 20, y: 20, toX: 60, toY: 30, number: '7' }], caption: '검증용 장면' };
let registration = null;
let ready = false;
let failDownload = false;
let registrationRequests = 0;
let jobClipRequests = 0;
const job = () => ({ id: jobId, status: 'done', original_filename: '수동 테스트 경기.mp4',
  export_path: '/fixture/montage.mp4', created_at: '2026-10-06T00:00:00Z',
  job_metadata: { clip_info: clips.map((c, i) => ({ name: `clip_00${i + 1}.mp4`, requested_start: c.start_sec, requested_end: c.end_sec })),
    clip_results: registration } });
const matches = () => [
  { job_id: jobId, match_id: null, source_mode: 'manual', name: '수동 테스트 경기', home_team: '홈 테스트', away_team: '원정 테스트', clip_count: 2 },
  { job_id: 'existing-job', match_id: 'existing-match', source_mode: 'fineplay', name: '기존 자동 클립 경기', clip_count: 1, analysis_request_id: 123 },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()), headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 1100 } });
    await context.addCookies([{ name: 'live_admin_session', value: 'fixture-only-session', url: origin }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'media.fixture.invalid') {
        return route.fulfill({ status: 200, contentType: 'video/mp4',
          headers: { 'Content-Disposition': "attachment; filename*=UTF-8''scene-motion-fixture-action-1.mp4" },
          body: media });
      }
      if (url.origin !== origin) return route.abort();
      if (['/fixture-clip.mp4', '/fixture-ready.mp4'].includes(url.pathname)) {
        return route.fulfill({ contentType: 'video/mp4', body: media });
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname;
      const respond = data => route.fulfill({ json: data });
      if (path === '/api/session/me') return respond({ id: 'fixture', name: '검증 관리자', role: 'SUPERADMIN' });
      if (path === '/api/highlight/jobs') return respond([job()]);
      if (path === `/api/highlight/manual-jobs/${jobId}/clip-results`) {
        registrationRequests++;
        registration = { status: 'ready', completed: 2, total: 2 };
        return respond({ job_id: jobId, clip_results: registration });
      }
      if (path === '/api/highlight/clip-results/matches') return respond(matches());
      if (path === `/api/highlight/clip-results/jobs/${jobId}/clips`) {
        jobClipRequests++;
        return respond({ clips });
      }
      if (path === '/api/highlight/clip-results/matches/existing-match/clips') return respond({ clips: [clips[0]] });
      if (path.endsWith('/scene-motions/1/download')) {
        if (failDownload) return route.fulfill({ status: 409, json: { detail: '현재 장면의 MP4를 준비 중입니다.' } });
        return respond({ url: 'https://media.fixture.invalid/current.mp4', filename: 'scene-motion-fixture-action-1.mp4' });
      }
      if (path.endsWith('/scene-motions')) return respond({ motions: [{ seq: 1, sceneData, url: ready ? '/fixture-ready.mp4' : null }], warnings: [] });
      const clip = clips.find(c => path === `/api/highlight/clip-results/clips/${c.id}`);
      if (clip) return respond({ ...clip, video_url: '/fixture-clip.mp4', match_id: null, job_id: jobId, team_labels: { home: '홈 테스트', away: '원정 테스트' }, actions });
      return route.fulfill({ status: 404, json: { detail: `Unexpected fixture request: ${path}` } });
    });

    await page.goto(origin + '/admin/highlight/results', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '클립결과에 등록', exact: true }).click();
    await page.getByRole('link', { name: '클립결과에서 분석', exact: true }).waitFor();
    assert.equal(registrationRequests, 1);
    assert(await page.getByRole('link', { name: '합본 다운로드', exact: true }).isVisible());
    await page.screenshot({ path: output + '/manual-results.png', fullPage: true });
    await page.getByRole('link', { name: '클립결과에서 분석', exact: true }).click();
    await page.getByRole('button', { name: '상세', exact: true }).first().waitFor();
    assert(jobClipRequests > 0);
    assert.equal(await page.getByRole('button', { name: /FinePlay로 전송/ }).count(), 0);
    await page.getByRole('button', { name: '상세', exact: true }).first().click();
    const pending = page.getByRole('button', { name: 'MP4 준비 중', exact: true });
    await pending.waitFor();
    assert(await pending.isDisabled());
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
    assert.equal(await page.locator('video').first().evaluate(video => video.duration), 5);
    // Keep the actual dual launch route; its save/restore API is covered by Python tests.
    await page.evaluate(() => { window.open = url => { window.__dualTarget = url; return null; }; });
    await page.getByRole('button', { name: '🎯 FPA dual', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__dualTarget), `/admin/fpa/live?clipId=${clipId}&embed=1`);
    ready = true;
    await page.getByRole('button', { name: '모션 새로고침', exact: true }).click();
    const downloadButton = page.getByRole('button', { name: 'MP4 다운로드', exact: true });
    await downloadButton.waitFor();
    assert(!(await downloadButton.isDisabled()));
    await page.screenshot({ path: output + '/manual-clip-detail.png', fullPage: true });
    const downloadPromise = page.waitForEvent('download');
    await downloadButton.click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'scene-motion-fixture-action-1.mp4');
    await download.saveAs(output + '/download-fixture.mp4');
    assert.deepEqual(fs.readFileSync(output + '/download-fixture.mp4'), media);
    await page.getByRole('button', { name: 'MP4로 보기', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('video')].length === 2
      && [...document.querySelectorAll('video')].every(video => video.readyState >= 1));
    await page.getByRole('button', { name: '앱 화면으로', exact: true }).click();
    failDownload = true;
    await downloadButton.click();
    await page.getByText('현재 장면의 MP4를 준비 중입니다.', { exact: false }).waitFor();
    failDownload = false;
    await page.getByRole('button', { name: '매치 목록', exact: true }).click();
    const existingRow = page.locator('div').filter({ has: page.getByText('기존 자동 클립 경기', { exact: true }) })
      .filter({ has: page.getByRole('button', { name: '열기', exact: true }) }).last();
    await existingRow.getByRole('button', { name: '열기', exact: true }).click();
    await page.getByRole('button', { name: /FinePlay로 전송/ }).waitFor();
    await page.getByRole('button', { name: '상세', exact: true }).first().waitFor();

    // A failed/abandoned registration can be retried without hiding the montage.
    registration = { status: 'error', completed: 1, total: 2, error: '검증용 저장소 실패' };
    await page.goto(origin + '/admin/highlight/results', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '연결 재시도', exact: true }).waitFor();
    assert(await page.getByRole('link', { name: '합본 다운로드', exact: true }).isVisible());
    assert(await page.getByRole('link', { name: '클립결과에서 분석', exact: true }).isVisible());
    await page.getByRole('button', { name: '연결 재시도', exact: true }).click();
    await page.getByText('클립결과 등록 완료 · 2개', { exact: true }).waitFor();
    registration = { status: 'running', completed: 0, total: 2 };
    await page.reload({ waitUntil: 'networkidle' });
    assert(!(await page.getByRole('button', { name: '연결 다시 요청', exact: true }).isDisabled()));

    await page.evaluate(() => localStorage.setItem('fineplay.selectedSport', 'BASKETBALL'));
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: /클립결과에 등록|연결 다시 요청|연결 재시도/ }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: manual registration → existing clip detail/dual launch, MP4 pending/attachment/error, FinePlay controls preserved, retry and basketball isolation');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
