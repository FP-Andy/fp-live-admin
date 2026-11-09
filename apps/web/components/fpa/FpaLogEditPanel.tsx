'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { composeStatCode, roundMeter, type FpaEditPoint, type FpaLogEditDraft } from './fpa-log-edit';

// 기록된 로그 표에서 고른 한 줄을 그 자리에서 고치는 칸. 값만 모으고, 저장은 부모가 서버 규칙으로 한다.

type Props = {
  draft: FpaLogEditDraft;
  current: { action: string; tags: string };
  busy: boolean;
  dirty: boolean;
  limits: { width: number; height: number };
  onChange: (patch: Partial<FpaLogEditDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
};

function Seg<T extends string>({ value, options, onPick, label }: { value: T; options: { value: T; label: string }[]; onPick: (v: T) => void; label: string }) {
  return (
    <div className="fpa-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className={value === option.value ? 'active' : ''} aria-pressed={value === option.value} onClick={() => onPick(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

// 숫자 칸 — 입력 중인 글자(61. 처럼 덜 친 값)는 그대로 두고, 밖(축구장 끌기)에서 값이 바뀌면 따라간다.
function MeterInput({ value, max, label, onCommit }: { value: number; max: number; label: string; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) { setText(String(value)); return; }
    const clamped = roundMeter(Math.min(Math.max(n, 0), max));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      aria-label={label}
      className="fpa-log-edit-num"
      inputMode="decimal"
      value={text}
      onFocus={() => { focused.current = true; }}
      onBlur={(event) => { focused.current = false; commit(event.target.value); }}
      onChange={(event) => {
        setText(event.target.value);
        const n = Number(event.target.value);
        if (event.target.value.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= max) onCommit(roundMeter(n));
      }}
    />
  );
}

function PointFields({ point, limits, label, onChange }: { point: FpaEditPoint; limits: Props['limits']; label: string; onChange: (p: FpaEditPoint) => void }) {
  return (
    <span className="fpa-log-edit-point">
      <MeterInput value={point.x} max={limits.width} label={`${label} x`} onCommit={(x) => onChange({ ...point, x })} />
      <MeterInput value={point.y} max={limits.height} label={`${label} y`} onCommit={(y) => onChange({ ...point, y })} />
    </span>
  );
}

export default function FpaLogEditPanel({ draft, current, busy, dirty, limits, onChange, onSave, onCancel }: Props) {
  const halves = ['1H', '2H', ...(draft.half !== '1H' && draft.half !== '2H' ? [draft.half] : [])];
  const code = composeStatCode(draft);
  // 전역 단축키(←→ 시각 조정, Enter 새 로그)가 이 칸 입력을 가로채지 않게 막고, Enter 저장 · Esc 닫기.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); return; }
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
      event.preventDefault();
      (event.target as HTMLInputElement).blur();
      onSave();
    }
  };
  return (
    <div className="fpa-log-edit" role="group" aria-label="고른 로그 수정" onKeyDown={onKeyDown}>
      <div className="fpa-log-edit-head">
        <strong>고른 로그 수정</strong>
        <span className="fpa-log-edit-now" title="지금 저장된 값">{current.action}{current.tags ? ` · ${current.tags}` : ''}</span>
        <span className="fpa-log-edit-code" title="저장하면 이 코드로 다시 만듭니다">코드 <code>{code || '—'}</code></span>
      </div>
      <div className="fpa-log-edit-grid">
        <div className="fpa-log-edit-field"><span>Half</span>
          <Seg label="Half" value={draft.half} onPick={(half) => onChange({ half })} options={halves.map((h) => ({ value: h, label: h === '1H' ? '1st' : h === '2H' ? '2nd' : h }))} />
        </div>
        <label className="fpa-log-edit-field"><span>Time</span>
          <input aria-label="Time" className="fpa-log-edit-time" value={draft.time} onChange={(event) => onChange({ time: event.target.value })} />
        </label>
        <div className="fpa-log-edit-field"><span>Team</span>
          <Seg label="Team" value={draft.team} onPick={(team) => onChange({ team })} options={[{ value: 'home', label: 'HOME' }, { value: 'away', label: 'AWAY' }]} />
        </div>
        <div className="fpa-log-edit-field"><span>Dir</span>
          <Seg label="Dir" value={draft.direction} onPick={(direction) => onChange({ direction })} options={[{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }]} />
        </div>
        <label className="fpa-log-edit-field"><span>Player</span>
          <input aria-label="Player" className="fpa-log-edit-short" inputMode="numeric" value={draft.player} onChange={(event) => onChange({ player: event.target.value.replace(/\D/g, '').slice(0, 3) })} />
        </label>
        <label className="fpa-log-edit-field"><span>Action</span>
          <input aria-label="Action 코드" className="fpa-log-edit-short" placeholder="ss" value={draft.action} onChange={(event) => onChange({ action: event.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 6) })} />
        </label>
        <label className="fpa-log-edit-field"><span>Receiver</span>
          <input aria-label="Receiver" className="fpa-log-edit-short" inputMode="numeric" value={draft.receiver} onChange={(event) => onChange({ receiver: event.target.value.replace(/\D/g, '').slice(0, 3) })} />
        </label>
        <label className="fpa-log-edit-field"><span>Tags</span>
          <input aria-label="Tags 코드" placeholder="h.up" value={draft.tags} onChange={(event) => onChange({ tags: event.target.value.toLowerCase() })} />
        </label>
        <div className="fpa-log-edit-field fpa-log-edit-wide"><span>Pos</span>
          {draft.pos ? <PointFields point={draft.pos} limits={limits} label="Pos" onChange={(pos) => onChange({ pos })} /> : <em>없음</em>}
        </div>
        <div className="fpa-log-edit-field fpa-log-edit-wide"><span>Receive Pos</span>
          {draft.recv ? (
            <span className="fpa-log-edit-point-row">
              <PointFields point={draft.recv} limits={limits} label="Receive Pos" onChange={(recv) => onChange({ recv })} />
              <button type="button" className="fpa-log-edit-mini" onClick={() => onChange({ recv: null, via: [] })} title="받은 위치를 뺍니다">빼기</button>
            </span>
          ) : (
            <button
              type="button"
              className="fpa-log-edit-mini"
              disabled={!draft.pos}
              onClick={() => draft.pos && onChange({ recv: { x: roundMeter(Math.min(draft.pos.x + 8, limits.width)), y: draft.pos.y } })}
              title="받은 위치를 넣고 축구장에서 끌어 맞춥니다"
            >넣기</button>
          )}
        </div>
      </div>
      <div className="fpa-log-edit-foot">
        <span className="fpa-log-edit-hint">오른쪽 경기장의 파란 점을 끌어 위치를 옮길 수 있습니다 · Enter 저장 · Esc 닫기</span>
        <button type="button" onClick={onCancel} disabled={busy}>닫기</button>
        <button type="button" className="primary" onClick={onSave} disabled={busy || !dirty}>{busy ? '저장 중…' : '이 로그 고치기'}</button>
      </div>
    </div>
  );
}
