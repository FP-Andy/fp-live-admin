type FpaPlaceholderPageProps = {
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
};

export default function FpaPlaceholderPage({
  eyebrow,
  title,
  description,
  bullets,
}: FpaPlaceholderPageProps) {
  return (
    <div className="page-stack">
      <section className="card card-hero page-hero">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">{eyebrow}</div>
            <h2 style={{ margin: '6px 0 0' }}>{title}</h2>
          </div>
          <span className="status-pill tech">FPA</span>
        </div>
        <p className="field-help" style={{ margin: 0, maxWidth: '72ch' }}>
          {description}
        </p>
      </section>

      <section className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {bullets.map((bullet) => (
          <article className="card card-panel" key={bullet}>
            <div className="sidebar-eyebrow">Planned</div>
            <p style={{ margin: '10px 0 0', lineHeight: 1.6 }}>{bullet}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
