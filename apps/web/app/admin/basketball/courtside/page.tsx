'use client';

import { useEffect, useRef } from 'react';
import { courtsideEnabled } from '../../../../lib/courtside-feature';

/** Keep the original Courtside workspace inside the authenticated FPC shell. */
export default function CourtsidePage() {
  const frame = useRef<HTMLIFrameElement>(null);
  const cleanupHeader = useRef<() => void>(() => {});

  function syncTheme() {
    try {
      const doc = frame.current?.contentDocument;
      if (doc) doc.documentElement.dataset.consoleTheme = document.documentElement.dataset.consoleTheme === 'dark' ? 'dark' : 'light';
    } catch { /* The frame may be navigating. */ }
  }
  useEffect(() => {
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-console-theme'] });
    return () => { observer.disconnect(); cleanupHeader.current(); };
  }, []);

  function connectNavigation() {
    const view = frame.current?.contentWindow;
    if (!view) return;
    try {
      syncTheme();
      if (!view.document.getElementById('fpc-embedded-layout')) {
        const style = view.document.createElement('style');
        style.id = 'fpc-embedded-layout';
        style.textContent = 'body > header{padding-left:68px!important;padding-right:76px!important}';
        view.document.head.append(style);
      }
      cleanupHeader.current();
      const topbar = document.querySelector<HTMLElement>('.courtside-topbar');
      const alignHeaderControls = () => {
        const header = view.document.querySelector<HTMLElement>('body > header');
        if (!topbar || !header || !frame.current) return;
        const headerRect = header.getBoundingClientRect();
        const frameRect = frame.current.getBoundingClientRect();
        const barRect = topbar.getBoundingClientRect();
        topbar.style.setProperty('--courtside-control-y', `${frameRect.top - barRect.top + headerRect.top + headerRect.height / 2}px`);
        topbar.dataset.headerVisible = headerRect.bottom > headerRect.height / 2 ? 'true' : 'false';
      };
      view.addEventListener('scroll', alignHeaderControls, { passive: true });
      window.addEventListener('resize', alignHeaderControls);
      alignHeaderControls();
      cleanupHeader.current = () => { view.removeEventListener('scroll', alignHeaderControls); window.removeEventListener('resize', alignHeaderControls); };
      const path = view.location.pathname;
      const match = path.match(/^\/api\/courtside\/matches\/([0-9a-f-]+)\/(?:cases|intakes)\/[^/]+\/bridge\//i);
      if (!match) return;
      view.document.addEventListener('click', event => {
        const target = event.target as Element | null;
        const anchor = target?.closest?.('a');
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        if (anchor.id === 'matchBack' || href?.startsWith('./match.html?')) {
          event.preventDefault();
          view.location.assign(`/kbl-grayzone/fpc-match.html?id=${encodeURIComponent(match[1])}`);
        } else if (href === './' || href === '.' || href === './index.html') {
          event.preventDefault();
          view.location.assign('/kbl-grayzone/fpc-library.html');
        }
      }, true);
    } catch {
      // The workspace is same-origin; fail closed if a navigation leaves it.
    }
  }

  if (!courtsideEnabled) return <div role="status">코트사이드를 준비하고 있습니다.</div>;
  return <iframe
    ref={frame}
    className="courtside-frame"
    title="코트사이드 경기 라이브러리와 판독 작업"
    src="/kbl-grayzone/fpc-library.html"
    onLoad={connectNavigation}
  />;
}
