import type { Metadata } from 'next';
// The old chat-app React tree, including its Tailwind globals, lives under
// legacy/ now. The public landing at `/` is served by app/route.ts from
// landing.html with inline CSS, so no global stylesheet is needed here.

export const metadata: Metadata = {
  title: 'Compass · The execution firewall for Solana AI agents',
  description: 'Compass sits between AI agents, tools and wallets to decode, simulate, approve and audit critical actions before they can be signed.',
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
