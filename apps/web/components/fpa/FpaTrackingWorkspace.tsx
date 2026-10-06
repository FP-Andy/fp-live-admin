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
    let scheduled=false;
    function publishViewport(){
      if(scheduled)return;scheduled=true;
      requestAnimationFrame(()=>{
        scheduled=false;const node=frame.current;if(!node)return;
        const rect=node.getBoundingClientRect(),viewport=window.visualViewport;
        const top=viewport?.offsetTop||0,bottom=top+(viewport?.height||window.innerHeight);
        const visibleTop=Math.max(0,top-rect.top),visibleBottom=Math.min(rect.height,bottom-rect.top);
        if(visibleBottom>visibleTop)node.contentWindow?.postMessage({type:'fpa-cv:viewport',top:visibleTop,height:visibleBottom-visibleTop},target.origin);
      });
    }
    function receive(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.origin !== target.origin) return;
      const data = event.data;
      if (!data || data.type !== 'fpa-cv:workspace') return;
      publishViewport();
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
    window.addEventListener('scroll',publishViewport,true);window.addEventListener('resize',publishViewport);
    window.visualViewport?.addEventListener('resize',publishViewport);window.visualViewport?.addEventListener('scroll',publishViewport);
    const observer=new ResizeObserver(publishViewport);if(frame.current)observer.observe(frame.current);
    return () => {window.removeEventListener('message', receive);window.removeEventListener('scroll',publishViewport,true);window.removeEventListener('resize',publishViewport);window.visualViewport?.removeEventListener('resize',publishViewport);window.visualViewport?.removeEventListener('scroll',publishViewport);observer.disconnect();};
  }, [source, initialJob,loaded]);
  return <section aria-label="풋살 영상 분석" style={{ minWidth: 0 }}>
    {localPreview && <p className="muted" style={{ margin: '0 0 12px' }}>로컬 미리보기 · AWS 연결 전</p>}
    {!loaded && <p role="status">분석 화면을 불러오는 중입니다.</p>}
    {url && <iframe ref={frame} title="풋살 FPA 영상 분석" src={url} allow="fullscreen" onLoad={() => setLoaded(true)}
      style={{ display: 'block', width: '100%', height, border: 0, borderRadius: 12, background: '#0c1119' }} />}
  </section>;
}
