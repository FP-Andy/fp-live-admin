export default function FcmTemplatesPage() {
  return (
    <div className="page-stack">
      <section className="card card-hero page-hero">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">FinePlay Card Marker</div>
            <h2 style={{ margin: '6px 0 0' }}>Templates</h2>
          </div>
          <span className="status-pill tech">FCM</span>
        </div>
        <p className="field-help" style={{ margin: 0, maxWidth: '72ch' }}>
          팀별 배경 템플릿, 홈/어웨이 선택 규칙, 카드 레이아웃 프리셋을 관리할 영역입니다. 이후 실제 팀별
          배경 자산을 연결해 자동 매칭 흐름으로 확장합니다.
        </p>
      </section>
    </div>
  );
}
