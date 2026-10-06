import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SceneData } from '../components/SceneMotionView';

export const SCENE_RENDER_VERSION = 'fpc-native-v1';
// Exact 2562:1659 pitch aspect, with both dimensions even for H.264.
export const SCENE_RENDER_WIDTH = 1708;
export const SCENE_RENDER_HEIGHT = 1106;
export const SCENE_RENDER_FPS = 25;

export function isSceneData(value: unknown): value is SceneData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const bounded = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 10000;
  const list = (x: unknown, max: number, check: (item: Record<string, unknown>) => boolean) => x === undefined || (Array.isArray(x) && x.length <= max && x.every(item => item && typeof item === 'object' && !Array.isArray(item) && check(item)));
  const point = (p: Record<string, unknown>) => bounded(p.x) && bounded(p.y);
  if (v.ours !== undefined && !['home', 'away'].includes(String(v.ours))) return false;
  if (!list(v.players, 100, p => point(p) && ['home', 'away'].includes(String(p.team)) && (p.toX === undefined || bounded(p.toX)) && (p.toY === undefined || bounded(p.toY)) && (p.number === undefined || (['number', 'string'].includes(typeof p.number) && String(p.number).length <= 12)))) return false;
  if (!list(v.passes, 200, p => ['x1', 'y1', 'x2', 'y2'].every(key => bounded(p[key])) && (p.kind === undefined || ['pass', 'defense', 'fail'].includes(String(p.kind))))) return false;
  if (!list(v.moves, 100, p => point(p) && bounded(p.deg) && ['dribble', 'penetrate'].includes(String(p.type)))) return false;
  if (v.caption !== undefined && (typeof v.caption !== 'string' || v.caption.length > 120)) return false;
  if (v.ball !== undefined) {
    if (!v.ball || typeof v.ball !== 'object' || Array.isArray(v.ball)) return false;
    const b = v.ball as Record<string, unknown>;
    if (!list(b.path, 500, point) || (b.exit !== undefined && (!b.exit || typeof b.exit !== 'object' || !point(b.exit as Record<string, unknown>)))) return false;
  }
  if (v.shot !== undefined) {
    if (!v.shot || typeof v.shot !== 'object' || Array.isArray(v.shot)) return false;
    const s = v.shot as Record<string, unknown>;
    if (!bounded(s.gx) || !bounded(s.gy) || (s.dir !== undefined && !['left', 'right'].includes(String(s.dir))) || (s.start !== undefined && !['left', 'center', 'right'].includes(String(s.start))) || (s.save !== undefined && !['catch', 'punch', true, false].includes(s.save as string | boolean))) return false;
  }
  return Array.isArray(v.players) && v.players.length > 0;
}

/** Capture the actual console component; no duplicate drawing or remote media. */
export async function renderSceneMp4(data: SceneData): Promise<Buffer> {
  const origin = process.env.SCENE_MOTION_CAPTURE_ORIGIN || 'http://127.0.0.1:3000';
  if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Capture origin must be loopback');
  const temp = await mkdtemp(join(tmpdir(), 'fpc-scene-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let encoder: ReturnType<typeof spawn> | undefined;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; encoder?.kill('SIGKILL'); void browser?.close(); }, 150000);
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage({ viewport: { width: SCENE_RENDER_WIDTH, height: SCENE_RENDER_HEIGHT }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    await page.goto(`${origin}/render/scene-motion`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => Boolean(window.fpcSceneCapture));
    const duration = await page.evaluate(({ data, width }) => window.fpcSceneCapture!.load(data, width), { data, width: SCENE_RENDER_WIDTH });
    // Include SVG images (ball/gloves) which may only appear late in the shot.
    await page.evaluate(async () => {
      await document.fonts.load('700 40px Giants');
      const paths = ['/scene/pitch.png', '/scene/player_home_hexagon.svg', '/scene/player_away_circle.svg', '/scene/ball.svg', '/scene/arrow_move_dribble.svg', '/scene/arrow_move_penetrate.svg', '/scene/gk_glove.png'];
      await Promise.all(paths.map(src => new Promise<void>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(); img.onerror = () => reject(new Error('Scene asset missing')); img.src = src; })));
      await document.fonts.ready;
    });
    const output = join(temp, 'scene.mp4');
    encoder = spawn(process.env.FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(SCENE_RENDER_FPS), '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '12', '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', output], { stdio: ['pipe', 'ignore', 'pipe'] });
    let encoderError = '';
    encoder.stderr!.on('data', chunk => { encoderError = (encoderError + chunk.toString()).slice(-2000); });
    encoder.stdin!.on('error', () => { /* Rejected through the encoder result. */ });
    const finished = new Promise<void>((resolve, reject) => {
      encoder!.once('error', reject);
      encoder!.once('close', code => code === 0 ? resolve() : reject(new Error(`MP4 encoder failed: ${encoderError}`)));
    });
    // Capture errors must not leave an unhandled rejection while cleanup runs.
    void finished.catch(() => undefined);
    for (let frame = 0; frame < Math.ceil(duration * SCENE_RENDER_FPS); frame++) {
      if (timedOut) throw new Error('Scene render timed out');
      await page.evaluate(seconds => window.fpcSceneCapture!.seek(seconds), frame / SCENE_RENDER_FPS);
      const png = await page.screenshot({ type: 'png', timeout: 15000 });
      if (encoder.exitCode !== null || encoder.stdin!.destroyed) { await finished; throw new Error('Encoder stopped early'); }
      if (!encoder.stdin!.write(png)) await Promise.race([once(encoder.stdin!, 'drain'), finished]);
    }
    encoder.stdin!.end();
    await finished;
    return await readFile(output);
  } finally {
    clearTimeout(deadline);
    encoder?.kill('SIGKILL');
    await browser?.close();
    await rm(temp, { recursive: true, force: true });
  }
}
