'use client';

import { useEffect, useRef, useState } from 'react';

const tabs = new Set(['tracking', 'work', 'guide']);

export default function FpaTrackingWorkspace({ source, localPreview, initialJob }: {
  source: string; localPreview: boolean; initialJob?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(820);
  const [url, setUrl] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const target = new URL(source, location.origin);
    target.searchParams.set('embed', 'console');
    if (initialJob) target.searchParams.set('job', initialJob);
    const tab = location.hash.slice(1);
    target.hash = tabs.has(tab) ? tab : initialJob ? 'work' : 'tracking';
    setUrl(target.href);
    function receive(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.origin !== target.origin) return;
      const data = event.data;
      if (!data || data.type !== 'fpa-cv:workspace') return;
      if (Number.isFinite(data.height) && data.height >= 400 && data.height <= 25000) setHeight(Math.ceil(data.height));
      if (tabs.has(data.tab)) {
        const page = new URL(location.href);
        page.hash = data.tab;
        if (typeof data.job === 'string' && /^(existing|[a-f0-9]{32})$/.test(data.job)) page.searchParams.set('job', data.job);
        else page.searchParams.delete('job');
        window.history.replaceState(window.history.state, '', page);
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [source, initialJob]);
  return <section aria-label="풋살 영상 분석" style={{ minWidth: 0 }}>
    {localPreview && <p className="muted" style={{ margin: '0 0 12px' }}>로컬 미리보기 · AWS 연결 전</p>}
    {!loaded && <p role="status">분석 화면을 불러오는 중입니다.</p>}
    {url && <iframe ref={frame} title="풋살 FPA 영상 분석" src={url} allow="fullscreen" onLoad={() => setLoaded(true)}
      style={{ display: 'block', width: '100%', height, border: 0, borderRadius: 12, background: '#0c1119' }} />}
  </section>;
}
