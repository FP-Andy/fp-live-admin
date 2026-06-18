'use client';

import { useEffect, useRef, useState } from 'react';

// 그림판처럼 연속 그라데이션(채도-명도 사각형 + 색상 띠)으로 색을 고르는 피커.

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

const SQ_W = 220;
const SQ_H = 150;
const HUE_W = 220;

export default function ColorPicker({
  value,
  onChange,
  placeholder = '색상 상자를 클릭해 유니폼 색을 선택하세요.',
}: {
  value: string;
  onChange: (hex: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hue, setHue] = useState(210);
  const [sat, setSat] = useState(0.8);
  const [val, setVal] = useState(0.9);
  const sqRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<'sq' | 'hue' | null>(null);

  const hex = hsvToHex(hue, sat, val);

  const emit = (h: number, s: number, v: number) => onChange(hsvToHex(h, s, v));

  const updateSq = (clientX: number, clientY: number) => {
    const el = sqRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const v = Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height));
    setSat(s); setVal(v); emit(hue, s, v);
  };
  const updateHue = (clientX: number) => {
    const el = hueRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const h = Math.max(0, Math.min(360, ((clientX - r.left) / r.width) * 360));
    setHue(h); emit(h, sat, val);
  };

  useEffect(() => {
    if (!open) return;
    const move = (e: PointerEvent) => {
      if (dragRef.current === 'sq') updateSq(e.clientX, e.clientY);
      else if (dragRef.current === 'hue') updateHue(e.clientX);
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hue, sat, val]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '7px 10px',
          borderRadius: 8,
          border: '1px solid var(--border-ghost)',
          background: 'var(--surface-input, #1b1b1f)',
          color: value ? 'var(--text, #eee)' : 'var(--muted, #999)',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            flexShrink: 0,
            background: value || hex,
            border: '1px solid rgba(255,255,255,0.25)',
          }}
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value ? value.toUpperCase() : placeholder}
        </span>
      </button>

      {open ? (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: 'absolute',
              zIndex: 41,
              top: 'calc(100% + 6px)',
              left: 0,
              padding: 12,
              borderRadius: 10,
              background: 'var(--surface-card, #1b1b1f)',
              border: '1px solid var(--border-ghost)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {/* 채도-명도 사각형 */}
            <div
              ref={sqRef}
              onPointerDown={(e) => { dragRef.current = 'sq'; updateSq(e.clientX, e.clientY); }}
              style={{
                position: 'relative',
                width: SQ_W,
                height: SQ_H,
                borderRadius: 6,
                cursor: 'crosshair',
                background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hue, 1, 1)})`,
                touchAction: 'none',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: sat * SQ_W,
                  top: (1 - val) * SQ_H,
                  width: 14,
                  height: 14,
                  marginLeft: -7,
                  marginTop: -7,
                  borderRadius: '50%',
                  border: '2px solid #fff',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
                  pointerEvents: 'none',
                }}
              />
            </div>

            {/* 색상 띠 */}
            <div
              ref={hueRef}
              onPointerDown={(e) => { dragRef.current = 'hue'; updateHue(e.clientX); }}
              style={{
                position: 'relative',
                width: HUE_W,
                height: 14,
                borderRadius: 7,
                cursor: 'pointer',
                background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
                touchAction: 'none',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: (hue / 360) * HUE_W,
                  top: -2,
                  width: 6,
                  height: 18,
                  marginLeft: -3,
                  borderRadius: 3,
                  background: '#fff',
                  border: '1px solid rgba(0,0,0,0.5)',
                  pointerEvents: 'none',
                }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 22, height: 22, borderRadius: 4, background: hex, border: '1px solid rgba(255,255,255,0.25)' }} />
              <span style={{ fontSize: 13, fontFamily: 'monospace' }}>{hex.toUpperCase()}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{ marginLeft: 'auto', padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent, #3b82f6)', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
              >
                확인
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
