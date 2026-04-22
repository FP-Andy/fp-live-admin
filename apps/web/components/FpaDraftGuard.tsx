'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

export const FPA_DRAFT_STORAGE_KEY = 'fpa-live-draft-v1';
export const FPA_DRAFT_EVENT = 'fpa-draft-state';
export const FPA_DRAFT_WARNING_MESSAGE =
  'FPA 입력 중인 데이터가 있습니다.\n\n/admin/fpa 내부에서는 유지되지만, 이 영역을 벗어나면 입력 내용이 사라질 수 있습니다.\n\n계속 이동할까요?';

export function hasFpaDraft() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.sessionStorage.getItem(FPA_DRAFT_STORAGE_KEY));
}

export function clearFpaDraft() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(FPA_DRAFT_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(FPA_DRAFT_EVENT, { detail: { hasDraft: false } }));
}

export default function FpaDraftGuard() {
  const pathname = usePathname();
  const [hasDraftState, setHasDraftState] = useState(false);

  useEffect(() => {
    setHasDraftState(hasFpaDraft());

    const handleDraftState = (event: Event) => {
      const customEvent = event as CustomEvent<{ hasDraft?: boolean }>;
      if (typeof customEvent.detail?.hasDraft === 'boolean') {
        setHasDraftState(customEvent.detail.hasDraft);
        return;
      }
      setHasDraftState(hasFpaDraft());
    };

    window.addEventListener(FPA_DRAFT_EVENT, handleDraftState as EventListener);
    return () => {
      window.removeEventListener(FPA_DRAFT_EVENT, handleDraftState as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!pathname?.startsWith('/admin/fpa') || !hasDraftState) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    const handleClickCapture = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (
        anchor.target === '_blank' ||
        anchor.hasAttribute('download') ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      let nextPath = href;
      try {
        nextPath = new URL(href, window.location.href).pathname;
      } catch {
        nextPath = href;
      }

      if (nextPath.startsWith('/admin/fpa')) return;

      const ok = window.confirm(FPA_DRAFT_WARNING_MESSAGE);
      if (!ok) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      clearFpaDraft();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleClickCapture, true);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleClickCapture, true);
    };
  }, [hasDraftState, pathname]);

  return null;
}
