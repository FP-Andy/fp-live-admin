'use client';

import { useState } from 'react';

type Score = { home: number; away: number };

export default function FulltimeDominanceRefresh({matchId, onUpdated}: {matchId: string; onUpdated: () => void}) {
  const [score, setScore] = useState<Score | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const inspect = async () => {
    setBusy(true); setMessage(''); setScore(null);
    try {
      const response = await fetch(`/api/broadcast/matches/${matchId}/snapshot`, {cache:'no-store'});
      if (!response.ok) throw new Error('경기 점수를 불러오지 못했습니다.');
      const data = await response.json();
      const home = data?.match?.home?.score, away = data?.match?.away?.score;
      if (!Number.isInteger(home) || !Number.isInteger(away)) throw new Error('경기 점수를 확인할 수 없습니다.');
      setScore({home, away});
    } catch (error) { setMessage(error instanceof Error ? error.message : '점수를 확인하지 못했습니다.'); }
    finally {setBusy(false);}
  };
  const refresh = async () => {
    if (!score) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/broadcast/matches/${matchId}/dominance/fulltime/refresh`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({home_score:score.home,away_score:score.away})});
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(response.status === 401 ? '관리자로 로그인해 주세요.' : data.detail || '그래픽을 다시 만들지 못했습니다.');
      }
      setScore(null); setMessage('풀경기 매치 도미넌스만 갱신했습니다.'); onUpdated();
    } catch (error) { setMessage(error instanceof Error ? error.message : '그래픽을 다시 만들지 못했습니다.'); }
    finally {setBusy(false);}
  };
  return <div className="broadcast-obs-copy">
    <button type="button" disabled={busy} onClick={inspect}>{busy ? '확인 중…' : '풀경기 도미넌스 점수 확인'}</button>
    {score ? <p>현재 경기 기록: {score.home} : {score.away} <button type="button" disabled={busy} onClick={refresh}>{busy ? '생성 중…' : `${score.home} : ${score.away}로 풀경기 그래픽만 갱신`}</button></p> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
