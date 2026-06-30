'use client';

import { useEffect, useMemo, useState } from 'react';
import { API_BASE, apiJson } from '../../../../lib/api';

type ModelPoint = {
  x: number;
  y: number;
  value: number;
};

type GoalMouthPoint = {
  x: number;
  y: number;
  value: number;
};

type MatrixCell = {
  row: string;
  column: string;
  value: number;
  row_group?: string;
  detail?: string;
};

type HistogramBin = {
  start: number;
  end: number;
  count: number;
};

type DistributionStats = {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
};

type ModelDistribution = {
  parse_status: string;
  message?: string;
  value_column?: string | null;
  x_column?: string | null;
  y_column?: string | null;
  stats: DistributionStats;
  histogram: HistogramBin[];
  points: ModelPoint[];
  goalmouth_points?: GoalMouthPoint[];
  matrix_cells?: MatrixCell[];
};

type ModelVersion = {
  id: string;
  slot: string;
  label: string;
  filename: string;
  file_size: number;
  uploaded_at: string;
  notes: string;
  distribution: ModelDistribution;
};

type ModelSlot = {
  key: string;
  label: string;
  description: string;
  active_model_id: string | null;
  models: ModelVersion[];
};

type ModelRoomResponse = {
  slots: ModelSlot[];
};

type UploadState = {
  file: File | null;
  label: string;
  notes: string;
};

const MODEL_ACCEPT = '.csv,.json,.xlsx,.xls,.pt,.pth,.onnx,.pkl,.joblib,.yaml,.yml';

const emptyUpload: UploadState = { file: null, label: '', notes: '' };

function getActiveModel(slot: ModelSlot | null | undefined) {
  if (!slot?.active_model_id) return null;
  return slot.models.find((model) => model.id === slot.active_model_id) || null;
}

function formatStat(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return Number(value).toFixed(3);
}

function mixColor(start: [number, number, number], end: [number, number, number], amount: number) {
  return start.map((channel, index) => Math.round(channel + (end[index] - channel) * amount)) as [number, number, number];
}

function modelHeatColor(value: number, minValue: number, maxValue: number, alphaBoost = 0) {
  const ratio = maxValue === minValue ? 0.5 : Math.max(0, Math.min(1, (value - minValue) / (maxValue - minValue)));
  const stops: Array<{ at: number; color: [number, number, number] }> = [
    { at: 0, color: [28, 20, 48] },
    { at: 0.18, color: [43, 57, 157] },
    { at: 0.42, color: [33, 177, 238] },
    { at: 0.64, color: [92, 235, 120] },
    { at: 0.82, color: [255, 220, 54] },
    { at: 1, color: [218, 38, 36] },
  ];
  const right = stops.find((stop) => ratio <= stop.at) || stops[stops.length - 1];
  const left = stops[Math.max(0, stops.indexOf(right) - 1)] || stops[0];
  const local = right.at === left.at ? 0 : (ratio - left.at) / (right.at - left.at);
  const [r, g, b] = mixColor(left.color, right.color, local);
  return { color: `rgba(${r}, ${g}, ${b}, ${Math.min(0.94, 0.28 + ratio * 0.6 + alphaBoost)})`, ratio };
}

function uniqueCount(values: number[]) {
  return new Set(values.map((value) => Number(value).toFixed(3))).size || 1;
}

function uniqueOrdered(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function sortActionColumns(values: string[]) {
  return [...values].sort((left, right) => {
    const leftMatch = left.match(/^A(\d+)$/);
    const rightMatch = right.match(/^A(\d+)$/);
    if (leftMatch && rightMatch) {
      return Number(leftMatch[1]) - Number(rightMatch[1]);
    }
    if (leftMatch) return -1;
    if (rightMatch) return 1;
    return left.localeCompare(right);
  });
}

function notifyError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  window.alert(message);
}

export default function FpaReportsPage() {
  const [room, setRoom] = useState<ModelRoomResponse | null>(null);
  const [selectedSlotKey, setSelectedSlotKey] = useState('xg');
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);

  const loadRoom = async () => {
    try {
      const data = await apiJson<ModelRoomResponse>('/fpa/model-room');
      setRoom(data);
      if (data.slots.length && !data.slots.some((slot) => slot.key === selectedSlotKey)) {
        setSelectedSlotKey(data.slots[0].key);
      }
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    void loadRoom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slots = room?.slots || [];
  const selectedSlot = slots.find((slot) => slot.key === selectedSlotKey) || slots[0] || null;
  const activeModel = getActiveModel(selectedSlot);
  const distribution = activeModel?.distribution || null;
  const stats = distribution?.stats || null;
  const histogram = distribution?.histogram || [];
  const points = distribution?.points || [];
  const goalmouthPoints = distribution?.goalmouth_points || [];
  const matrixCells = distribution?.matrix_cells || [];
  const isGoalmouthSurface = selectedSlot?.key === 'xgot' && goalmouthPoints.length > 0;
  const isMatrixSurface = selectedSlot?.key === 'xfp_weights' && matrixCells.length > 0;
  const surfacePoints = isGoalmouthSurface ? goalmouthPoints : points;

  const heatRange = useMemo(() => {
    const values = surfacePoints.map((point) => point.value).filter((value) => Number.isFinite(value));
    if (!values.length) return { min: 0, max: 1 };
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [surfacePoints]);

  const pitchHeatCell = useMemo(() => {
    if (!points.length) return { width: 3, height: 4 };
    const xCount = uniqueCount(points.map((point) => point.x));
    const yCount = uniqueCount(points.map((point) => point.y));
    return {
      width: Math.max(1.4, 100 / xCount * 1.28),
      height: Math.max(1.8, 100 / yCount * 1.28),
    };
  }, [points]);

  const goalmouthHeatCell = useMemo(() => {
    if (!goalmouthPoints.length) return { width: 3, height: 4 };
    const xCount = uniqueCount(goalmouthPoints.map((point) => point.x));
    const yCount = uniqueCount(goalmouthPoints.map((point) => point.y));
    return {
      width: Math.max(1.6, 100 / xCount * 1.32),
      height: Math.max(2.4, 100 / yCount * 1.32),
    };
  }, [goalmouthPoints]);

  const maxHistogramCount = useMemo(() => Math.max(1, ...histogram.map((bin) => bin.count)), [histogram]);
  const matrixRows = useMemo(() => uniqueOrdered(matrixCells.map((cell) => cell.row)), [matrixCells]);
  const matrixColumns = useMemo(() => sortActionColumns(uniqueOrdered(matrixCells.map((cell) => cell.column))), [matrixCells]);
  const matrixRange = useMemo(() => {
    const values = matrixCells.map((cell) => cell.value).filter((value) => Number.isFinite(value));
    if (!values.length) return { min: 0, max: 1 };
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [matrixCells]);

  const updateUpload = (slotKey: string, patch: Partial<UploadState>) => {
    setUploads((current) => ({
      ...current,
      [slotKey]: {
        ...emptyUpload,
        ...(current[slotKey] || emptyUpload),
        ...patch,
      },
    }));
  };

  const uploadModel = async (slot: ModelSlot) => {
    const upload = uploads[slot.key] || emptyUpload;
    if (!upload.file) {
      window.alert(`${slot.label} 모델 파일을 먼저 선택하세요.`);
      return;
    }
    setBusySlot(slot.key);
    try {
      const formData = new FormData();
      formData.append('file', upload.file);
      formData.append('version_label', upload.label || upload.file.name.replace(/\.[^.]+$/, ''));
      formData.append('notes', upload.notes);

      const response = await fetch(`${API_BASE}/fpa/model-room/${slot.key}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!response.ok) {
        throw new Error((await response.text()) || '모델 업로드에 실패했습니다.');
      }
      const data = (await response.json()) as { slot: ModelSlot; model: ModelVersion };
      setRoom((current) => ({
        slots: (current?.slots || slots).map((item) => (item.key === data.slot.key ? data.slot : item)),
      }));
      setSelectedSlotKey(data.slot.key);
      setUploads((current) => ({
        ...current,
        [slot.key]: { file: null, label: '', notes: '' },
      }));
    } catch (error) {
      notifyError(error, '모델 업로드에 실패했습니다.');
    } finally {
      setBusySlot(null);
    }
  };

  const generateBaselines = async () => {
    setBootstrapping(true);
    try {
      const response = await fetch(`${API_BASE}/fpa/model-room/bootstrap`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error((await response.text()) || 'baseline 모델 생성에 실패했습니다.');
      }
      const data = (await response.json()) as ModelRoomResponse & { models: ModelVersion[] };
      setRoom({ slots: data.slots });
      if (data.slots.length) {
        setSelectedSlotKey(data.slots[0].key);
      }
    } catch (error) {
      notifyError(error, 'baseline 모델 생성에 실패했습니다.');
    } finally {
      setBootstrapping(false);
    }
  };

  return (
    <div className="page-stack">
      <section className="card card-hero page-hero">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">FPA Model Registry</div>
            <h2 style={{ margin: '6px 0 0' }}>Model Room</h2>
          </div>
          <div className="fpa-model-hero-actions">
            <span className="status-pill tech">xG / xGOT / EPV / PC / xFP</span>
            <button className="btn-secondary" disabled={bootstrapping} type="button" onClick={() => void generateBaselines()}>
              {bootstrapping ? 'Generating...' : 'Generate Baseline Models'}
            </button>
          </div>
        </div>
        <p className="field-help" style={{ margin: 0, maxWidth: '78ch' }}>
          FPA 평가 모델을 슬롯별로 업로드하고 활성 버전을 전환합니다. 좌표 기반 테이블은 피치 위 점수분포로 바로 확인할 수 있습니다.
        </p>
      </section>

      <section className="fpa-model-room-grid" aria-label="FPA model slots">
        {slots.map((slot) => {
          const upload = uploads[slot.key] || emptyUpload;
          const active = getActiveModel(slot);
          const isSelected = selectedSlotKey === slot.key;
          return (
            <article className={`fpa-model-slot-card ${isSelected ? 'active' : ''}`} key={slot.key}>
              <div className="fpa-model-slot-head">
                <button className="fpa-model-slot-select" type="button" onClick={() => setSelectedSlotKey(slot.key)}>
                  <span>{slot.label}</span>
                </button>
                <span className={`status-pill ${active ? 'running' : 'stopped'}`}>{active ? 'Active' : 'Empty'}</span>
              </div>

              <p className="field-help fpa-model-slot-desc">{slot.description}</p>

              <div className="fpa-model-active-line">
                <span>Active</span>
                <strong>{active ? active.label : 'No model'}</strong>
              </div>
              {active ? (
                <a
                  className="button-link btn-ghost fpa-model-active-download"
                  download
                  href={`${API_BASE}/fpa/model-room/${slot.key}/download/${active.id}`}
                >
                  Download Active
                </a>
              ) : null}

              <div className="fpa-model-upload-grid">
                <label className="field-stack">
                  <span className="field-label">Model File</span>
                  <input
                    accept={MODEL_ACCEPT}
                    type="file"
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0] || null;
                      updateUpload(slot.key, {
                        file: nextFile,
                        label: nextFile && !upload.label ? nextFile.name.replace(/\.[^.]+$/, '') : upload.label,
                      });
                    }}
                  />
                </label>
                <label className="field-stack">
                  <span className="field-label">Version Label</span>
                  <input
                    type="text"
                    value={upload.label}
                    onChange={(event) => updateUpload(slot.key, { label: event.target.value })}
                    placeholder="예: 2026-Q3 baseline"
                  />
                </label>
                <label className="field-stack fpa-model-upload-notes">
                  <span className="field-label">Notes</span>
                  <input
                    type="text"
                    value={upload.notes}
                    onChange={(event) => updateUpload(slot.key, { notes: event.target.value })}
                    placeholder="변경 목적 또는 데이터셋"
                  />
                </label>
                <button
                  className="btn-primary"
                  disabled={!upload.file || busySlot === slot.key}
                  type="button"
                  onClick={() => void uploadModel(slot)}
                >
                  {busySlot === slot.key ? 'Uploading...' : 'Upload & Activate'}
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="fpa-model-preview-layout">
        <article className="card card-panel fpa-model-preview-main">
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Distribution Preview</div>
              <h3>{selectedSlot ? selectedSlot.label : 'Model'} Score Surface</h3>
            </div>
            <span className="status-pill tech">
              {activeModel ? activeModel.filename : 'No Active Model'}
            </span>
          </div>

          <div className="fpa-model-preview-tabs">
            {slots.map((slot) => (
              <button
                className={selectedSlotKey === slot.key ? 'active' : ''}
                key={slot.key}
                type="button"
                onClick={() => setSelectedSlotKey(slot.key)}
              >
                {slot.label}
              </button>
            ))}
          </div>

          {!activeModel ? (
            <div className="fpa-model-empty-state">
              <strong>활성 모델이 없습니다.</strong>
              <p className="field-help">위 슬롯에 모델 파일을 업로드하면 이 영역에서 분포와 버전 정보를 확인할 수 있습니다.</p>
            </div>
          ) : (
            <div className={`fpa-model-preview-grid ${isMatrixSurface ? 'matrix-only' : ''}`}>
              {isMatrixSurface ? (
                <div className="fpa-model-matrix-preview">
                  <div
                    className="fpa-model-weight-matrix"
                    style={{ gridTemplateColumns: `128px repeat(${matrixColumns.length}, minmax(26px, 1fr))` }}
                  >
                    <div className="fpa-model-matrix-corner">Role</div>
                    {matrixColumns.map((column) => (
                      <div className="fpa-model-matrix-col" key={column} title={column}>
                        <span>{column}</span>
                      </div>
                    ))}
                    {matrixRows.map((row) => (
                      <div className="fpa-model-matrix-row-group" key={row}>
                        <div className="fpa-model-matrix-row-label" title={row}>{row}</div>
                        {matrixColumns.map((column) => {
                          const cell = matrixCells.find((item) => item.row === row && item.column === column);
                          const value = cell?.value ?? 0;
                          const heat = cell ? modelHeatColor(value, matrixRange.min, matrixRange.max, 0.02) : null;
                          return (
                            <span
                              className={`fpa-model-matrix-cell ${cell ? 'filled' : ''}`}
                              key={`${row}-${column}`}
                              style={{ backgroundColor: heat?.color || 'rgba(255,255,255,0.035)' }}
                              title={cell ? `${row} / ${column}: ${value}${cell.detail ? ` · ${cell.detail}` : ''}` : `${row} / ${column}: no weight`}
                            >
                              {cell ? value : ''}
                            </span>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              ) : isGoalmouthSurface ? (
                <div className="fpa-model-goalmouth-preview">
                  <div className="fpa-model-goalmouth-frame">
                    <div className="fpa-model-goalmouth-net" />
                    <div className="fpa-model-goalmouth-post left" />
                    <div className="fpa-model-goalmouth-post right" />
                    <div className="fpa-model-goalmouth-crossbar" />
                    <div className="fpa-model-goalmouth-heatmap">
                      {goalmouthPoints.map((point, index) => {
                        const heat = modelHeatColor(point.value, heatRange.min, heatRange.max, 0.03);
                        return (
                          <span
                            aria-label={`${selectedSlot?.label || 'Model'} value ${point.value}`}
                            className="fpa-model-heat-cell goalmouth"
                            key={`${point.x}-${point.y}-${point.value}-${index}`}
                            style={{
                              left: `${point.x * 100}%`,
                              top: `${(1 - point.y) * 100}%`,
                              width: `${goalmouthHeatCell.width}%`,
                              height: `${goalmouthHeatCell.height}%`,
                              backgroundColor: heat.color,
                            }}
                            title={`${point.value.toFixed(3)} (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <div className="fpa-model-goalmouth-axis">
                    <span>Left Post</span>
                    <strong>Goal Mouth xGOT Surface</strong>
                    <span>Right Post</span>
                  </div>
                </div>
              ) : (
                <div className="fpa-model-pitch-preview">
                  <img alt={`${selectedSlot?.label || 'Model'} pitch distribution`} draggable={false} src="/fpa-field.png" />
                  {points.length ? (
                    <>
                      <div className="fpa-model-pitch-heatmap">
                        {points.map((point, index) => {
                          const heat = modelHeatColor(point.value, heatRange.min, heatRange.max);
                          return (
                            <span
                              aria-label={`${selectedSlot?.label || 'Model'} value ${point.value}`}
                              className="fpa-model-heat-cell pitch"
                              key={`${point.x}-${point.y}-${point.value}-${index}`}
                              style={{
                                left: `${(point.x / 105) * 100}%`,
                                top: `${(1 - point.y / 68) * 100}%`,
                                width: `${pitchHeatCell.width}%`,
                                height: `${pitchHeatCell.height}%`,
                                backgroundColor: heat.color,
                              }}
                              title={`${point.value.toFixed(3)} (${point.x.toFixed(1)}, ${point.y.toFixed(1)})`}
                            />
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="fpa-model-pitch-placeholder">
                      <strong>좌표 분포 없음</strong>
                      <span>CSV/JSON/Excel에 x/y/value 계열 컬럼이 있으면 피치 위에 표시됩니다.</span>
                    </div>
                  )}
                </div>
              )}

              {!isMatrixSurface ? (
                <div className="fpa-model-analysis-stack">
                  <div className="fpa-model-stat-grid">
                    <div>
                      <span>Rows</span>
                      <strong>{stats?.count ?? 0}</strong>
                    </div>
                    <div>
                      <span>Mean</span>
                      <strong>{formatStat(stats?.mean)}</strong>
                    </div>
                    <div>
                      <span>P50</span>
                      <strong>{formatStat(stats?.p50)}</strong>
                    </div>
                    <div>
                      <span>Range</span>
                      <strong>{formatStat(stats?.min)} - {formatStat(stats?.max)}</strong>
                    </div>
                  </div>

                  <div className="fpa-model-histogram-panel">
                    <div className="fpa-model-panel-title">
                      <span>Histogram</span>
                      <strong>{distribution?.value_column || 'value'}</strong>
                    </div>
                    {histogram.length ? (
                      <div className="fpa-model-histogram">
                        {histogram.map((bin) => (
                          <div className="fpa-model-histogram-bin" key={`${bin.start}-${bin.end}`}>
                            <span style={{ height: `${Math.max(6, (bin.count / maxHistogramCount) * 100)}%` }} />
                            <small>{bin.count}</small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="field-help">분포 통계를 만들 숫자 컬럼이 아직 없습니다.</p>
                    )}
                  </div>

                  {distribution?.message ? <p className="field-help">{distribution.message}</p> : null}
                </div>
              ) : null}
            </div>
          )}
        </article>
      </section>
    </div>
  );
}
