import { NextRequest, NextResponse } from 'next/server';
import { chromium } from 'playwright-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AssetType = 'attack-direction' | 'possession' | 'xg-shot-map' | 'match-dominance-halftime' | 'match-dominance-fulltime';

const RENDER_CONFIG: Record<AssetType, { path: 'analysis' | 'possession' | 'fullscreen'; graphic: string }> = {
  'attack-direction': { path: 'analysis', graphic: 'ATTACK_DIRECTION_BOTH' },
  possession: { path: 'possession', graphic: 'POSSESSION' },
  'xg-shot-map': { path: 'analysis', graphic: 'XG' },
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
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      await page.goto(`${origin}/overlay/football/${matchId}/${config.path}?render=${config.graphic}`, { waitUntil: 'networkidle', timeout: 20_000 });
      await page.waitForSelector('[data-live-coder-capture-ready="true"]', { timeout: 12_000 });
      const frames: string[] = [];
      for (const delay of [60, 100, 120, 160, 240]) {
        await page.waitForTimeout(delay);
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
