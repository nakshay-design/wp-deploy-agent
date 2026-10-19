import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'WP Deploy Agent',
  description: 'Deploy a WordPress theme and site settings to a live host over FTPS.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
