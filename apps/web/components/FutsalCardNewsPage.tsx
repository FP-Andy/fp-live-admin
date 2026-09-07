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

const POSITION_LABEL: Record<Position, string> = { PIVO: '피보', ALA: '알라', FIXO: '픽소', GOLEIRO: '골레이로' };
const positionFromLineup = (value?: string): Position => {
  const text = String(value || '').toUpperCase();
  if (text === 'GK' || text.includes('GOLE')) return 'GOLEIRO';
  if (text === 'DF' || text.includes('FIX')) return 'FIXO';
  if (text === 'FW' || text.includes('PIVO')) return 'PIVO';
  return 'ALA';
};
const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const has = (row: FpaRow, value: string) => `${row.Action || ''} ${row.Tags || ''}`.toLowerCase().includes(value.toLowerCase());
const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function playerAxes(rows: FpaRow[], events: FlaEvent[], playerNumber: string, side: Team, position: Position): Axis[] {
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
  const values = {
    finish: clamp(goals * 45 + shotThreat * 45), shoot: clamp(shots * 20 + shotThreat * 32),
    create: clamp(key * 35 + passSuccess * 7), link: clamp(passRate * 65 + passSuccess * 4),
    dribble: clamp(dribble * 22), duel: clamp(duel * 24), defense: clamp(defense * 20),
    longKick: clamp(longKick * 28 + passSuccess * 4), save: clamp(saves * 24), sweep: clamp(defense * 16 + duel * 12),
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
  const [matchId, setMatchId] = useState('');
  const [side, setSide] = useState<Team>('HOME');
  const [player, setPlayer] = useState('');
  const [position, setPosition] = useState<Position>('ALA');
  const [fpa, setFpa] = useState<FpaLog>({});
  const [events, setEvents] = useState<FlaEvent[]>([]);
  const [status, setStatus] = useState('');
  const [downloading, setDownloading] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => { apiJson<MatchPage>('/matches/page?sport=FUTSAL&limit=100&compact=true').then((data) => { const rows = Array.isArray(data.items) ? data.items : []; setMatches(rows); setMatchId(rows[0]?.id || ''); }).catch((error) => setStatus(error instanceof Error ? error.message : '풋살 경기를 불러오지 못했습니다.')); }, []);
  const match = matches.find((item) => item.id === matchId) || null;
  const players = useMemo(() => {
    const lineup = match?.metadata?.lineups?.teams?.[side] || [];
    if (lineup.length) return lineup;
    // A card can still be made when the organiser did not upload a lineup:
    // use the player numbers actually tagged in the saved FPA match log.
    return Array.from(new Set((fpa.rows || []).map((row) => String(row.Player || '').trim()).filter(Boolean)))
      .map((number) => ({ number, name: '', position: undefined }));
  }, [fpa.rows, match, side]);
  const selected = players.find((item) => item.number === player) || players[0];
  useEffect(() => { setPlayer(players[0]?.number || ''); setPosition(positionFromLineup(players[0]?.position)); }, [matchId, side, players]);
  useEffect(() => { if (!matchId) return; Promise.all([apiJson<FpaLog>(`/fpa/matches/${matchId}/logs`).catch(() => ({})), apiJson<{ events: FlaEvent[] }>(`/matches/${matchId}/events`).catch(() => ({ events: [] }))]).then(([log, eventData]) => { setFpa(log); setEvents(eventData.events || []); }); }, [matchId]);
  const axes = useMemo(() => playerAxes(fpa.rows || [], events, selected?.number || '', side, position), [events, fpa.rows, position, selected?.number, side]);
  const teamName = side === 'HOME' ? match?.metadata?.home_team || fpa.teamid_h || 'HOME' : match?.metadata?.away_team || fpa.teamid_a || 'AWAY';
  const download = async () => { if (!cardRef.current) return; setDownloading(true); try { const png = await toPng(cardRef.current, { backgroundColor: '#071b34', cacheBust: true, pixelRatio: 2 }); const link = document.createElement('a'); link.href = png; link.download = `queen-cup-${teamName}-${selected?.number || 'player'}.png`; link.click(); } catch { setStatus('이미지 생성에 실패했습니다.'); } finally { setDownloading(false); } };
  return <main className="page-stack queen-card-page">
    <section className="card card-hero page-hero"><div className="section-heading"><div><div className="sidebar-eyebrow">FCM · Futsal</div><h2 style={{ margin: '6px 0 0' }}>Queen Cup 카드뉴스</h2></div><span className="status-pill tech">Instagram 1080 × 1350</span></div><p className="field-help">저장된 FPA 로그와 FLA 득점 기록을 합쳐 선수별 포지션 6축 카드로 만듭니다.</p></section>
    <section className="queen-card-workspace"><aside className="card card-panel queen-card-controls"><label className="field-stack"><span className="field-label">풋살 경기</span><select value={matchId} onChange={(e) => setMatchId(e.target.value)}>{matches.length ? matches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option>경기 없음</option>}</select></label><label className="field-stack"><span className="field-label">팀</span><select value={side} onChange={(e) => setSide(e.target.value as Team)}><option value="HOME">홈</option><option value="AWAY">어웨이</option></select></label><label className="field-stack"><span className="field-label">선수</span><select value={selected?.number || ''} onChange={(e) => { setPlayer(e.target.value); const found = players.find((item) => item.number === e.target.value); setPosition(positionFromLineup(found?.position)); }}>{players.map((item) => <option key={item.number} value={item.number}>No.{item.number} {item.name || '선수'}</option>)}</select></label><label className="field-stack"><span className="field-label">카드 포지션</span><select value={position} onChange={(e) => setPosition(e.target.value as Position)}>{(Object.keys(POSITION_LABEL) as Position[]).map((item) => <option key={item} value={item}>{POSITION_LABEL[item]}</option>)}</select></label><button className="btn-primary" disabled={!selected || downloading} onClick={() => void download()} type="button">{downloading ? 'PNG 생성 중…' : '인스타 PNG 다운로드'}</button><p className="field-help">역할을 바꾸면 같은 선수 데이터도 그 포지션의 6축 기준으로 다시 해석됩니다.</p>{status ? <p className="field-help" style={{ color: '#ff9c8f' }}>{status}</p> : null}</aside>
      <section className="queen-card-preview-wrap"><div className="queen-card-preview" ref={cardRef}><div className="queen-card-top"><span>QUEEN CUP</span><strong>PLAYER PERFORMANCE</strong></div><div className="queen-card-player"><span>{teamName}</span><h1>{selected?.name || '선수 선택'}</h1><p>NO. {selected?.number || '—'} · {POSITION_LABEL[position]}</p></div><Radar axes={axes} /><div className="queen-card-axis-grid">{axes.map((axis) => <div key={axis.label}><span>{axis.label}</span><strong>{axis.value}</strong></div>)}</div><div className="queen-card-footer"><span>FINE PLAY ANALYTICS</span><span>FLA + FPA DATA</span></div></div></section>
    </section>
  </main>;
}
