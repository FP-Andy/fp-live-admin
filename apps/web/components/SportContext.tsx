'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Sport = 'FOOTBALL' | 'BASKETBALL';

export const SPORTS: Array<{ value: Sport; label: string; shortLabel: string }> = [
  { value: 'FOOTBALL', label: 'Football', shortLabel: 'FB' },
  { value: 'BASKETBALL', label: 'Basketball', shortLabel: 'BB' },
];

const STORAGE_KEY = 'fineplay.selectedSport';

type SportContextValue = {
  sport: Sport;
  setSport: (sport: Sport) => void;
};

const SportContext = createContext<SportContextValue | null>(null);

function normalizeSport(value: string | null | undefined): Sport {
  return value === 'BASKETBALL' ? 'BASKETBALL' : 'FOOTBALL';
}

export function SportProvider({ children }: { children: React.ReactNode }) {
  const [sport, setSportState] = useState<Sport>('FOOTBALL');

  useEffect(() => {
    setSportState(normalizeSport(window.localStorage.getItem(STORAGE_KEY)));
  }, []);

  const value = useMemo<SportContextValue>(() => ({
    sport,
    setSport: (nextSport) => {
      setSportState(nextSport);
      window.localStorage.setItem(STORAGE_KEY, nextSport);
    },
  }), [sport]);

  return <SportContext.Provider value={value}>{children}</SportContext.Provider>;
}

export function useSportContext() {
  const value = useContext(SportContext);
  if (!value) {
    throw new Error('useSportContext must be used inside SportProvider');
  }
  return value;
}
