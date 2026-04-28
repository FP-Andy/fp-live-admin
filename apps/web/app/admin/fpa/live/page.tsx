'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, apiFetch } from '../../../../lib/api';
import { FPA_DRAFT_EVENT, FPA_DRAFT_STORAGE_KEY } from '../../../../components/FpaDraftGuard';

type PitchDot = {
  meter_x: number;
  meter_y: number;
  screen_x: number;
  screen_y: number;
};

type LogPreview = {
  Time: string;
  Team: string;
  Player: string;
  Action: string;
  Receiver: string;
  Coord: string;
  Tags: string;
};

function extractReceiveCoord(logText?: string) {
  if (!logText) return '';
  const matches = Array.from(logText.matchAll(/Pos\((.+?), (.+?)\)/g));
  if (matches.length < 2) return '';
  const [, x, y] = matches[matches.length - 1];
  return `Pos(${x}, ${y})`;
}

export default function FpaLivePage() {
  const didHydrateRef = useRef(false);
  const pitchRef = useRef<HTMLDivElement | null>(null);
  const logBodyRef = useRef<HTMLDivElement | null>(null);
  const statInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [half, setHalf] = useState<'1H' | '2H'>('1H');
  const [team, setTeam] = useState<'home' | 'away'>('home');
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [timeline, setTimeline] = useState('00:00');
  const [statInput, setStatInput] = useState('');
  const [dots, setDots] = useState<PitchDot[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [rows, setRows] = useState<LogPreview[]>([]);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [matchId, setMatchId] = useState('ID');
  const [teamIdH, setTeamIdH] = useState('Home');
  const [teamIdA, setTeamIdA] = useState('Away');
  const [status, setStatus] = useState('실시간 입력 준비됨');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || didHydrateRef.current) return;
    didHydrateRef.current = true;
    const raw = window.sessionStorage.getItem(FPA_DRAFT_STORAGE_KEY);
    if (!raw) return;

    try {
      const draft = JSON.parse(raw) as {
        half?: '1H' | '2H';
        team?: 'home' | 'away';
        direction?: 'left' | 'right';
        timeline?: string;
        statInput?: string;
        dots?: PitchDot[];
        logs?: string[];
        rows?: LogPreview[];
        selectedRowIndex?: number | null;
        matchId?: string;
        teamIdH?: string;
        teamIdA?: string;
      };

      if (draft.half) setHalf(draft.half);
      if (draft.team) setTeam(draft.team);
      if (draft.direction) setDirection(draft.direction);
      if (draft.timeline) setTimeline(draft.timeline);
      if (typeof draft.statInput === 'string') setStatInput(draft.statInput);
      if (Array.isArray(draft.dots)) setDots(draft.dots);
      if (Array.isArray(draft.logs)) setLogs(draft.logs);
      if (Array.isArray(draft.rows)) setRows(draft.rows);
      if (typeof draft.selectedRowIndex === 'number' || draft.selectedRowIndex === null) {
        setSelectedRowIndex(draft.selectedRowIndex);
      }
      if (typeof draft.matchId === 'string') setMatchId(draft.matchId);
      if (typeof draft.teamIdH === 'string') setTeamIdH(draft.teamIdH);
      if (typeof draft.teamIdA === 'string') setTeamIdA(draft.teamIdA);
      setStatus('이전 입력 상태를 복구했습니다');
    } catch {
      window.sessionStorage.removeItem(FPA_DRAFT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !didHydrateRef.current) return;

    const hasDraft =
      logs.length > 0 ||
      rows.length > 0 ||
      dots.length > 0 ||
      statInput.trim().length > 0 ||
      matchId !== 'ID' ||
      teamIdH !== 'Home' ||
      teamIdA !== 'Away';

    if (!hasDraft) {
      window.sessionStorage.removeItem(FPA_DRAFT_STORAGE_KEY);
      window.dispatchEvent(new CustomEvent(FPA_DRAFT_EVENT, { detail: { hasDraft: false } }));
      return;
    }

    const draft = {
      half,
      team,
      direction,
      timeline,
      statInput,
      dots,
      logs,
      rows,
      selectedRowIndex,
      matchId,
      teamIdH,
      teamIdA,
    };
    window.sessionStorage.setItem(FPA_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    window.dispatchEvent(new CustomEvent(FPA_DRAFT_EVENT, { detail: { hasDraft: true } }));
  }, [direction, dots, half, logs, matchId, rows, selectedRowIndex, statInput, team, teamIdA, teamIdH, timeline]);

  useEffect(() => {
    const logBody = logBodyRef.current;
    if (!logBody) return;
    logBody.scrollTop = logBody.scrollHeight;
  }, [rows.length]);

  const pitchDots = useMemo(
    () =>
      dots.map((dot, index) => ({
        ...dot,
        left: `${(dot.screen_x / 1050) * 100}%`,
        top: `${(dot.screen_y / 680) * 100}%`,
        label: String(index + 1),
      })),
    [dots]
  );

  const handlePitchClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = pitchRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
    const nextDot = {
      meter_x: Number(((x / rect.width) * 105).toFixed(2)),
      meter_y: Number((((rect.height - y) / rect.height) * 68).toFixed(2)),
      screen_x: Number(((x / rect.width) * 1050).toFixed(2)),
      screen_y: Number(((y / rect.height) * 680).toFixed(2)),
    };
    setDots((prev) => [...prev, nextDot]);
    statInputRef.current?.focus();
  };

  const removeLastDot = () => {
    setDots((prev) => prev.slice(0, -1));
  };

  const syncTeam = (nextTeam: 'home' | 'away') => {
    if (nextTeam === team) return;
    setTeam(nextTeam);
    setDirection((prev) => (prev === 'right' ? 'left' : 'right'));
  };

  const addLog = async () => {
    if (!statInput.trim()) return;
    setBusy(true);
    setStatus('로그 생성 중');

    try {
      const response = await apiFetch('/fpa/logs/generate', {
        method: 'POST',
        body: JSON.stringify({
          stat_input: statInput,
          dots,
          half,
          team,
          direction,
          timeline,
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || '로그 생성 실패');
        return;
      }

      const data = await response.json() as { log_text: string; log_data: LogPreview };
      setLogs((prev) => [...prev, data.log_text]);
      setRows((prev) => {
        const nextRows = [...prev, data.log_data];
        setSelectedRowIndex(nextRows.length - 1);
        return nextRows;
      });
      setStatInput('');
      setDots([]);
      setStatus('로그 추가 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  const exportWorkbook = async () => {
    if (!logs.length) return;
    setBusy(true);
    setStatus('분석 파일 생성 중');

    try {
      const response = await apiFetch('/fpa/analyze/export', {
        method: 'POST',
        body: JSON.stringify({
          logs,
          match_id: matchId,
          teamid_h: teamIdH,
          teamid_a: teamIdA,
        }),
      });

      if (!response.ok) {
        setStatus((await response.text()) || '엑셀 생성 실패');
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const disposition = response.headers.get('content-disposition') || '';
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
      link.href = url;
      link.download = fileNameMatch?.[1] || 'fpa_live_analyzed_data.xlsx';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setStatus('분석 및 내보내기 완료');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '엑셀 생성 실패');
    } finally {
      setBusy(false);
    }
  };

  const importWorkbook = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setStatus('기존 FPA 로그를 불러오는 중');

    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_BASE}/fpa/logs/import`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!response.ok) {
        setStatus((await response.text()) || '로그 불러오기 실패');
        return;
      }

      const data = await response.json() as {
        logs: string[];
        rows: LogPreview[];
        match_id: string;
        teamid_h: string;
        teamid_a: string;
      };
      setLogs(data.logs || []);
      setRows(data.rows || []);
      setSelectedRowIndex((data.rows || []).length ? 0 : null);
      if (data.match_id) setMatchId(data.match_id);
      if (data.teamid_h) setTeamIdH(data.teamid_h);
      if (data.teamid_a) setTeamIdA(data.teamid_a);
      setStatus(`로그 ${data.logs?.length || 0}건 불러오기 완료`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '로그 불러오기 실패');
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
      setBusy(false);
    }
  };

  const removeSelectedLog = () => {
    if (selectedRowIndex == null) return;
    setLogs((prev) => prev.filter((_, index) => index !== selectedRowIndex));
    setRows((prev) => {
      const nextRows = prev.filter((_, index) => index !== selectedRowIndex);
      if (!nextRows.length) {
        setSelectedRowIndex(null);
      } else if (selectedRowIndex >= nextRows.length) {
        setSelectedRowIndex(nextRows.length - 1);
      }
      setStatus('선택한 로그 삭제');
      return nextRows;
    });
  };

  const moveSelectedLog = (directionDelta: -1 | 1) => {
    if (selectedRowIndex == null) return;
    const nextIndex = selectedRowIndex + directionDelta;
    if (nextIndex < 0 || nextIndex >= rows.length) return;

    const reorder = <T,>(items: T[]) => {
      const nextItems = [...items];
      const [picked] = nextItems.splice(selectedRowIndex, 1);
      nextItems.splice(nextIndex, 0, picked);
      return nextItems;
    };

    setLogs((prev) => reorder(prev));
    setRows((prev) => reorder(prev));
    setSelectedRowIndex(nextIndex);
    setStatus(directionDelta < 0 ? '선택한 로그를 위로 이동' : '선택한 로그를 아래로 이동');
  };

  const adjustTimeline = (deltaSeconds: number) => {
    const [minutesRaw, secondsRaw] = timeline.split(':');
    const minutes = Number(minutesRaw || 0);
    const seconds = Number(secondsRaw || 0);
    const next = Math.max(0, minutes * 60 + seconds + deltaSeconds);
    const mm = String(Math.floor(next / 60)).padStart(2, '0');
    const ss = String(next % 60).padStart(2, '0');
    setTimeline(`${mm}:${ss}`);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.tagName === 'INPUT' && target.id !== 'fpa-live-timeline' && target.id !== 'fpa-live-stat-input') {
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        event.preventDefault();
        adjustTimeline(60);
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        event.preventDefault();
        adjustTimeline(-60);
        return;
      }

      if (event.key === 'Enter' && document.activeElement?.id === 'fpa-live-stat-input') {
        event.preventDefault();
        void addLog();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [timeline, statInput, dots, half, team, direction, busy]);

  return (
    <div className="page-stack">
      <section className="fpa-live-shell">
        <div className="fpa-live-brand">
          <span className="fpa-live-brandmark">F</span>
          <span>Fine Play Analytics</span>
        </div>

        <div className="fpa-live-meta">
          <label className="fpa-live-meta-field">
            <span>Home Team</span>
            <input value={teamIdH} onChange={(event) => setTeamIdH(event.target.value)} placeholder="Home" />
          </label>
          <label className="fpa-live-meta-field">
            <span>Away Team</span>
            <input value={teamIdA} onChange={(event) => setTeamIdA(event.target.value)} placeholder="Away" />
          </label>
          <label className="fpa-live-meta-field">
            <span>Match ID</span>
            <input value={matchId} onChange={(event) => setMatchId(event.target.value)} placeholder="ID" />
          </label>
          <div className="fpa-live-meta-field">
            <span>Half</span>
            <div className="fpa-segmented">
              <button className={half === '1H' ? 'active' : ''} onClick={() => setHalf('1H')} type="button">1st</button>
              <button className={half === '2H' ? 'active' : ''} onClick={() => setHalf('2H')} type="button">2nd</button>
            </div>
          </div>
        </div>

        <div className="fpa-live-main">
          <section className="fpa-log-panel">
            <div className="fpa-panel-header">
              <div className="fpa-panel-title">기록된 로그</div>
              <div className="fpa-panel-actions">
                <input
                  accept=".xlsx,.xls"
                  hidden
                  onChange={(event) => void importWorkbook(event.target.files?.[0] || null)}
                  ref={importInputRef}
                  type="file"
                />
                <button onClick={() => importInputRef.current?.click()} type="button">
                  수정 및 불러오기
                </button>
                <button className="primary" disabled={!logs.length || busy} onClick={exportWorkbook} type="button">
                  분석 및 내보내기
                </button>
              </div>
            </div>
            <div className="fpa-log-board">
              <div className="fpa-log-header">
                <span>Time</span>
                <span>Team</span>
                <span>Player</span>
                <span>Action</span>
                <span>Tags</span>
                <span>Receiver</span>
                <span>Pos</span>
                <span>Receive Pos</span>
              </div>
              <div className="fpa-log-body" ref={logBodyRef}>
                {rows.map((row, index) => (
                  <div
                    className={`fpa-log-entry ${selectedRowIndex === index ? 'selected' : ''}`}
                    key={`${row.Time}-${row.Player}-${index}`}
                    onClick={() => setSelectedRowIndex(index)}
                    role="button"
                    tabIndex={0}
                  >
                    <span>{row.Time}</span>
                    <span>{row.Team}</span>
                    <span>{row.Player}</span>
                    <span>{row.Action}</span>
                    <span>{row.Tags || '-'}</span>
                    <span>{row.Receiver || '-'}</span>
                    <span>{row.Coord}</span>
                    <span>{extractReceiveCoord(logs[index]) || '-'}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="fpa-log-actions">
              <button disabled={selectedRowIndex == null} onClick={() => moveSelectedLog(-1)} type="button">
                선택 로그 위로
              </button>
              <button disabled={selectedRowIndex == null} onClick={() => moveSelectedLog(1)} type="button">
                선택 로그 아래로
              </button>
              <button disabled={selectedRowIndex == null} onClick={removeSelectedLog} type="button">
                선택 로그 삭제
              </button>
            </div>
          </section>

          <section className="fpa-pitch-panel">
            <div className="fpa-panel-title">축구장</div>
            <div
              className="fpa-pitch fpa-pitch-cream"
              onClick={handlePitchClick}
              onContextMenu={(event) => {
                event.preventDefault();
                removeLastDot();
              }}
              ref={pitchRef}
              role="button"
              tabIndex={0}
            >
              <img alt="Football field" className="fpa-pitch-image" draggable={false} src="/fpa-field.png" />
              {pitchDots.map((dot) => (
                <div className="fpa-pitch-dot" key={`${dot.label}-${dot.left}-${dot.top}`} style={{ left: dot.left, top: dot.top }}>
                  {dot.label}
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="fpa-live-controls">
          <div className="fpa-live-controls-title">실시간 입력 (Live Controls)</div>
          <div className="fpa-live-controls-row">
            <div className="fpa-live-control-group">
              <span>Direction</span>
              <div className="fpa-segmented">
                <button className={direction === 'right' ? 'active' : ''} onClick={() => setDirection('right')} type="button">Right</button>
                <button className={direction === 'left' ? 'active' : ''} onClick={() => setDirection('left')} type="button">Left</button>
              </div>
            </div>

            <div className="fpa-live-control-group">
              <span>Team</span>
              <div className="fpa-segmented">
                <button className={team === 'home' ? 'active' : ''} onClick={() => syncTeam('home')} type="button">Home</button>
                <button className={team === 'away' ? 'active' : ''} onClick={() => syncTeam('away')} type="button">Away</button>
              </div>
            </div>

            <div className="fpa-live-control-group">
              <span>Game Time</span>
              <div className="fpa-time-control">
                <button onClick={() => adjustTimeline(-60)} type="button">-1</button>
                <input id="fpa-live-timeline" value={timeline} onChange={(event) => setTimeline(event.target.value)} />
                <button onClick={() => adjustTimeline(60)} type="button">+1</button>
              </div>
            </div>

            <div className="fpa-live-control-group fpa-live-control-group-wide">
              <span>Stat Input</span>
              <div className="fpa-stat-input-row">
                <input
                  id="fpa-live-stat-input"
                  ref={statInputRef}
                  value={statInput}
                  onChange={(event) => setStatInput(event.target.value)}
                  placeholder="스탯 코드 (예: 10ss8.k)"
                />
                <button className="submit" disabled={!statInput.trim() || busy} onClick={addLog} type="button">
                  ↵
                </button>
              </div>
            </div>
          </div>
        </section>

        <div className="fpa-live-status">
          <span>{status}</span>
          <span>{dots.length ? `좌표 ${dots.map((dot) => `(${dot.meter_x}, ${dot.meter_y})`).join(' / ')}` : '좌표 없음'}</span>
        </div>
      </section>
    </div>
  );
}
