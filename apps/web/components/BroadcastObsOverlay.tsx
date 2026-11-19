'use client';

import { useEffect, useState } from 'react';

type Graphic = { combined_url?: string; generated_at?: string };

/** A transparent HTML browser source; loading a PNG directly invokes the browser image viewer. */
export function BroadcastObsOverlay({ matchId, locator }: { matchId: string; locator: string[] }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const locatorKey = locator.join('/');

  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const response = await fetch(`/api/broadcast/v1/matches/${encodeURIComponent(matchId)}`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
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
      }
    };
    void update();
    const timer = window.setInterval(update, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [matchId, locatorKey]);

  return <>
    <style>{`html, body { margin: 0 !important; width: 100%; height: 100%; overflow: hidden; background: transparent !important; } body::before, body::after { display: none !important; }`}</style>
    {imageUrl ? <img src={imageUrl} alt="" style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} /> : null}
  </>;
}
