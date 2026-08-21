'use client';

import { useEffect, useState } from 'react';
import { BroadcastShowroomMatch } from './BroadcastShowroom';

type CompletedDemo = { match_id: string };

/**
 * The completed-match room must never draw a separate browser-only mock.  It
 * looks up the persisted fixture and delegates to the normal showroom, so all
 * previews and URLs are the exact PNG background/asset pairs used by a live
 * FLA match.
 */
export function BroadcastCompletedDemoRoom() {
  const [matchId, setMatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/broadcast/v1/demo-90m', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<CompletedDemo>;
      })
      .then((data) => {
        if (active) setMatchId(data.match_id);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '데모 데이터를 불러오지 못했습니다.');
      });
    return () => { active = false; };
  }, []);

  if (error) {
    return <main className="broadcast-showroom"><p className="broadcast-error">실제 렌더링 데모를 불러오지 못했습니다: {error}</p></main>;
  }
  if (!matchId) {
    return <main className="broadcast-showroom"><p className="broadcast-loading">실제 생성된 HD PNG 에셋을 불러오는 중입니다.</p></main>;
  }
  return <BroadcastShowroomMatch matchId={matchId} />;
}
