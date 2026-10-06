import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { isSceneData, renderSceneMp4, SCENE_RENDER_VERSION } from '../../../../lib/scene-motion-render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const slot = globalThis as typeof globalThis & { fpcSceneRenderBusy?: boolean };

export async function POST(request: NextRequest) {
  const expected = process.env.SCENE_MOTION_RENDER_TOKEN || '';
  const supplied = request.headers.get('x-scene-render-token') || '';
  if (!expected) return NextResponse.json({ detail: 'Scene renderer not configured' }, { status: 503 });
  if (Buffer.byteLength(expected) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 256 * 1024) return NextResponse.json({ detail: 'Scene is too large' }, { status: 413 });
  let body;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ detail: 'Invalid JSON' }, { status: 400 }); }
  if (!body || body.version !== SCENE_RENDER_VERSION || !isSceneData(body.sceneData)) return NextResponse.json({ detail: 'Invalid scene or renderer version' }, { status: 400 });
  if (slot.fpcSceneRenderBusy) return NextResponse.json({ detail: 'Scene renderer busy' }, { status: 429, headers: { 'Retry-After': '3' } });
  slot.fpcSceneRenderBusy = true;
  try {
    const mp4 = await renderSceneMp4(body.sceneData);
    return new Response(new Uint8Array(mp4), { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Scene-Renderer': SCENE_RENDER_VERSION } });
  } catch (error) {
    console.error('Scene MP4 render failed', error);
    return NextResponse.json({ detail: 'Scene MP4 render failed' }, { status: 503 });
  } finally {
    slot.fpcSceneRenderBusy = false;
  }
}
