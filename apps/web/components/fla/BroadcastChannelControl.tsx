'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { obsList } from '../../lib/broadcast-obs';

type ChannelMatch = { match_id: string; home_team: string; away_team: string; status: string };
type Channel = { match: ChannelMatch | null };

/** Shared by the FLA control and the showroom; writes require an FPC session. */
export default function BroadcastChannelControl({ matchId, canWrite = true }: { matchId: string; canWrite?: boolean }) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const requestVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const response = await fetch('/api/broadcast/v1/channels/uccc', {cache:'no-store', credentials:'include'});
      if (!response.ok) throw new Error('고정 링크 연결 상태를 불러오지 못했습니다.');
      const next = await response.json();
      if (version === requestVersion.current) { setChannel(next); setError(''); }
    } catch (e) { if (version === requestVersion.current) setError(e instanceof Error ? e.message : '연결 상태를 불러오지 못했습니다.'); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(load, 15_000); return () => window.clearInterval(timer); }, [load]);
  const select = async () => {
    if (!channel || busy || !canWrite) return;
    const previous = channel.match;
    if (previous && previous.match_id !== matchId && !window.confirm(`현재 고정 링크: ${previous.home_team} vs ${previous.away_team}\n\n이 경기로 전환할까요? OBS에 연결된 고정 주소의 화면이 바뀝니다.`)) return;
    ++requestVersion.current;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/broadcast/v1/channels/uccc/select', {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify({match_id:matchId, expected_match_id:previous?.match_id || null})});
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(response.status === 401 ? '고정 링크를 변경하려면 FPC에 로그인해 주세요.' : body.detail || '고정 링크를 전환하지 못했습니다.');
      }
      ++requestVersion.current;
      setChannel(await response.json());
    } catch (e) { setError(e instanceof Error ? e.message : '고정 링크를 전환하지 못했습니다.'); }
    finally {setBusy(false);}
  };
  const copy = async () => {
    try {
      const origin = window.location.hostname.endsWith('fineludens.kr') ? 'https://broadcast.fineludens.kr' : window.location.origin;
      await navigator.clipboard.writeText(obsList('uccc', origin)); setCopied(true); window.setTimeout(() => setCopied(false), 2000);
    } catch { setError('복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.'); }
  };
  return <section className="broadcast-channel-control" aria-label="UCCC 고정 OBS 링크">
    <strong>UCCC 고정 OBS 링크</strong>
    <p>OBS에는 고정 주소를 한 번만 넣고, 다음 경기의 FLA에서 이 경기를 연결하세요. OBS 화면은 최대 15초 후 바뀌며, 새 그래픽이 아직 없으면 투명하게 대기합니다.</p>
    <p>현재 연결: {channel === null ? '확인 중…' : channel.match ? `${channel.match.home_team} vs ${channel.match.away_team}${channel.match.match_id === matchId ? ' (이 경기)' : ''}` : '선택된 경기 없음'}</p>
    <div className="broadcast-channel-actions">
      <button type="button" disabled={!channel || !canWrite || busy || channel.match?.match_id === matchId} onClick={select}>{channel?.match?.match_id === matchId ? '이 경기 연결됨' : busy ? '전환 중…' : '이 경기를 고정 링크에 연결'}</button>
      <button type="button" onClick={copy}>{copied ? '복사됨' : '고정 OBS 링크 전체 복사'}</button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {!canWrite ? <p>경기 운영권이 있어야 전환할 수 있습니다.</p> : null}
  </section>;
}
