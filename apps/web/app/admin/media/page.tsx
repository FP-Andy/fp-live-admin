'use client';

import Link from 'next/link';
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
    <main className="page-stack">
      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Admin</div>
            <h2 style={{ margin: 0 }}>Media Control</h2>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className={`status-pill ${data?.gateway.status_ok ? 'running' : 'stopped'}`}>
              {data?.gateway.status_ok ? 'Gateway Online' : 'Gateway Offline'}
            </span>
            <button onClick={load} disabled={busyKey !== ''}>Refresh</button>
            <button
              className="btn-danger"
              onClick={() => runDangerousAction(
                'stop-all',
                (confirmed) => apiFetch(`/admin/media/stop-all${confirmed ? '?confirm_live_action=true' : ''}`, { method: 'POST' }),
                'Stop all failed'
              )}
              disabled={busyKey !== '' || runningIds.size === 0}
            >
              {busyKey === 'stop-all' ? 'Stopping...' : 'Stop All Streams'}
            </button>
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

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => runAction('seed-demo', () => apiFetch('/admin/media/seed-demo', { method: 'POST' }))}
            disabled={busyKey !== ''}
          >
            {busyKey === 'seed-demo' ? 'Creating...' : 'Create Demo Matches'}
          </button>
          <div className="muted">
            로컬에서 이해하기 쉽도록 STREAM 정상 예시, HLS 실패 예시, MANUAL 예시 매치를 자동으로 넣습니다.
          </div>
        </div>
      </section>

      <section className="card card-utility grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Streaming Matches</div>
            <h3 style={{ margin: 0 }}>Per-Match Control</h3>
          </div>
        </div>

        {streamMatches.length === 0 ? (
          <div className="muted">현재 활성화된 스트림 매치가 없습니다. MANUAL 경기만 운영 중이면 영상 서버를 내릴 판단 근거로 볼 수 있습니다.</div>
        ) : (
          streamMatches.map((match) => {
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
                    <div className="muted text-tech">
                      server: {match.metadata?.rtmp?.server_url || 'N/A'}
                    </div>
                    <div className="muted text-tech">
                      key: {match.metadata?.rtmp?.stream_key || match.id}
                    </div>
                    <div className="muted text-tech">
                      hls: {match.hls_url || 'N/A'}
                    </div>
                    {match.metadata?.stream_attach_error ? (
                      <div className="form-error">
                        attach error: {match.metadata.stream_attach_error}
                      </div>
                    ) : null}
                  </div>

                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Link className="button-link button-compact btn-primary" href={`/admin/match/${match.id}`}>Open Match</Link>
                    <button
                      className="btn-primary"
                      onClick={() => runAction(`reattach:${match.id}`, () => apiFetch(`/admin/media/${match.id}/reattach`, { method: 'POST' }))}
                      disabled={busyKey !== ''}
                    >
                      {busyKey === `reattach:${match.id}` ? 'Re-attaching...' : 'Re-attach'}
                    </button>
                    <button
                      className="btn-danger"
                      onClick={() => runAction(stopKey, () => apiFetch(`/matches/${match.id}/stream/stop`, { method: 'POST' }))}
                      disabled={busyKey !== '' || !running}
                    >
                      {busyKey === stopKey ? 'Stopping...' : 'Stop Stream'}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => runAction(clearKey, () => apiFetch(`/matches/${match.id}/stream/clear`, { method: 'POST' }))}
                      disabled={busyKey !== '' || !running}
                    >
                      {busyKey === clearKey ? 'Clearing...' : 'Clear HLS'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </section>

      <section className="card grid">
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
      </section>
    </main>
  );
}
