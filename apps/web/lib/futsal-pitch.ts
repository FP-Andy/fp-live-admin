// SVG coordinates include a 2 m surround around the 20 × 20 m attacking half.
export function futsalPitchPoint(horizontal: number, vertical: number) {
  const y = horizontal * 24 - 2;
  const x = 22 - vertical * 24;
  if (x < -1e-8 || x > 20 + 1e-8 || y < -1e-8 || y > 20 + 1e-8) return null;
  return { x: Number(Math.max(0, Math.min(20, x)).toFixed(2)), y: Number(Math.max(0, Math.min(20, y)).toFixed(2)) };
}

export function futsalPitchMarker(point: { x: number; y: number }) {
  return { left: `${(point.y + 2) / 24 * 100}%`, top: `${(22 - point.x) / 24 * 100}%` };
}
