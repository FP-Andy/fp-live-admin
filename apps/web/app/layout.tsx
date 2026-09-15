import './globals.css';
import './console-theme.css';
import './console-workspaces.css';
import './console-appearance.css';
import type { Metadata } from 'next';
import PwaRegistrar from '../components/PwaRegistrar';
import { ConsoleThemeProvider } from '../components/ConsoleTheme';

export const metadata: Metadata = {
  title: 'Fine Play Console',
  description: 'Unified operations workspace for FLA and FPA',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Fine Play Console',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icons/fpc-icon-192.png',
  },
};

export const viewport = {
  themeColor: '#282828',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{document.documentElement.dataset.consoleTheme=localStorage.getItem('fpc.theme')==='light'?'light':'dark'}catch(e){document.documentElement.dataset.consoleTheme='dark'}` }} />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/fonts-archive/Pretendard/Pretendard.css"
        />
      </head>
      <body>
        <PwaRegistrar />
        <ConsoleThemeProvider>{children}</ConsoleThemeProvider>
      </body>
    </html>
  );
}
