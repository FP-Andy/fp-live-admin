import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Live Match Admin',
  description: 'Production-oriented match operation console'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
