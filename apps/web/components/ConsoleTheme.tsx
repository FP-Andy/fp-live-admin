'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import ConsoleIcon from './ConsoleIcon';

type Theme = 'dark' | 'light';
const ThemeContext = createContext({ theme: 'dark' as Theme, toggle: () => {} });
const STORAGE_KEY = 'fpc.theme';

export function ConsoleThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    setTheme(document.documentElement.dataset.consoleTheme === 'light' ? 'light' : 'dark');
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        const next = event.newValue === 'light' ? 'light' : 'dark';
        document.documentElement.dataset.consoleTheme = next;
        setTheme(next);
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.consoleTheme = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Works without storage. */ }
    setTheme(next);
  };
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle() {
  const { theme, toggle } = useContext(ThemeContext);
  const label = theme === 'dark' ? '화이트 모드' : '다크 모드';
  return <button type="button" className="console-theme-toggle" onClick={toggle} aria-label={`${label}로 전환`} title={`${label}로 전환`}>
    <ConsoleIcon name={theme === 'dark' ? 'sun' : 'moon'} /><span>{label}</span>
  </button>;
}
