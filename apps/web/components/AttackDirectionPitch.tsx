type Props = {
  homeDirection: 'L2R' | 'R2L';
  team: 'HOME' | 'AWAY';
  teamName: string;
  lane: 'LEFT' | 'CENTER' | 'RIGHT';
};

/** Direction follows the selected recording team, including the away reversal. */
export default function AttackDirectionPitch({ homeDirection, team, teamName, lane }: Props) {
  const right = team === 'HOME' ? homeDirection === 'L2R' : homeDirection === 'R2L';
  const direction = right ? '오른쪽' : '왼쪽';
  const laneLabel = { LEFT: '왼쪽 측면', CENTER: '중앙', RIGHT: '오른쪽 측면' }[lane];
  // Left/right are relative to the attacking player, not the viewer.
  const bandIndex = lane === 'CENTER' ? 1 : ((lane === 'LEFT') === right ? 0 : 2);
  const bandHeight = 172 / 3;
  const bandTop = 18 + bandIndex * bandHeight;
  const arrowY = bandTop + bandHeight / 2;
  return (
    <figure className="fla-direction-pitch" data-team={team} data-direction={right ? 'L2R' : 'R2L'} data-lane={lane}>
      <figcaption>
        <span className="fla-direction-team">{team === 'HOME' ? 'HOME' : 'AWAY'} · {teamName}</span>
        <strong>{right ? '오른쪽으로 공격 →' : '← 왼쪽으로 공격'}</strong>
        <span className="fla-direction-lane-label">{laneLabel} · 공격 진행 방향 기준</span>
      </figcaption>
      <svg viewBox="0 0 320 208" role="img" aria-label={`${teamName}, ${direction} 골문으로 ${laneLabel} 공격`}>
        <rect className="fla-direction-turf" x="1" y="1" width="318" height="206" rx="12" />
        <rect className="fla-direction-lane" x="18" y={bandTop} width="284" height={bandHeight} />
        <path className="fla-direction-lane-dividers" d="M18 75.333h284M18 132.667h284" fill="none" strokeDasharray="4 5" />
        <g className="fla-direction-lines" fill="none" strokeWidth="1.4">
          <rect x="18" y="18" width="284" height="172" rx="1" />
          <path d="M160 18v172M18 55h43v98H18M302 55h-43v98h43M18 78h17v52H18M302 78h-17v52h17M18 92H7v24h11M302 92h11v24h-11" />
          <circle cx="160" cy="104" r="26" />
          <circle cx="160" cy="104" r="2" />
          <path d="M61 86a23 23 0 0 1 0 36M259 86a23 23 0 0 0 0 36" />
        </g>
        <g className="fla-direction-arrow" transform={right ? undefined : 'translate(320 0) scale(-1 1)'}>
          <g className="fla-direction-lane-arrow" transform={`translate(0 ${arrowY - 104})`}>
            <path d="M80 104h158m-24-19 24 19-24 19" fill="none" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="80" cy="104" r="7" />
          </g>
          <path d="M302 79v50" fill="none" strokeWidth="5" strokeLinecap="round" />
        </g>
      </svg>
      <div className="fla-direction-goals" aria-hidden="true"><span>{right ? '우리 골문' : '상대 골문'}</span><span>{right ? '상대 골문' : '우리 골문'}</span></div>
    </figure>
  );
}
