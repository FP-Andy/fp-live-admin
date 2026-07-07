'use client';

import { useEffect, useState } from 'react';
import { apiFetch, apiJson, displayRole, type SessionUser } from '../../../lib/api';

type SystemInfo = {
  ok: boolean;
  time: string;
  streams_enabled: boolean;
  gateway_base: string | null;
  public_hls_base: string | null;
  system_monitor?: {
    enabled: boolean;
    slack_configured: boolean;
    schedule_configured: boolean;
    prematch_minutes: number;
    postmatch_minutes: number;
    active_check_seconds: number;
    idle_check_seconds: number;
  };
  app_server: ServerStatus;
  media_server: ServerStatus;
  highlight_worker: ServerStatus & {
    active_jobs?: number;
  };
  health: {
    gateway_ok: boolean;
    running_streams: number;
    active_matches: number;
    live_matches: number;
    streaming_matches: number;
    manual_matches: number;
    active_highlight_jobs: number;
  };
  alerts: Array<{
    severity: 'HIGH' | 'MEDIUM' | 'INFO';
    title: string;
    message: string;
  }>;
  recent_audits: Array<{
    id: string;
    actor_id?: string | null;
    actor_name?: string | null;
    actor_role?: string | null;
    action: string;
    target_type: string;
    target_id?: string | null;
    match_id?: string | null;
    severity: string;
    created_at: string;
  }>;
};

type ServerMetrics = {
  available?: boolean;
  cpu_average_percent?: number | null;
  cpu_max_percent?: number | null;
  memory_percent?: number | null;
  memory_used_gib?: number | null;
  memory_total_gib?: number | null;
  disk_percent?: number | null;
  disk_used_gib?: number | null;
  disk_total_gib?: number | null;
  sample_time?: string | null;
  detail?: string | null;
};

type ServerStatus = {
  configured?: boolean;
  ok: boolean;
  state: string;
  detail?: string | null;
  instance_id?: string | null;
  instance_name?: string | null;
  instance_type?: string | null;
  public_ip?: string | null;
  private_ip?: string | null;
  provider?: string | null;
  metrics?: ServerMetrics;
};

type ResourceCardProps = {
  title: string;
  subtitle: string;
  server?: ServerStatus | null;
  showMemory?: boolean;
  showDisk?: boolean;
};

function formatPercent(value?: number | null) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '-';
}

function formatGib(used?: number | null, total?: number | null) {
  if (typeof used !== 'number' || typeof total !== 'number') return '-';
  return `${used.toFixed(1)} / ${total.toFixed(1)} GiB`;
}

function metricLevel(value?: number | null) {
  if (typeof value !== 'number') return 'muted';
  if (value >= 85) return 'danger';
  if (value >= 70) return 'warning';
  return 'ok';
}

function ResourceBar({ label, value }: { label: string; value?: number | null }) {
  const level = metricLevel(value);
  const width = typeof value === 'number' ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="resource-bar-row">
      <div className="resource-bar-label">
        <span>{label}</span>
        <strong>{formatPercent(value)}</strong>
      </div>
      <div className="resource-bar-track">
        <div className={`resource-bar-fill ${level}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function ResourceCard({ title, subtitle, server, showMemory = false, showDisk = false }: ResourceCardProps) {
  const metrics = server?.metrics || {};
  const isRunning = server?.state === 'running';
  const statusClass = isRunning ? 'running' : server?.state === 'stopped' ? 'stopped' : 'warning';
  return (
    <div className="resource-card">
      <div className="resource-card-head">
        <div>
          <div className="sidebar-eyebrow">{subtitle}</div>
          <h4>{title}</h4>
        </div>
        <span className={`status-pill ${statusClass}`}>{server?.state || 'unknown'}</span>
      </div>
      <div className="resource-meta">
        <span>{server?.instance_name || '-'}</span>
        <span>{server?.instance_type || server?.provider || '-'}</span>
        <span>{server?.private_ip || server?.public_ip || '-'}</span>
      </div>
      <ResourceBar label="CPU avg" value={metrics.cpu_average_percent} />
      {typeof metrics.cpu_max_percent === 'number' ? <ResourceBar label="CPU peak" value={metrics.cpu_max_percent} /> : null}
      {showMemory ? (
        <>
          <ResourceBar label="Memory" value={metrics.memory_percent} />
          <div className="resource-small">{formatGib(metrics.memory_used_gib, metrics.memory_total_gib)}</div>
        </>
      ) : null}
      {showDisk ? (
        <>
          <ResourceBar label="Disk" value={metrics.disk_percent} />
          <div className="resource-small">{formatGib(metrics.disk_used_gib, metrics.disk_total_gib)}</div>
        </>
      ) : null}
      {!metrics.available && server?.state === 'running' ? (
        <div className="resource-small warning-text">{metrics.detail || 'No recent metric data'}</div>
      ) : null}
      {metrics.sample_time ? (
        <div className="resource-small">
          sample {new Date(metrics.sample_time).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
        </div>
      ) : null}
    </div>
  );
}

export default function SystemPage() {
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [submittingAction, setSubmittingAction] = useState('');

  const load = async () => {
    const [user, info] = await Promise.all([
      apiJson<SessionUser>('/session/me'),
      apiJson<SystemInfo>('/admin/system'),
    ]);
    setSessionUser(user);
    setSystemInfo(info);
    setError('');
  };

  useEffect(() => {
    let active = true;

    const loadIfActive = () => load()
      .then(() => {
        if (!active) return;
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : 'System dashboard unavailable');
      });

    loadIfActive();
    const timer = window.setInterval(loadIfActive, 15000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const runMediaAction = async (action: 'start' | 'stop') => {
    if (submittingAction) return;

    const isStop = action === 'stop';
    if (isStop) {
      const ok = window.confirm('Media server를 중지할까요? STREAM 경기나 RUNNING 스트림이 남아 있으면 차단될 수 있습니다.');
      if (!ok) return;
    }

    setSubmittingAction(`media-${action}`);
    setActionMessage('');
    setError('');
    try {
      let response = await apiFetch(`/admin/ec2/media-${action}`, {
        method: 'POST',
      });

      if (response.status === 409 && isStop) {
        const detail = await response.text();
        const confirmLive = window.confirm(`${detail}\n\n그래도 중지할까요?`);
        if (!confirmLive) {
          setSubmittingAction('');
          return;
        }
        response = await apiFetch(`/admin/ec2/media-stop?confirm_live_action=true`, {
          method: 'POST',
        });
      }

      if (!response.ok) {
        throw new Error((await response.text()) || `Media ${action} failed`);
      }

      await load();
      setActionMessage(action === 'start' ? 'Media server start 요청을 보냈습니다.' : 'Media server stop 요청을 보냈습니다.');
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Media ${action} failed`);
    } finally {
      setSubmittingAction('');
    }
  };

  const runHighlightWorkerAction = async (action: 'start' | 'stop') => {
    if (submittingAction) return;

    const isStop = action === 'stop';
    if (isStop) {
      const activeJobs = systemInfo?.highlight_worker?.active_jobs || 0;
      const ok = window.confirm(`FHL GPU worker를 중지할까요?${activeJobs ? ` 현재 대기/처리 중인 작업 ${activeJobs}개가 있습니다.` : ''}`);
      if (!ok) return;
    }

    setSubmittingAction(`highlight-${action}`);
    setActionMessage('');
    setError('');
    try {
      let response = await apiFetch(`/admin/ec2/highlight-worker-${action}`, {
        method: 'POST',
      });

      if (response.status === 409 && isStop) {
        const detail = await response.text();
        const confirmLive = window.confirm(`${detail}\n\n그래도 중지할까요?`);
        if (!confirmLive) {
          setSubmittingAction('');
          return;
        }
        response = await apiFetch(`/admin/ec2/highlight-worker-stop?confirm_live_action=true`, {
          method: 'POST',
        });
      }

      if (!response.ok) {
        throw new Error((await response.text()) || `FHL GPU worker ${action} failed`);
      }

      await load();
      setActionMessage(action === 'start' ? 'FHL GPU worker start 요청을 보냈습니다.' : 'FHL GPU worker stop 요청을 보냈습니다.');
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `FHL GPU worker ${action} failed`);
    } finally {
      setSubmittingAction('');
    }
  };

  if (error) {
    return (
      <main className="page-stack">
        <section className="card card-panel grid">
          <h2 style={{ margin: 0 }}>System</h2>
          <div className="form-error">{error}</div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-stack">
      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Admin</div>
            <h2 style={{ margin: 0 }}>System Control</h2>
          </div>
          <span className="status-pill running">{displayRole(sessionUser?.role) || 'ROLE'}</span>
        </div>
        <div className="muted">
          이 페이지는 슈퍼어드민 전용 시스템 관리 영역입니다. 실제 서버 on/off 같은 기능이 붙으면 운영 전체에 영향을 줄 수 있으므로, Media에서 먼저 상태를 확인한 뒤 마지막 단계에서만 사용하는 것을 권장합니다.
        </div>
        <div className="metric-strip">
          <div className="metric-tile">
            <span className="muted">Gateway Linked</span>
            <strong>{systemInfo?.streams_enabled ? 'Yes' : 'No'}</strong>
          </div>
          <div className="metric-tile tech">
            <span className="muted">Gateway Base</span>
            <strong>{systemInfo?.gateway_base || 'Not set'}</strong>
          </div>
          <div className="metric-tile tech">
            <span className="muted">Public HLS Base</span>
            <strong>{systemInfo?.public_hls_base || 'Not set'}</strong>
          </div>
          <div className="metric-tile success">
            <span className="muted">Running Streams</span>
            <strong>{systemInfo?.health.running_streams ?? 0}</strong>
          </div>
          <div className="metric-tile">
            <span className="muted">Live Matches</span>
            <strong>{systemInfo?.health.live_matches ?? 0}</strong>
          </div>
          <div className="metric-tile">
            <span className="muted">Streaming Matches</span>
            <strong>{systemInfo?.health.streaming_matches ?? 0}</strong>
          </div>
          <div className="metric-tile">
            <span className="muted">Manual Matches</span>
            <strong>{systemInfo?.health.manual_matches ?? 0}</strong>
          </div>
          <div className="metric-tile tech">
            <span className="muted">Media EC2</span>
            <strong>{systemInfo?.media_server?.state || 'unknown'}</strong>
          </div>
          <div className="metric-tile tech">
            <span className="muted">FHL GPU</span>
            <strong>{systemInfo?.highlight_worker?.state || 'unknown'}</strong>
          </div>
          <div className="metric-tile">
            <span className="muted">FHL Jobs</span>
            <strong>{systemInfo?.health.active_highlight_jobs ?? 0}</strong>
          </div>
        </div>
      </section>

      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Live Resources</div>
            <h3 style={{ margin: 0 }}>Server Load Dashboard</h3>
          </div>
          <span className="status-pill tech">15s refresh</span>
        </div>
        <div className="resource-grid">
          <ResourceCard title="App / API / DB" subtitle="live-admin-app" server={systemInfo?.app_server} showMemory showDisk />
          <ResourceCard title="Stream Gateway" subtitle="live-admin-media" server={systemInfo?.media_server} />
          <ResourceCard title="FHL GPU Worker" subtitle="fhl-gpu-worker" server={systemInfo?.highlight_worker} />
        </div>
        <div className="muted">
          Match Control의 3초 데이터 반영 주기는 유지합니다. 이 대시보드만 별도로 15초마다 서버 상태를 갱신합니다.
        </div>
        <div className="resource-meta">
          <span className={`status-pill ${systemInfo?.system_monitor?.enabled ? 'running' : 'stopped'}`}>
            monitor {systemInfo?.system_monitor?.enabled ? 'on' : 'off'}
          </span>
          <span className={`status-pill ${systemInfo?.system_monitor?.slack_configured ? 'running' : 'warning'}`}>
            slack webhook {systemInfo?.system_monitor?.slack_configured ? 'ready' : 'not set'}
          </span>
          <span className="muted">
            경기 시작 {systemInfo?.system_monitor?.prematch_minutes ?? 30}분 전부터 감시 · 경기 후 {systemInfo?.system_monitor?.postmatch_minutes ?? 180}분까지 유지
          </span>
        </div>
      </section>

      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Infra</div>
            <h3 style={{ margin: 0 }}>Media Server Control</h3>
          </div>
          <span className={`status-pill ${systemInfo?.media_server?.ok ? 'running' : 'stopped'}`}>
            {systemInfo?.media_server?.configured ? (systemInfo?.media_server?.state || 'unknown') : 'not configured'}
          </span>
        </div>
        {!systemInfo?.media_server?.configured ? (
          <div className="muted">
            <code>MEDIA_CONTROL_URL</code> 환경변수가 설정되지 않아 웹에서 media EC2를 제어할 수 없습니다. Lambda 또는 외부 control endpoint를 연결하면 이 영역이 활성화됩니다.
          </div>
        ) : (
          <>
            <div className="muted">
              provider: {systemInfo?.media_server?.provider || 'aws'} · instance: {systemInfo?.media_server?.instance_name || '-'} · public IP:{' '}
              {systemInfo?.media_server?.public_ip || '-'} · private IP: {systemInfo?.media_server?.private_ip || '-'}
            </div>
            <div className="muted">
              안전 가드: RUNNING 스트림 또는 STREAM 경기 존재 시 stop 요청은 기본 차단되며, 슈퍼어드민 확인 후에만 강제 실행됩니다.
            </div>
            {actionMessage ? <div className="muted">{actionMessage}</div> : null}
              {systemInfo?.media_server?.detail ? <div className="muted">detail: {systemInfo.media_server.detail}</div> : null}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn-primary" onClick={() => runMediaAction('start')} disabled={Boolean(submittingAction)}>
                {submittingAction === 'media-start' ? 'Working...' : 'Start Media Server'}
              </button>
              <button type="button" className="btn-danger" onClick={() => runMediaAction('stop')} disabled={Boolean(submittingAction)}>
                {submittingAction === 'media-stop' ? 'Working...' : 'Stop Media Server'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Infra</div>
            <h3 style={{ margin: 0 }}>FHL GPU Worker Control</h3>
          </div>
          <span className={`status-pill ${systemInfo?.highlight_worker?.ok ? 'running' : 'stopped'}`}>
            {systemInfo?.highlight_worker?.configured ? (systemInfo?.highlight_worker?.state || 'unknown') : 'not configured'}
          </span>
        </div>
        {!systemInfo?.highlight_worker?.configured ? (
          <div className="muted">
            <code>HIGHLIGHT_WORKER_CONTROL_URL</code> 환경변수가 설정되지 않아 웹에서 FHL GPU worker를 제어할 수 없습니다.
          </div>
        ) : (
          <>
            <div className="muted">
              provider: {systemInfo?.highlight_worker?.provider || 'aws'} · instance: {systemInfo?.highlight_worker?.instance_name || '-'} · public IP:{' '}
              {systemInfo?.highlight_worker?.public_ip || '-'} · private IP: {systemInfo?.highlight_worker?.private_ip || '-'}
            </div>
            <div className="muted">
              대기/처리 중 FHL 작업: {systemInfo?.highlight_worker?.active_jobs || 0}개. 작업이 있으면 stop 요청은 기본 차단됩니다.
            </div>
            {systemInfo?.highlight_worker?.detail ? <div className="muted">detail: {systemInfo.highlight_worker.detail}</div> : null}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn-primary" onClick={() => runHighlightWorkerAction('start')} disabled={Boolean(submittingAction)}>
                {submittingAction === 'highlight-start' ? 'Working...' : 'Start FHL GPU Worker'}
              </button>
              <button type="button" className="btn-danger" onClick={() => runHighlightWorkerAction('stop')} disabled={Boolean(submittingAction)}>
                {submittingAction === 'highlight-stop' ? 'Working...' : 'Stop FHL GPU Worker'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card card-utility grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Health</div>
            <h3 style={{ margin: 0 }}>Unified Health</h3>
          </div>
        </div>
        {(systemInfo?.alerts || []).length === 0 ? (
          <div className="muted">현재 즉시 조치가 필요한 위험 신호는 감지되지 않았습니다.</div>
        ) : (
          (systemInfo?.alerts || []).map((alert) => (
            <div
              key={`${alert.severity}-${alert.title}`}
              className={alert.severity === 'HIGH' ? 'form-error' : 'muted'}
              style={alert.severity === 'MEDIUM' ? { color: 'var(--warning)' } : undefined}
            >
              [{alert.severity}] {alert.title}: {alert.message}
            </div>
          ))
        )}
      </section>

      <section className="card card-utility grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Guide</div>
            <h3 style={{ margin: 0 }}>How To Use System Control</h3>
          </div>
        </div>

        <div className="muted">1. 먼저 `Media` 탭에서 현재 RUNNING 스트림, HLS 200 OK 여부, 재-attach 필요 여부를 확인합니다.</div>
        <div className="muted">2. 경기 중이거나 운영자가 실제 입력 중이면 여기서 서버를 건드리지 않습니다. 이 탭은 경기 중 대응용보다 경기 전/후 정리용에 가깝습니다.</div>
        <div className="muted">3. `MANUAL` 경기만 남아 있고, 스트리밍 매치가 0개이며, Media에서 RUNNING 스트림도 0개일 때만 영상 서버 종료를 검토합니다.</div>
        <div className="muted">4. attach 문제는 먼저 `Media`에서 `Re-attach`나 `HLS probe` 확인으로 처리하고, 그 뒤에도 안 풀릴 때만 서버 레벨 조치를 고려합니다.</div>
      </section>

      <section className="card card-danger grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Safety</div>
            <h3 style={{ margin: 0 }}>Before You Touch Servers</h3>
          </div>
        </div>

        <div className="muted">끄면 안 되는 상황: 경기 중 송출 중, 운영자가 매치 페이지에서 작업 중, HLS가 아직 보고되고 있는 상황</div>
        <div className="muted">꺼도 될 가능성이 높은 상황: 모든 스트림이 STOPPED, Media에서 HLS probe가 의미 없거나 비활성, 오늘 운영이 끝난 뒤, MANUAL 경기만 남아 있는 상황</div>
        <div className="muted">가장 안전한 순서: `Stop Stream` 또는 `Stop All Streams` → 상태 재확인 → 그 다음에만 서버 종료</div>
        <div className="muted">향후 실제 서버 버튼을 붙일 때도, 바로 실행하지 않고 확인 문구와 조건 검사를 먼저 넣는 방향으로 확장하는 것이 안전합니다.</div>
      </section>

      <section className="card card-utility grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Audit</div>
            <h3 style={{ margin: 0 }}>Recent Operator Actions</h3>
          </div>
        </div>

        {(systemInfo?.recent_audits || []).length === 0 ? (
          <div className="muted">아직 기록된 운영 이벤트가 없습니다.</div>
        ) : (
          (systemInfo?.recent_audits || []).map((item) => (
            <div key={item.id} className="log-row">
              <div className="grid" style={{ gap: 4 }}>
                <strong>{item.action}</strong>
                <div className="muted">
                  actor: {item.actor_name || item.actor_id || 'system'} {item.actor_role ? `· ${displayRole(item.actor_role)}` : ''}
                </div>
                <div className="muted">
                  target: {item.target_type} {item.target_id || item.match_id || '-'}
                </div>
              </div>
              <div className="muted">
                {new Date(item.created_at).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}
              </div>
            </div>
          ))
        )}
      </section>
    </main>
  );
}
