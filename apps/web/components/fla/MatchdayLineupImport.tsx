'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

type Side = 'HOME' | 'AWAY';
type Player = { number: string; name: string; position?: string; isSubstitute?: boolean };
type Fixture = { matchId: number; matchName: string | null; homeTeamName: string | null; awayTeamName: string | null; scheduledAt: string | null; stage: string };
type Preview = { fixture: Fixture; teams: Record<Side, Player[]>; current_teams: Record<Side, Player[]>; current_names: Record<Side, string>; teams_known: boolean; names_changed: boolean; has_records: boolean; linked_match_id: number | null; roster_ready: boolean; errors: string[]; fingerprint: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : '매치데이 요청에 실패했습니다. 잠시 후 다시 시도하세요.');
  }
  return response.json();
}

function playerList(players: Player[]) {
  return players.length ? players.map((p) => `${p.number || '?'} ${p.name}${p.position ? ` (${p.position})` : ''}${p.isSubstitute ? ' [교체]' : ''}`).join(' · ') : '없음';
}

export default function MatchdayLineupImport({ matchId, match, canWrite, onApplied }: { matchId: string; match: any; canWrite: boolean; onApplied: (match: any) => void }) {
  const [open, setOpen] = useState(false);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const linked = match?.metadata?.matchday?.match_id;
  const base = `/matches/${matchId}/matchday`;

  async function loadFixtures(refresh = false) {
    setBusy(true); setError(''); setPreview(null);
    try {
      const data = await request<{fixtures: Fixture[]}>(`${base}/fixtures${refresh ? '?refresh=true' : ''}`);
      setFixtures(data.fixtures);
      if (linked && data.fixtures.some(f => f.matchId === linked)) setSelected(String(linked));
    } catch (e) { setError(e instanceof Error ? e.message : '경기 목록을 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (open) void loadFixtures(); }, [open, matchId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadPreview() {
    if (!selected) return;
    setBusy(true); setError(''); setMessage(''); setPreview(null); setConfirmed(false);
    try { setPreview(await request<Preview>(`${base}/fixtures/${selected}/preview`)); }
    catch (e) { setError(e instanceof Error ? e.message : '명단을 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const result = await request<{match: any; roster_imported: boolean}>(`${base}/apply`, { method: 'POST', body: JSON.stringify({match_id: preview.fixture.matchId, fingerprint: preview.fingerprint}) });
      onApplied(result.match); setPreview(null); setConfirmed(false);
      setMessage(result.roster_imported ? '홈·어웨이 팀과 경기 명단을 반영했습니다.' : '경기를 연결했습니다. 준비된 양쪽 명단이 없어 기존 명단은 유지했습니다.');
    } catch (e) { setError(e instanceof Error ? e.message : '반영하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  const hasCurrent = !!preview && (preview.current_teams.HOME.length > 0 || preview.current_teams.AWAY.length > 0);
  const blockedByRecords = !!preview && preview.has_records && (preview.names_changed || (!!preview.linked_match_id && preview.linked_match_id !== preview.fixture.matchId));
  const blockedByExisting = !!preview && preview.names_changed && hasCurrent && !preview.roster_ready;
  const needsConfirm = !!preview && (preview.names_changed || (preview.roster_ready && hasCurrent) || (preview.has_records && !preview.linked_match_id));
  return <div className="matchday-import" style={{border: '1px solid #3a4553', borderRadius: 8, padding: 12, margin: '12px 0'}}>
    <div className="match-lineup-action-row">
      <strong>MatchDay 경기 명단</strong>
      <button type="button" className="btn-secondary" onClick={() => setOpen(!open)}>{open ? '닫기' : linked ? '연결 경기 · 명단 다시 불러오기' : 'UCCC 경기 선택'}</button>
      {linked ? <span className="muted">연결된 경기 #{linked}</span> : null}
    </div>
    {open ? <div>
      <p className="muted">예선과 본선 전체 경기 중에서 선택합니다. 명단은 준비된 후 다시 불러올 수 있습니다.</p>
      <div className="match-lineup-action-row">
        <label htmlFor="matchday-fixture">매치데이 경기</label>
        <select id="matchday-fixture" value={selected} disabled={busy} onChange={e => {setSelected(e.target.value); setPreview(null); setMessage(''); setConfirmed(false);}}>
          <option value="">경기를 선택하세요</option>
          {['qualifying', 'finals'].map(stage => <optgroup key={stage} label={stage === 'qualifying' ? '조별 경기' : '본선'}>
            {fixtures.filter(f => f.stage === stage).map(f => <option value={f.matchId} key={f.matchId}>{f.scheduledAt ? f.scheduledAt.replace('T', ' ') + ' · ' : ''}{f.matchName || `경기 ${f.matchId}`} · {f.homeTeamName || '미정'} vs {f.awayTeamName || '미정'}</option>)}
          </optgroup>)}
        </select>
        <button type="button" className="btn-secondary" disabled={busy || !selected} onClick={loadPreview}>{busy ? '불러오는 중…' : '경기 · 명단 조회'}</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => loadFixtures(true)}>경기 목록 새로고침</button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {preview ? <div style={{marginTop: 12}}>
        <strong>반영할 경기: {preview.fixture.homeTeamName || '미정'} vs {preview.fixture.awayTeamName || '미정'}</strong>
        {!preview.teams_known ? <p>대진이 아직 정해지지 않았습니다. 연결 후 팀이 확정되면 다시 조회해 주세요.</p> : null}
        {!preview.roster_ready ? <p>양쪽 명단이 모두 준비되지 않았거나 확인이 필요합니다. 기존 명단은 유지됩니다.</p> : null}
        {preview.errors.map((item, i) => <p role="alert" key={i}>{item}</p>)}
        {(['HOME', 'AWAY'] as Side[]).map(side => <div key={side} style={{margin: '10px 0'}}>
          <b>{side === 'HOME' ? '홈' : '어웨이'} · 현재 {preview.current_names[side]} → {side === 'HOME' ? preview.fixture.homeTeamName || '미정' : preview.fixture.awayTeamName || '미정'}</b>
          <div className="muted">현재 명단 ({preview.current_teams[side].length}명): {playerList(preview.current_teams[side])}</div>
          <div>매치데이 명단 ({preview.teams[side].length}명): {playerList(preview.teams[side])}</div>
        </div>)}
        {blockedByRecords ? <p role="alert">경기 기록이 있어 다른 홈·어웨이 경기로 변경할 수 없습니다.</p> : null}
        {blockedByExisting ? <p role="alert">기존 명단이 있어 새 팀의 명단이 준비되기 전에는 팀을 변경할 수 없습니다.</p> : null}
        {needsConfirm && !blockedByRecords && !blockedByExisting ? <label style={{display: 'block', margin: '10px 0'}}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> 위 팀과 명단을 확인했습니다. 표시된 변경 사항을 반영합니다.</label> : null}
        <button type="button" className="btn-secondary" disabled={!canWrite || busy || blockedByRecords || blockedByExisting || (needsConfirm && !confirmed)} onClick={apply}>{busy ? '반영 중…' : preview.roster_ready ? '경기 연결 및 명단 반영' : '경기 연결'}</button>
        {!canWrite ? <p className="muted">명단 반영에는 경기 운영권이 필요합니다.</p> : null}
      </div> : null}
    </div> : null}
  </div>;
}
