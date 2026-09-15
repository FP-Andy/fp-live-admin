/** Small, consistent stroke icons for console navigation. */
export default function ConsoleIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    Dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    Media: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3Z" /></>,
    'Live Coder': <><path d="M3 12h3l3-7 5 14 3-7h4" /></>,
    'Live Logger': <><path d="M13 4H5v16h14v-8M8 9h3m-3 5h2m6-11 5 5-7 7-5 1 1-5Z" /></>,
    System: <><path d="m9 3-1 3-3 1-2 4 2 2v4l4 3 3-1 3 1 4-3v-4l2-2-2-4-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></>,
    Visualization: <><path d="M4 3v17h17M8 16v-5m5 5V7m5 9V4" /></>,
    'AI+Log': <><path d="m10 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2Zm9 11 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z" /></>,
    FinePlay: <><path d="m10 8 6 4-6 4Z" /><path d="M7 3H4v5m13-5h3v5M4 16v5h3m13-5v5h-3" /></>,
    '중계 오버레이': <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M6 8h5v3H6Zm3 13h6m-3-3v3m2-7h4" /></>,
    'Model Room': <><path d="m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5" /></>,
    'Scene Motion': <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4ZM3 3v5h5" /></>,
    'Code Guide': <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 20" /></>,
    Workspace: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 5V3h8v2M3 11h18m-12 0v10" /></>,
    'Match Status': <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4m8-4v4M4 10h16m-11 5 2 2 4-4" /></>,
    Templates: <><rect x="3" y="3" width="8" height="18" rx="1.5" /><rect x="15" y="3" width="6" height="7" rx="1.5" /><rect x="15" y="14" width="6" height="7" rx="1.5" /></>,
    Guide: <><path d="M12 6c-3-3-7-3-9-2v15c3-1 6-1 9 2 3-3 6-3 9-2V4c-2-1-6-1-9 2Zm0 0v15" /></>,
    'Queen Cup Cards': <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m6 8 3 2 3-4 3 4 3-2-2 7H8Zm2 10h8" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
    moon: <path d="M20.5 14a9 9 0 0 1-10.5-10.5A9 9 0 1 0 20.5 14Z" />,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    data: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></>,
    logout: <><path d="M9 4H4v16h5m6-12 4 4-4 4M9 12h10" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 15v-3m5 3V8m5 7v-5" /></>}</svg>;
}
