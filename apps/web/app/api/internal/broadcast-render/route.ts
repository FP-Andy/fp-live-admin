import { NextRequest, NextResponse } from 'next/server';
import { chromium } from 'playwright-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AssetType = 'attack-direction-home' | 'attack-direction-away' | 'possession' | 'xg-shot-map' | 'match-dominance-halftime' | 'match-dominance-fulltime';

const WEBP_LOOP_MS = 3_000;
const WEBP_FRAME_MS = 100;
const WEBP_FRAME_COUNT = WEBP_LOOP_MS / WEBP_FRAME_MS;

const RENDER_CONFIG: Record<AssetType, { path: 'analysis' | 'possession' | 'fullscreen'; graphic: string; motionSelector?: string }> = {
  'attack-direction-home': { path: 'analysis', graphic: 'ATTACK_DIRECTION_HOME', motionSelector: '.lc-attack-lane' },
  'attack-direction-away': { path: 'analysis', graphic: 'ATTACK_DIRECTION_AWAY', motionSelector: '.lc-attack-lane' },
  possession: { path: 'possession', graphic: 'POSSESSION', motionSelector: '.lc-possession-bar span' },
  'xg-shot-map': { path: 'analysis', graphic: 'XG', motionSelector: '.lc-xg-shot-dot, .lc-xg-shot-line, .lc-xg-goal-star' },
  'match-dominance-halftime': { path: 'fullscreen', graphic: 'MATCH_DOMINANCE' },
  'match-dominance-fulltime': { path: 'fullscreen', graphic: 'MATCH_DOMINANCE' },
};

function isAssetType(value: unknown): value is AssetType {
  return typeof value === 'string' && value in RENDER_CONFIG;
}

export async function POST(request: NextRequest) {
  const expectedToken = process.env.BROADCAST_RENDER_TOKEN;
  if (expectedToken && request.headers.get('x-broadcast-render-token') !== expectedToken) {
    return NextResponse.json({ detail: 'Unauthorized renderer request' }, { status: 401 });
  }
  const body = await request.json().catch(() => null) as { match_id?: unknown; asset_types?: unknown } | null;
  const matchId = typeof body?.match_id === 'string' ? body.match_id : '';
  const assetTypes = Array.isArray(body?.asset_types) ? body.asset_types.filter(isAssetType) : [];
  if (!/^[0-9a-f-]{36}$/i.test(matchId) || !assetTypes.length) {
    return NextResponse.json({ detail: 'match_id and asset_types are required' }, { status: 400 });
  }

  const origin = (process.env.BROADCAST_OVERLAY_ORIGIN || 'http://nginx').replace(/\/$/, '');
  const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
  const browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const result: Record<string, { frames: string[] }> = {};
    for (const assetType of [...new Set(assetTypes)]) {
      const config = RENDER_CONFIG[assetType];
      // Broadcast assets are delivered as HD overlays. Rendering at 1280×720
      // keeps the 30-frame WebP generation inside the minute refresh window
      // without trading away practical broadcast quality.
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      await page.goto(`${origin}/overlay/football/${matchId}/${config.path}?render=${config.graphic}`, { waitUntil: 'networkidle', timeout: 20_000 });
      await page.waitForSelector('[data-live-coder-capture-ready="true"]', { timeout: 12_000 });
      if (config.motionSelector) {
        // Freeze the CSS motion at each intended timeline point. Screenshot
        // encoding is slower than 100ms on the production renderer, so merely
        // waiting between captures would skip frames and make the WebP jerky.
        await page.evaluate((selector) => {
          const elements = [...document.querySelectorAll<HTMLElement>(selector)];
          for (const element of elements) {
            element.dataset.broadcastMotionDelay = getComputedStyle(element).animationDelay || '0ms';
            element.style.animationPlayState = 'paused';
          }
          void document.body.offsetHeight;
        }, config.motionSelector);
      }
      const frames: string[] = [];
      // Capture at 10fps instead of preserving only a handful of key frames.
      // It keeps the WebP light enough for overlays while making the three-second
      // Live Coder entrance motion continuous rather than step-like.
      for (let index = 0; index < WEBP_FRAME_COUNT; index += 1) {
        if (config.motionSelector) {
          await page.evaluate(({ selector, elapsed }) => {
            for (const element of document.querySelectorAll<HTMLElement>(selector)) {
              const baseDelay = element.dataset.broadcastMotionDelay || '0ms';
              element.style.animationDelay = `calc(${baseDelay} - ${elapsed}ms)`;
            }
            void document.body.offsetHeight;
          }, { selector: config.motionSelector, elapsed: index * WEBP_FRAME_MS });
        }
        frames.push((await page.screenshot({ type: 'png', omitBackground: true })).toString('base64'));
      }
      result[assetType] = { frames };
      await page.close();
    }
    return NextResponse.json({ assets: result });
  } finally {
    await browser.close();
  }
}
