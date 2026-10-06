// FPC hosts this same workbench. Only the known parent can receive navigation
// and dimensions; review data and credentials never leave this page.
export function connectConsole() {
  if (window.parent === window || new URLSearchParams(location.search).get('embed') !== 'console') return;
  let parent;
  try { parent = new URL(document.referrer); } catch { return; }
  const loopback = url => url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (parent.origin !== location.origin && !(loopback(parent) && loopback(new URL(location.href)))) return;
  document.documentElement.classList.add('console-embed');
  window.addEventListener('message',event=>{
    if(event.source!==window.parent||event.origin!==parent.origin||event.data?.type!=='fpa-cv:viewport')return;
    const {top,height}=event.data;
    if(!Number.isFinite(top)||!Number.isFinite(height)||top<0||top>25000||height<=0||height>25000)return;
    document.documentElement.style.setProperty('--console-visible-top',`${top}px`);
    document.documentElement.style.setProperty('--console-visible-height',`${height}px`);
  });
  let scheduled = false;
  function publish() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      window.parent.postMessage({
        type: 'fpa-cv:workspace',
        height: Math.max(400, Math.ceil(document.body.getBoundingClientRect().height)),
        tab: location.hash.slice(1) || 'tracking',
        job: new URLSearchParams(location.search).get('job'),
      }, parent.origin);
    });
  }
  new ResizeObserver(publish).observe(document.body);
  window.addEventListener('fpa-cv:navigation', publish);
  window.addEventListener('hashchange', publish);
  publish();
}
