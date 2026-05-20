'use client';

import { useEffect } from 'react';

export default function PwaRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .then(() => {
          if ('caches' in window) {
            return caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
          }
          return undefined;
        })
        .catch((error) => console.warn('Service worker cleanup failed', error));
      return;
    }

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
