import type { MouseEvent } from 'react';
import { futsalPitchMarker } from '../../lib/futsal-pitch';

export function futsalShotThreat(x: number, y: number) {
  // The stored coordinate is a 40 × 20 m court coordinate attacking the
  // right goal.  This matches the FPA Queen Cup ShotThreat proxy (cap .80).
  const dx = Math.max(0.001, 40 - x);
  const offset = y - 10;
  const distance = Math.hypot(dx, offset);
  const angle = Math.abs(Math.atan2(1.5 - offset, dx) - Math.atan2(-1.5 - offset, dx));
  return Math.max(0, Math.min(0.8, 0.8 * Math.exp(-0.1 * distance) * Math.pow(angle / Math.PI, 0.55)));
}

export function FutsalShotPitch({
  shotPoint,
  onClick,
  isOnTarget,
}: {
  shotPoint: { x: number; y: number } | null;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
  isOnTarget: boolean;
}) {
  return (
    <div
      className="futsal-shot-pitch"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label="풋살 슛 위치 입력 피치"
    >
      <svg viewBox="-2 -2 24 24" preserveAspectRatio="none" aria-hidden="true">
        <rect x="-2" y="-2" width="24" height="24" fill="#e6302f" />
        <rect x="0" y="0" width="20" height="20" fill="#007ac0" />
        <g fill="none" stroke="#fff" strokeWidth="0.14">
          <rect x="0" y="0" width="20" height="20" />
          <path d="M8.5 0V-1.2H11.5V0M2.5 0A6 6 0 0 0 8.5 6H11.5A6 6 0 0 0 17.5 0" />
          <path d="M0 20H20M0 0H20" />
        </g>
        <g fill="#fff"><circle cx="10" cy="6" r=".12" /><circle cx="10" cy="10" r=".12" /></g>
      </svg>
      {shotPoint ? <span className="futsal-shot-marker" style={futsalPitchMarker(shotPoint)} /> : null}
      <span className="futsal-shot-pitch-label top">상대 골문</span>
      <span className="futsal-shot-pitch-label bottom">20m × 20m · 공격 하프</span>
      <span className="futsal-shot-pitch-label state">{isOnTarget ? '골문 좌표 입력 활성화' : '피치를 눌러 슛 위치 입력'}</span>
    </div>
  );
}

