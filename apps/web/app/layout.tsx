import './globals.css';
import type { Metadata } from 'next';
import PwaRegistrar from '../components/PwaRegistrar';

export const metadata: Metadata = {
  title: 'Live Match Admin',
  description: 'Production-oriented match operation console',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Live Admin',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

export const viewport = {
  themeColor: '#ff7400',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/fonts-archive/Pretendard/Pretendard.css"
        />
      </head>
      <body>
        <PwaRegistrar />
        {children}
      </body>
    </html>
  );
}
