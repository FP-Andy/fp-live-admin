'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '../../../../lib/api';

type VisualResponse = {
  pass_map: string | null;
  heatmap: string | null;
  combined_map: string | null;
};

export default function FpaReportsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [players, setPlayers] = useState<string[]>([]);
  const [playerId, setPlayerId] = useState('');
  const [reportTitle, setReportTitle] = useState('FPA Visual Reports');
  const [status, setStatus] = useState('파일을 선택하면 선수 목록을 먼저 읽어옵니다.');
  const [busy, setBusy] = useState(false);
  const [visuals, setVisuals] = useState<VisualResponse | null>(null);

  useEffect(() => {
    const loadPlayers = async () => {
      if (!file) {
        setPlayers([]);
        setPlayerId('');
        return;
      }

      setBusy(true);
      setStatus('선수 목록을 읽는 중입니다.');

      try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(`${API_BASE}/fpa/players/extract`, {
          method: 'POST',
          credentials: 'include',
          body: formData,
        });

        if (!response.ok) {
          setPlayers([]);
          setPlayerId('');
          setStatus(await response.text() || '선수 목록을 읽지 못했습니다.');
          return;
        }

        const data = await response.json() as { players: string[] };
        setPlayers(data.players || []);
        setPlayerId((data.players || [])[0] || '');
        setStatus('선수 목록을 불러왔습니다. 선수를 고른 뒤 리포트를 생성하세요.');
      } catch (error) {
        setPlayers([]);
        setPlayerId('');
        setStatus(error instanceof Error ? error.message : '선수 목록을 읽지 못했습니다.');
      } finally {
        setBusy(false);
      }
    };

    void loadPlayers();
  }, [file]);

  const generateVisuals = async () => {
    if (!file || !playerId) return;
    setBusy(true);
    setStatus('패스맵과 히트맵을 생성하는 중입니다.');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('player_id', playerId);
      formData.append('report_title', reportTitle || 'FPA Visual Reports');
      const response = await fetch(`${API_BASE}/fpa/analyze/visualize`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!response.ok) {
        setStatus(await response.text() || '시각화 생성에 실패했습니다.');
        return;
      }

      const data = await response.json() as VisualResponse;
      setVisuals(data);
      setStatus('시각 리포트를 생성했습니다.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '시각화 생성에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const downloadArchive = async () => {
    if (!file) return;
    setBusy(true);
    setStatus('선수 전체 시각화 ZIP/PDF를 생성하는 중입니다.');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('report_title', reportTitle || 'FPA Visual Reports');
      const response = await fetch(`${API_BASE}/fpa/analyze/visualize/archive`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!response.ok) {
        setStatus(await response.text() || '시각화 패키지 생성에 실패했습니다.');
        return;
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${(reportTitle || 'fpa').replace(/[^\w\-]+/g, '_')}_visual_reports.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);
      setStatus('ZIP(개별 PNG) + 4인/페이지 PDF 다운로드가 완료되었습니다.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '시각화 패키지 생성에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="card card-hero page-hero">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">FPA Workspace</div>
            <h2 style={{ margin: '6px 0 0' }}>Visual Reports</h2>
          </div>
          <span className="status-pill tech">Reports</span>
        </div>
        <p className="field-help" style={{ margin: 0, maxWidth: '72ch' }}>
          선수별 패스맵과 히트맵을 업로드 파일 기준으로 바로 생성합니다.
        </p>
      </section>

      <section className="card card-panel form-stack">
        <div className="hero-form-grid">
          <div className="field-stack">
            <label className="field-label" htmlFor="fpa-reports-file">분석 파일</label>
            <input
              id="fpa-reports-file"
              type="file"
              accept=".xlsx,.xls"
              onChange={(event) => {
                const nextFile = event.target.files?.[0] || null;
                setFile(nextFile);
                setReportTitle(nextFile ? nextFile.name.replace(/\.[^.]+$/, '') : 'FPA Visual Reports');
                setVisuals(null);
              }}
            />
            <span className="field-help">{file ? `${file.name} 선택됨` : '시각화할 파일을 선택하세요.'}</span>
          </div>

          <div className="field-stack">
            <label className="field-label" htmlFor="fpa-report-title">경기 이름 (PDF/ZIP 제목)</label>
            <input
              id="fpa-report-title"
              type="text"
              value={reportTitle}
              onChange={(event) => setReportTitle(event.target.value)}
              placeholder="예: 1-2-f-hufs"
            />
            <span className="field-help">입력한 이름으로 PDF 제목과 ZIP 파일명이 생성됩니다.</span>
          </div>

          <div className="field-stack">
            <label className="field-label" htmlFor="fpa-player-select">선수 선택</label>
            <select
              id="fpa-player-select"
              value={playerId}
              onChange={(event) => setPlayerId(event.target.value)}
              disabled={!players.length}
            >
              {!players.length ? <option value="">선수 목록 없음</option> : null}
              {players.map((player) => (
                <option key={player} value={player}>{player}</option>
              ))}
            </select>
            <span className="field-help">{players.length ? `${players.length}명의 선수를 찾았습니다.` : '파일 선택 후 자동 추출됩니다.'}</span>
          </div>
        </div>

        <div className="row">
          <button className="btn-primary" disabled={!file || !playerId || busy} onClick={generateVisuals}>
            {busy ? 'Generating...' : 'Generate Visual Reports'}
          </button>
          <button className="btn-secondary" disabled={!file || busy} onClick={downloadArchive}>
            {busy ? 'Preparing Archive...' : 'Download ZIP + 4up PDF'}
          </button>
        </div>

        <div className="card card-utility">
          <div className="sidebar-eyebrow">Status</div>
          <p style={{ margin: '8px 0 0', lineHeight: 1.6 }}>{status}</p>
        </div>
      </section>

      {visuals ? (
        <section className="grid fpa-visual-grid">
          <article className="card card-panel">
            <div className="section-heading">
              <h3>Heatmap</h3>
            </div>
            {visuals.heatmap ? <img alt="Player heatmap" className="fpa-image" src={`data:image/png;base64,${visuals.heatmap}`} /> : <p className="muted">No heatmap available.</p>}
          </article>
          <article className="card card-panel">
            <div className="section-heading">
              <h3>Pass Map</h3>
            </div>
            {visuals.pass_map ? <img alt="Player pass map" className="fpa-image" src={`data:image/png;base64,${visuals.pass_map}`} /> : <p className="muted">No pass map available.</p>}
          </article>
        </section>
      ) : null}
    </div>
  );
}
