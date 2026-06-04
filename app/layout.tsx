import type { Metadata } from 'next';
import '../front/src/styles/globals.css';

export const metadata: Metadata = {
  title: 'Compass · Security layer for AI agents',
  description: 'MCP execution firewall and security layer for AI agents operating on Solana.',
  icons: {
    icon: [
      { url: '/compass-icon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/compass-icon.png', type: 'image/png', sizes: '256x256' },
    ],
    shortcut: '/compass-icon.png',
    apple: '/compass-icon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
