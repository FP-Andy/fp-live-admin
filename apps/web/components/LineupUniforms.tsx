type KitPart = { label?: string; hex?: string | null };
type Kit = { shirt?: KitPart; shorts?: KitPart; socks?: KitPart };
type Lineup = { team_names?: Record<string, string>; uniforms?: Record<string, { field?: Kit; goalkeeper?: Kit }>; detected_by?: string };

export default function LineupUniforms({ lineup }: { lineup?: Lineup }) {
  if (!lineup?.uniforms || !Object.values(lineup.uniforms).some(kit => kit.field || kit.goalkeeper)) return null;
  return <section className="lineup-uniforms" aria-label="PDF에서 인식한 유니폼">
    <div className="lineup-uniform-heading"><strong>PDF 유니폼 정보</strong><span className="muted">{lineup.detected_by === 'manual' ? '지정한 홈·어웨이 방향' : '홈·어웨이 자동 인식'}</span></div>
    <div className="lineup-uniform-grid">{(['HOME', 'AWAY'] as const).map(side => <article key={side} className="lineup-uniform-team">
      <h4><span className="muted">{side === 'HOME' ? '홈' : '어웨이'}</span> {lineup.team_names?.[side] || side}</h4>
      {(['field', 'goalkeeper'] as const).map(role => <div className="lineup-uniform-row" key={role}><span>{role === 'field' ? '필드' : '골키퍼'}</span><div>{(['shirt', 'shorts', 'socks'] as const).map(part => {
        const value = lineup.uniforms?.[side]?.[role]?.[part];
        return <span className="lineup-kit-part" key={part}><small className="muted">{{ shirt: '상의', shorts: '하의', socks: '양말' }[part]}</small><i style={{ background: value?.hex || 'transparent' }} /><span>{value?.label || '정보 없음'}</span></span>;
      })}</div></div>)}
    </article>)}</div>
    <p className="muted">필드 상의 색상을 Broadcast에 자동 적용합니다. 색상명 기준의 대표 색이며, Broadcast에서 조정할 수 있습니다.</p>
  </section>;
}
