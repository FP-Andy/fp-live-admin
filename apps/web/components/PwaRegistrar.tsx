'use client';

import { useEffect } from 'react';

export default function PwaRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = async () => {
      try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      } catch (error) {
        console.warn('Service worker registration failed', error);
      }
    };

    register();
  }, []);

  return null;
}
