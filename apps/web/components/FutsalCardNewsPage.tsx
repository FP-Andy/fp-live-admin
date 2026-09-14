'use client';

import { toPng } from 'html-to-image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '../lib/api';

type Team = 'HOME' | 'AWAY';
type Position = 'PIVO' | 'ALA' | 'FIXO' | 'GOLEIRO';
type Match = {
  id: string;
  name: string;
  archived: boolean;
  competition_class?: string;
  round_number?: number;
  metadata?: {
    home_team?: string;
    away_team?: string;
    lineups?: {
      teams?: Partial<Record<Team, Array<{ number: string; name: string; position?: string }>>>;
    };
  };
};
type MatchPage = { items: Match[]; total: number };
type FpaRow = { Player?: string; Team?: string; Action?: string; Tags?: string; xG?: string | number; ShotThreat?: string | number };
type FpaLog = { rows?: FpaRow[]; teamid_h?: string; teamid_a?: string };
type FlaEvent = { team: Team; player_number?: string | null; player_name?: string | null; is_goal?: boolean; xg?: number | null };
type Axis = { label: string; value: number };
type TargetMatch = { matchId: string; playerNumber: string; side: Team };
type LoadedTargetMatch = { matchId: string; fpa: FpaLog; events: FlaEvent[] };

const POSITION_LABEL: Record<Position, string> = { PIVO: '피보', ALA: '알라', FIXO: '픽소', GOLEIRO: '골레이로' };
const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const has = (row: FpaRow, value: string) => `${row.Action || ''} ${row.Tags || ''}`.toLowerCase().includes(value.toLowerCase());
const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function playerAxes(rows: FpaRow[], events: FlaEvent[], playerNumber: string, side: Team, position: Position, matchCount = 1): Axis[] {
  const mine = rows.filter((row) => String(row.Player || '').trim() === playerNumber);
  const actionCount = (action: string) => mine.filter((row) => has(row, action)).length;
  const passRows = mine.filter((row) => has(row, 'pass') || has(row, 'kick-in'));
  const passSuccess = passRows.filter((row) => has(row, 'success') || has(row, 'retained')).length;
  const shotThreat = mine.reduce((sum, row) => sum + numberValue(row.ShotThreat || row.xG), 0);
  const goals = events.filter((event) => event.team === side && event.is_goal && String(event.player_number || '') === playerNumber).length
    + mine.filter((row) => has(row, 'goal')).length;
  const shots = actionCount('shot');
  const key = mine.filter((row) => has(row, 'key pass') || has(row, 'assist')).length;
  const dribble = actionCount('dribble') + actionCount('breakthrough');
  const duel = actionCount('duel');
  const defense = ['intercept', 'tackle', 'block', 'cutout', 'clear'].reduce((sum, action) => sum + actionCount(action), 0);
  const longKick = mine.filter((row) => has(row, 'long kick')).length;
  const saves = actionCount('save') + actionCount('catch') + actionCount('punch');
  const passRate = passRows.length ? passSuccess / passRows.length : 0;
  // 카드가 여러 경기 데이터를 합산해도 경기 수만큼 점수가 자동 상승하면 안 된다.
  // 100은 '해당 포지션에서 그 경기들을 지배한 수준'에만 닿도록 경기당 평균으로 환산한다.
  const sample = Math.max(1, matchCount);
  const perMatch = (value: number) => value / sample;
  const values = {
    finish: clamp(perMatch(goals) * 30 + perMatch(shotThreat) * 28),
    shoot: clamp(perMatch(shots) * 8 + perMatch(shotThreat) * 20),
    create: clamp(perMatch(key) * 17 + perMatch(passSuccess) * 2.5),
    link: clamp(passRate * 36 + Math.min(perMatch(passSuccess), 15) * 2),
    dribble: clamp(perMatch(dribble) * 12), duel: clamp(perMatch(duel) * 11), defense: clamp(perMatch(defense) * 9),
    longKick: clamp(perMatch(longKick) * 16 + Math.min(perMatch(passSuccess), 15) * 2),
    save: clamp(perMatch(saves) * 18), sweep: clamp(perMatch(defense) * 6 + perMatch(duel) * 7),
  };
  if (position === 'PIVO') return [{ label: '결정력', value: values.finish }, { label: '슈팅 위협', value: values.shoot }, { label: '찬스 연결', value: values.create }, { label: '연계', value: values.link }, { label: '경합', value: values.duel }, { label: '수비', value: values.defense }];
  if (position === 'FIXO') return [{ label: '수비 회수', value: values.defense }, { label: '경합', value: values.duel }, { label: '전개 연결', value: values.link }, { label: '롱킥', value: values.longKick }, { label: '슈팅 위협', value: values.shoot }, { label: '찬스 연결', value: values.create }];
  if (position === 'GOLEIRO') return [{ label: '선방', value: values.save }, { label: '빌드업', value: values.link }, { label: '스위핑', value: values.sweep }, { label: '롱킥', value: values.longKick }, { label: '1:1 대응', value: clamp(values.save * .7 + values.duel * .3) }, { label: '수비 기여', value: values.defense }];
  return [{ label: '슈팅 위협', value: values.shoot }, { label: '찬스 연결', value: values.create }, { label: '전개 연결', value: values.link }, { label: '돌파', value: values.dribble }, { label: '경합', value: values.duel }, { label: '수비', value: values.defense }];
}

function Radar({ axes }: { axes: Axis[] }) {
  const points = axes.map((axis, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / axes.length;
    const radius = 84 * axis.value / 100;
    return `${120 + Math.cos(angle) * radius},${120 + Math.sin(angle) * radius}`;
  }).join(' ');
  return <svg className="queen-card-radar" viewBox="0 0 240 240" aria-label="6축 평가 그래프">
    {[30, 57, 84].map((radius) => <circle key={radius} cx="120" cy="120" r={radius} fill="none" stroke="rgba(255,255,255,.24)" />)}
    {axes.map((axis, index) => { const a = -Math.PI / 2 + (Math.PI * 2 * index) / axes.length; return <g key={axis.label}><line x1="120" y1="120" x2={120 + Math.cos(a) * 84} y2={120 + Math.sin(a) * 84} stroke="rgba(255,255,255,.24)" /><text x={120 + Math.cos(a) * 108} y={124 + Math.sin(a) * 108} textAnchor="middle">{axis.label}</text></g>; })}
    <polygon points={points} fill="rgba(255,138,1,.4)" stroke="#ffb14b" strokeWidth="3" />
  </svg>;
}

export default function FutsalCardNewsPage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [targets, setTargets] = useState<TargetMatch[]>([]);
  const [loadedMatches, setLoadedMatches] = useState<LoadedTargetMatch[]>([]);
  const [playerName, setPlayerName] = useState('');
  const [position, setPosition] = useState<Position>('ALA');
  const [status, setStatus] = useState('');
  const [downloading, setDownloading] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    apiJson<MatchPage>('/matches/page?sport=FUTSAL&limit=100&compact=true')
      .then((data) => {
        const rows = Array.isArray(data.items) ? data.items : [];
        setMatches(rows);
        if (rows[0]) setTargets((current) => current.length ? current : [{ matchId: rows[0].id, playerNumber: '', side: 'HOME' }]);
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : '풋살 경기를 불러오지 못했습니다.'));
  }, []);
  const targetIds = useMemo(() => targets.map((target) => target.matchId).join(','), [targets]);
  useEffect(() => {
    const ids = targets.map((target) => target.matchId);
    if (!ids.length) { setLoadedMatches([]); return; }
    let cancelled = false;
    Promise.all(ids.map(async (matchId) => {
      const [fpa, eventData] = await Promise.all([
        apiJson<FpaLog>(`/fpa/matches/${matchId}/logs`).catch(() => ({})),
        apiJson<{ events: FlaEvent[] }>(`/matches/${matchId}/events`).catch(() => ({ events: [] })),
      ]);
      return { matchId, fpa, events: eventData.events || [] };
    })).then((data) => { if (!cancelled) setLoadedMatches(data); });
    return () => { cancelled = true; };
  }, [targetIds]);
  const matchById = useMemo(() => new Map(matches.map((match) => [match.id, match])), [matches]);
  const dataByMatch = useMemo(() => new Map(loadedMatches.map((data) => [data.matchId, data])), [loadedMatches]);
  const updateTarget = (matchId: string, patch: Partial<TargetMatch>) => setTargets((current) => current.map((target) => target.matchId === matchId ? { ...target, ...patch } : target));
  const toggleTarget = (matchId: string) => setTargets((current) => {
    const existing = current.find((target) => target.matchId === matchId);
    if (existing) return current.filter((target) => target.matchId !== matchId);
    if (current.length >= 5) { setStatus('선수 카드에는 대상 경기를 최대 5개까지 선택할 수 있습니다.'); return current; }
    setStatus('');
    return [...current, { matchId, playerNumber: current[0]?.playerNumber || '', side: current[0]?.side || 'HOME' }];
  });
  const aggregate = useMemo(() => {
    const rows: FpaRow[] = [];
    const events: FlaEvent[] = [];
    targets.forEach((target) => {
      const number = target.playerNumber.trim();
      const loaded = dataByMatch.get(target.matchId);
      if (!number || !loaded) return;
      rows.push(...(loaded.fpa.rows || []).filter((row) => String(row.Player || '').trim() === number).map((row) => ({ ...row, Player: '__CARD_PLAYER__' })));
      events.push(...loaded.events.filter((event) => event.team === target.side && event.is_goal && String(event.player_number || '').trim() === number).map((event) => ({ ...event, team: 'HOME' as Team, player_number: '__CARD_PLAYER__' })));
    });
    return { rows, events };
  }, [dataByMatch, targets]);
  const primaryTarget = targets[0];
  const primaryMatch = primaryTarget ? matchById.get(primaryTarget.matchId) : null;
  const primaryData = primaryTarget ? dataByMatch.get(primaryTarget.matchId) : null;
  const suggestedPlayer = primaryTarget && primaryMatch
    ? (primaryMatch.metadata?.lineups?.teams?.[primaryTarget.side] || []).find((item) => item.number === primaryTarget.playerNumber)
    : undefined;
  const displayName = playerName.trim() || suggestedPlayer?.name || '선수';
  const teamName = primaryTarget?.side === 'AWAY'
    ? primaryMatch?.metadata?.away_team || primaryData?.fpa.teamid_a || 'AWAY'
    : primaryMatch?.metadata?.home_team || primaryData?.fpa.teamid_h || 'HOME';
  const sampledMatchCount = targets.filter((target) => target.playerNumber.trim()).length;
  const axes = useMemo(() => playerAxes(aggregate.rows, aggregate.events, '__CARD_PLAYER__', 'HOME', position, sampledMatchCount), [aggregate, position, sampledMatchCount]);
  const download = async () => { if (!cardRef.current || !targets.some((target) => target.playerNumber.trim())) return; setDownloading(true); try { const png = await toPng(cardRef.current, { backgroundColor: '#071b34', cacheBust: true, pixelRatio: 2 }); const link = document.createElement('a'); link.href = png; link.download = `queen-cup-${teamName}-${displayName}.png`; link.click(); } catch { setStatus('이미지 생성에 실패했습니다.'); } finally { setDownloading(false); } };
  return <main className="page-stack queen-card-page">
    <section className="card card-hero page-hero"><div className="section-heading"><div><div className="sidebar-eyebrow">FCM · Futsal</div><h2 style={{ margin: '6px 0 0' }}>Queen Cup 선수 카드뉴스</h2></div><span className="status-pill tech">Instagram 1080 × 1350</span></div><p className="field-help">최대 5경기의 FPA 로그와 FLA 득점을 합산해 한 선수의 포지션별 6축 카드를 만듭니다. 경기마다 실제 등번호와 팀을 지정하세요.</p></section>
    <section className="queen-card-workspace"><aside className="card card-panel queen-card-controls"><div className="field-stack"><span className="field-label">대상 경기 · 최대 5개</span><div className="queen-card-match-list">{matches.map((match) => { const checked = targets.some((target) => target.matchId === match.id); return <label className="queen-card-match-choice" key={match.id}><input checked={checked} disabled={!checked && targets.length >= 5} onChange={() => toggleTarget(match.id)} type="checkbox" /><span>{match.name}</span></label>; })}</div></div><div className="queen-card-targets">{targets.map((target, index) => { const match = matchById.get(target.matchId); const numbers = Array.from(new Set((dataByMatch.get(target.matchId)?.fpa.rows || []).map((row) => String(row.Player || '').trim()).filter(Boolean))); return <div className="queen-card-target" key={target.matchId}><strong>{index + 1}. {match?.name || '경기'}</strong><div><label>팀<select value={target.side} onChange={(e) => updateTarget(target.matchId, { side: e.target.value as Team })}><option value="HOME">홈</option><option value="AWAY">어웨이</option></select></label><label>등번호<input list={`futsal-player-numbers-${target.matchId}`} onChange={(e) => updateTarget(target.matchId, { playerNumber: e.target.value })} placeholder="예: 10" value={target.playerNumber} /><datalist id={`futsal-player-numbers-${target.matchId}`}>{numbers.map((number) => <option key={number} value={number} />)}</datalist></label></div></div>; })}</div><label className="field-stack"><span className="field-label">카드 선수명</span><input onChange={(e) => setPlayerName(e.target.value)} placeholder={suggestedPlayer?.name || '선수명 입력 (선택)'} value={playerName} /></label><label className="field-stack"><span className="field-label">카드 포지션</span><select value={position} onChange={(e) => setPosition(e.target.value as Position)}>{(Object.keys(POSITION_LABEL) as Position[]).map((item) => <option key={item} value={item}>{POSITION_LABEL[item]}</option>)}</select></label><button className="btn-primary" disabled={!targets.some((target) => target.playerNumber.trim()) || downloading} onClick={() => void download()} type="button">{downloading ? 'PNG 생성 중…' : '인스타 PNG 다운로드'}</button><p className="field-help">각 경기의 등번호가 달라도 같은 선수로 합산됩니다. 저장된 FPA 로그의 등번호는 자동완성 목록에서 고를 수 있습니다.</p>{status ? <p className="field-help" style={{ color: '#ff9c8f' }}>{status}</p> : null}</aside>
      <section className="queen-card-preview-wrap"><div className="queen-card-preview" ref={cardRef}><div className="queen-card-top"><span>QUEEN CUP · {targets.length} MATCH{targets.length === 1 ? '' : 'ES'}</span><strong>PLAYER PERFORMANCE</strong></div><div className="queen-card-player"><span>{teamName}</span><h1>{displayName}</h1><p>NO. {targets.map((target) => target.playerNumber || '—').join(' / ')} · {POSITION_LABEL[position]}</p></div><Radar axes={axes} /><div className="queen-card-axis-grid">{axes.map((axis) => <div key={axis.label}><span>{axis.label}</span><strong>{axis.value}</strong></div>)}</div><div className="queen-card-footer"><span>FINE PLAY ANALYTICS</span><span>FLA + FPA DATA · {targets.length} MATCHES</span></div></div></section>
    </section>
  </main>;
}
