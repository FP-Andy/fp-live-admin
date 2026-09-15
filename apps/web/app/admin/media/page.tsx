'use client';

import Link from 'next/link';
import { ConsoleToolbar, ConsoleEmpty } from '../../../components/ConsoleTools';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch, apiJson } from '../../../lib/api';

type MatchItem = {
  id: string;
  name: string;
  competition_class: string;
  archived: boolean;
  created_at: string;
  hls_url?: string | null;
  metadata?: {
    stream_mode?: 'STREAM' | 'MANUAL';
    ingest_protocol?: 'SRT' | 'RTMP';
    ingest_url?: string;
    stream_attach_error?: string;
    hls_probe?: {
      ok: boolean;
      status_code: number | null;
      detail: string;
      checked_at: string;
    };
    rtmp?: {
      server_url?: string;
      stream_key?: string;
      push_url?: string;
    };
  } | null;
};

type MediaResponse = {
  ok: boolean;
  time: string;
  gateway: {
    configured: boolean;
    base: string | null;
    status_ok: boolean;
    lines: string[];
    running_match_ids: string[];
  };
  matches: MatchItem[];
};

export default function MediaPage() {
  const [data, setData] = useState<MediaResponse | null>(null);
  const [query, setQuery] = useState('');
  const [streamFilter, setStreamFilter] = useState('ALL');
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState<string>('');

  const load = async () => {
    try {
      const next = await apiJson<MediaResponse>('/admin/media');
      setData(next);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Media dashboard unavailable');
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const runningIds = useMemo(
    () => new Set(data?.gateway.running_match_ids || []),
    [data]
  );

  const streamMatches = useMemo(
    () => (data?.matches || []).filter((match) => !match.archived && match.metadata?.stream_mode !== 'MANUAL'),
    [data]
  );
  const manualMatches = useMemo(
    () => (data?.matches || []).filter((match) => !match.archived && match.metadata?.stream_mode === 'MANUAL'),
    [data]
  );

  const visibleStreams = streamMatches.filter(match => match.name.toLowerCase().includes(query.trim().toLowerCase()) && (streamFilter === 'ALL' || streamFilter === 'RUNNING' && runningIds.has(match.id) || streamFilter === 'ATTENTION' && (Boolean(match.metadata?.stream_attach_error) || match.metadata?.hls_probe?.ok === false)));

  const [allKeysCopied, setAllKeysCopied] = useState(false);

  const copyAllKeys = async () => {
    const text = streamMatches
      .map((match) => `${match.name}\n\nkey: ${match.metadata?.rtmp?.stream_key || match.id}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setAllKeysCopied(true);
      setTimeout(() => setAllKeysCopied(false), 2000);
    } catch {
      window.alert('클립보드 복사에 실패했습니다. HTTPS(또는 localhost)에서만 동작합니다.');
    }
  };

  const runAction = async (key: string, action: () => Promise<Response>) => {
    setBusyKey(key);
    setError('');
    try {
      const response = await action();
      if (!response.ok) {
        setError((await response.text()) || 'Media action failed');
        return;
      }
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Media action failed');
    } finally {
      setBusyKey('');
    }
  };

  const runDangerousAction = async (
    key: string,
    action: (confirmed: boolean) => Promise<Response>,
    confirmMessage: string
  ) => {
    setBusyKey(key);
    setError('');
    try {
      let response = await action(false);
      if (response.status === 409) {
        const detail = await response.text();
        const ok = window.confirm(`${detail}\n\n계속 진행할까요?`);
        if (!ok) return;
        response = await action(true);
      }
      if (!response.ok) {
        setError((await response.text()) || 'Media action failed');
        return;
      }
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : confirmMessage);
    } finally {
      setBusyKey('');
    }
  };

  return (
    <main className="page-stack console-page media-page">
      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Admin</div>
            <h2 style={{ margin: 0 }}>Media Control</h2>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className={`status-pill ${!data ? 'warning' : data.gateway.status_ok ? 'running' : 'stopped'}`}>
              {!data ? '상태 확인 중…' : data.gateway.status_ok ? 'Gateway Online' : 'Gateway Offline'}
            </span>
            <button onClick={load} disabled={busyKey !== ''}>새로고침</button>

          </div>
        </div>

        {error ? <div className="form-error">{error}</div> : null}

        <div className="metric-strip">
          <div className="metric-tile tech">
            <span className="muted">Gateway Base</span>
            <strong>{data?.gateway.base || 'Not set'}</strong>
          </div>
          <div className="metric-tile success">
            <span className="muted">Running Streams</span>
            <strong>{runningIds.size}</strong>
          </div>
          <div className="metric-tile">
            <span className="muted">Streaming Matches</span>
            <strong>{streamMatches.length}</strong>
          </div>
          <div className="metric-tile">
            <span className="muted">Manual Matches</span>
            <strong>{manualMatches.length}</strong>
          </div>
        </div>

        <div className="grid" style={{ gap: 6 }}>
          <strong>Gateway Status</strong>
          {(data?.gateway.lines || []).length > 0 ? (
            (data?.gateway.lines || []).map((line) => (
              <div key={line} className="muted">{line}</div>
            ))
          ) : (
            <div className="muted">No live gateway status lines yet.</div>
          )}
        </div>

        <details className="console-inline-details"><summary>전체 송출 관리 · 예시 경기</summary><div className="grid" style={{ gap: 18 }}>
          <button
            className="btn-danger"
            onClick={() => runDangerousAction(
              'stop-all',
              (confirmed) => apiFetch(`/admin/media/stop-all${confirmed ? '?confirm_live_action=true' : ''}`, { method: 'POST' }),
              'Stop all failed'
            )}
            disabled={busyKey !== '' || runningIds.size === 0}
          >
            {busyKey === 'stop-all' ? 'Stopping...' : '전체 송출 중지'}
          </button>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => runAction('seed-demo', () => apiFetch('/admin/media/seed-demo', { method: 'POST' }))}
              disabled={busyKey !== ''}
            >
              {busyKey === 'seed-demo' ? 'Creating...' : '예시 경기 만들기'}
            </button>
            <div className="muted">
              로컬에서 이해하기 쉽도록 STREAM 정상 예시, HLS 실패 예시, MANUAL 예시 매치를 자동으로 넣습니다.
            </div>
          </div>
        </div></details>
      </section>

      <section className="card card-utility grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Streaming Matches</div>
            <h3 style={{ margin: 0 }}>경기별 송출 제어</h3>
          </div>
          <button
            className="button-compact btn-secondary"
            onClick={copyAllKeys}
            disabled={streamMatches.length === 0}
          >
            {allKeysCopied ? '복사됨 ✓' : '전체 스트림 키 복사'}
          </button>
        </div>

        <ConsoleToolbar>
          <label className="field-stack console-search"><span className="field-label">경기 검색</span><input type="search" placeholder="팀명 또는 경기명" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <label className="field-stack"><span className="field-label">송출 상태</span><select value={streamFilter} onChange={e => setStreamFilter(e.target.value)}><option value="ALL">전체</option><option value="RUNNING">송출 중</option><option value="ATTENTION">점검 필요</option></select></label>
          <span className="muted" role="status">{visibleStreams.length} / {streamMatches.length}개 경기</span>
        </ConsoleToolbar>
        {visibleStreams.length === 0 ? (
          <ConsoleEmpty title={data ? "조건에 맞는 송출 경기가 없습니다" : "송출 상태를 불러오는 중…"}><button onClick={() => { setQuery(''); setStreamFilter('ALL'); }}>필터 초기화</button></ConsoleEmpty>
        ) : (
          visibleStreams.map((match) => {
            const running = runningIds.has(match.id);
            const stopKey = `stop:${match.id}`;
            const clearKey = `clear:${match.id}`;

            return (
              <div key={match.id} className="card card-panel grid" style={{ gap: 10 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div className="grid" style={{ gap: 4 }}>
                    <strong>{match.name}</strong>
                    <div className="match-meta-group">
                      <span className="meta-chip">{match.competition_class}</span>
                      <span className={`meta-chip ${match.metadata?.stream_mode === 'MANUAL' ? 'warning' : ''}`}>
                        mode {match.metadata?.stream_mode || 'STREAM'}
                      </span>
                      <span className={`meta-chip ${match.metadata?.ingest_protocol ? 'tech' : ''}`}>
                        protocol {match.metadata?.ingest_protocol || 'N/A'}
                      </span>
                    </div>
                    <div className="muted">
                      status: <span className={running ? 'text-tech' : undefined}>{running ? 'RUNNING' : 'STOPPED'}</span>
                    </div>
                    <div className="muted">
                      HLS probe: {match.metadata?.hls_probe
                        ? match.metadata.hls_probe.ok
                          ? `200 OK`
                          : match.metadata.hls_probe.status_code
                            ? `${match.metadata.hls_probe.status_code}`
                            : 'FAILED'
                        : 'N/A'}
                    </div>
                    {match.metadata?.hls_probe?.detail ? (
                      <div className="muted">
                        detail: {match.metadata.hls_probe.detail}
                      </div>
                    ) : null}
                    <details className="console-inline-details"><summary>연결 주소 · 스트림 키</summary>                    <div className="muted text-tech">
                      server: {match.metadata?.rtmp?.server_url || 'N/A'}
                    </div>
                      <div className="muted text-tech">
                        key: {match.metadata?.rtmp?.stream_key || match.id}
                      </div>
                      <div className="muted text-tech">
                        hls: {match.hls_url || 'N/A'}
                      </div>
                    </details>
                    {match.metadata?.stream_attach_error ? (
                      <div className="form-error">
                        attach error: {match.metadata.stream_attach_error}
                      </div>
                    ) : null}
                  </div>

                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Link className="button-link button-compact btn-primary" href={`/admin/match/${match.id}`}>경기 제어</Link>
                    <button
                      className="btn-primary"
                      onClick={() => runAction(`reattach:${match.id}`, () => apiFetch(`/admin/media/${match.id}/reattach`, { method: 'POST' }))}
                      disabled={busyKey !== ''}
                    >
                      {busyKey === `reattach:${match.id}` ? 'Re-attaching...' : '다시 연결'}
                    </button>
                    <button
                      className="btn-danger"
                      onClick={() => runAction(stopKey, () => apiFetch(`/matches/${match.id}/stream/stop`, { method: 'POST' }))}
                      disabled={busyKey !== '' || !running}
                    >
                      {busyKey === stopKey ? 'Stopping...' : '송출 중지'}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => runAction(clearKey, () => apiFetch(`/matches/${match.id}/stream/clear`, { method: 'POST' }))}
                      disabled={busyKey !== '' || !running}
                    >
                      {busyKey === clearKey ? 'Clearing...' : 'HLS 정리'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </section>

      <details className="console-disclosure"><summary>송출 상태 읽는 방법</summary><section className="card grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Guide</div>
            <h3 style={{ margin: 0 }}>How To Read This Page</h3>
          </div>
        </div>
        <div className="muted">`RUNNING + HLS probe 200 OK`면 현재 attach와 재생 경로가 모두 살아 있을 가능성이 큽니다.</div>
        <div className="muted">`RUNNING인데 HLS probe FAIL/404/502`면 최근 말씀하신 “attach는 됐는데 HLS 200 OK가 안 뜨는 상태”로 볼 수 있습니다.</div>
        <div className="muted">이 경우 `Re-attach`를 눌러 저장된 ingest 정보로 다시 gateway attach를 시도할 수 있습니다.</div>
        <div className="muted">`MANUAL` 매치만 남아 있으면 영상 서버를 굳이 유지하지 않아도 되는 날인지 판단하는 데 도움이 됩니다.</div>
      </section></details>
    </main>
  );
}
