import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { ConnectButton } from '@/components/wallet/ConnectButton';
import { useWallet } from '@/hooks/useWallet';
import { DesktopShell } from './DesktopShell';
import { MobileShell } from './MobileShell';

export function AppShell() {
  const wallet = useWallet();
  const [activeTab, setActiveTab] = useState('Chat');

  if (!wallet.isConnected) {
    return <PreLogin />;
  }

  return (
    <>
      <div className="hidden md:block"><DesktopShell activeTab={activeTab} onTabChange={setActiveTab} /></div>
      <div className="md:hidden"><MobileShell activeTab={activeTab} onTabChange={setActiveTab} /></div>
    </>
  );
}

function PreLogin() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="mx-auto max-w-xl text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
          <MessageCircle className="h-8 w-8" />
        </div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Converge Wallet Copilot</p>
        <h1 className="mt-4 text-5xl font-bold tracking-tight text-on-surface">An agent-first wallet for Solana</h1>
        <p className="mt-5 text-lg leading-8 text-on-surface-variant">Connect your Phantom wallet, chat with your wallet copilot, and let the backend agent handle transaction execution safely.</p>
        <div className="mt-8 flex justify-center"><ConnectButton /></div>
      </div>
    </main>
  );
}
