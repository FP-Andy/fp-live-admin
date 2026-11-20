'use client';

import { useEffect, useState } from 'react';

type Graphic = { combined_url?: string; generated_at?: string };

/** A transparent HTML browser source; loading a PNG directly invokes the browser image viewer. */
export function BroadcastObsOverlay({ matchId, locator }: { matchId: string; locator: string[] }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const locatorKey = locator.join('/');

  useEffect(() => {
    let active = true;
    let currentMatch: string | null | undefined;
    let timer: number;
    const update = async () => {
      try {
        const channel = matchId === 'uccc';
        const response = await fetch(channel ? '/api/broadcast/v1/channels/uccc' : `/api/broadcast/v1/matches/${encodeURIComponent(matchId)}`, { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json();
        if (!active) return;
        const data = channel ? payload.match : payload;
        if (channel) {
          const nextMatch = data?.match_id || null;
          if (nextMatch !== currentMatch) {
            currentMatch = nextMatch;
            // A new fixture may have no image yet. Never keep the previous
            // fixture on air while waiting for the first render.
            setImageUrl(null);
          }
        }
        if (!data) return;
        let graphic: unknown = data.assets;
        for (const part of locatorKey.split('/')) {
          if (!graphic || typeof graphic !== 'object') return;
          graphic = (graphic as Record<string, unknown>)[part];
        }
        const asset = graphic as Graphic | null;
        if (!asset?.combined_url || !active) return;
        const url = new URL(asset.combined_url, window.location.origin);
        // Force a new image request only when the server publishes new data.
        if (asset.generated_at) url.searchParams.set('obs', asset.generated_at);
        setImageUrl(url.toString());
      } catch {
        // Keep the last successful image visible during temporary network errors.
      } finally {
        if (active) timer = window.setTimeout(update, 15_000);
      }
    };
    void update();
    return () => { active = false; window.clearTimeout(timer); };
  }, [matchId, locatorKey]);

  return <>
    <style>{`html, body { margin: 0 !important; width: 100%; height: 100%; overflow: hidden; background: transparent !important; } body::before, body::after { display: none !important; }`}</style>
    {imageUrl ? <img key={imageUrl} src={imageUrl} alt="" style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} /> : null}
  </>;
}
