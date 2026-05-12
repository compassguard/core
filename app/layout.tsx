import type { Metadata } from 'next';
import '../front/src/styles/globals.css';

export const metadata: Metadata = {
  title: 'Wallet Copilot',
  description: 'Agent-first wallet copilot for Solana.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
