import { NextRequest, NextResponse } from 'next/server';
import { chromium } from 'playwright-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AssetType =
  | 'attack-direction-home'
  | 'attack-direction-away'
  | 'possession'
  | 'shots-comparison'
  | 'shot-xg'
  | 'xg-comparison'
  | 'match-dominance-halftime'
  | 'match-dominance-fulltime';

const RENDER_CONFIG: Record<AssetType, { path: 'analysis' | 'possession' | 'fullscreen'; graphic: string }> = {
  'attack-direction-home': { path: 'analysis', graphic: 'ATTACK_DIRECTION_HOME' },
  'attack-direction-away': { path: 'analysis', graphic: 'ATTACK_DIRECTION_AWAY' },
  possession: { path: 'possession', graphic: 'POSSESSION' },
  'shots-comparison': { path: 'analysis', graphic: 'SHOTS_COMPARISON' },
  'shot-xg': { path: 'analysis', graphic: 'SHOT_XG' },
  'xg-comparison': { path: 'analysis', graphic: 'XG_COMPARISON' },
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
  const body = await request.json().catch(() => null) as { match_id?: unknown; asset_types?: unknown; xg_event_id?: unknown } | null;
  const matchId = typeof body?.match_id === 'string' ? body.match_id : '';
  const assetTypes = Array.isArray(body?.asset_types) ? body.asset_types.filter(isAssetType) : [];
  const xgEventId = typeof body?.xg_event_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.xg_event_id) ? body.xg_event_id : '';
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
    const result: Record<string, { background_png: string; asset_png: string }> = {};
    for (const assetType of [...new Set(assetTypes)]) {
      const config = RENDER_CONFIG[assetType];
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const xgEventQuery = assetType === 'shot-xg' && xgEventId ? `&xg_event_id=${encodeURIComponent(xgEventId)}` : '';
      await page.goto(`${origin}/overlay/football/${matchId}/${config.path}?render=${config.graphic}${xgEventQuery}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // The overlay loads its FLA snapshot on the client.  A freshly deployed
      // Next.js server can need longer than the initial DOM load before that
      // data mounts, so wait for the actual capture root rather than failing
      // after the previous fixed 20-second window.
      await page.waitForSelector('[data-live-coder-capture-ready="true"]', { state: 'attached', timeout: 30_000 });
      // Broadcast templates use Paperlogy.  Wait for the local font faces so a
      // cold render never freezes an Arial fallback into a published PNG.
      await page.evaluate(async () => {
        await document.fonts?.ready;
      });
      // Templates are separate SVG files.  The capture root can mount before
      // an uncached SVG has painted, which would otherwise publish a blank
      // background layer.  Wait only for design templates (not remote team
      // logos) so an unavailable logo cannot hold up an entire render.
      await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('img[data-broadcast-template="true"]'))
        .every((image) => image.complete && image.naturalWidth > 0), { timeout: 30_000 });
      // Uploaded team logos are served from the same app and normally arrive
      // immediately.  Give them a short, separate wait so a new crest is not
      // omitted from the first PNG after upload, without treating an optional
      // external logo URL as a hard failure for the whole graphic.
      await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('img[data-broadcast-logo="true"]'))
        .every((image) => image.complete && image.naturalWidth > 0), { timeout: 4_000 }).catch(() => undefined);
      const capture = async (layer: 'background' | 'asset') => {
        await page.evaluate((nextLayer) => {
          document.querySelector('main.lc-overlay-root')?.setAttribute('data-broadcast-capture-layer', nextLayer);
        }, layer);
        await page.evaluate(() => void document.body.offsetHeight);
        return page.screenshot({ type: 'png', omitBackground: true });
      };
      // The two captures share one page and toggle its layer visibility, so
      // they must run in order rather than racing attribute updates.
      const backgroundPng = await capture('background');
      const assetPng = await capture('asset');
      result[assetType] = {
        background_png: backgroundPng.toString('base64'),
        asset_png: assetPng.toString('base64'),
      };
      await page.close();
    }
    return NextResponse.json({ assets: result });
  } finally {
    await browser.close();
  }
}
