import { ChatContainer } from '@/components/chat/ChatContainer';
import { AssetList } from '@/components/wallet/AssetList';
import { BalanceCard } from '@/components/wallet/BalanceCard';
import { ConditionalOrdersPanel } from '@/components/wallet/ConditionalOrdersPanel';
import { ConnectButton } from '@/components/wallet/ConnectButton';
import { useWallet } from '@/hooks/useWallet';
import { BottomNav } from './BottomNav';

export function MobileShell({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) {
  const wallet = useWallet();

  return (
    <div className="min-h-screen bg-background pb-20">
      <header className="sticky top-0 z-30 border-b border-outline bg-background/90 p-4 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-on-surface-variant">Wallet Copilot</p>
            <p className="text-lg font-bold text-on-surface">Chat</p>
          </div>
          <ConnectButton />
        </div>
      </header>
      <main className="space-y-4 p-4">
        {activeTab === 'Chat' ? (
          <>
            <BalanceCard data={wallet.balances} isLoading={wallet.isBalancesLoading} isError={Boolean(wallet.balancesError)} />
            <ConditionalOrdersPanel userAddress={wallet.address} />
            <div className="h-[calc(100vh-18rem)]"><ChatContainer /></div>
          </>
        ) : activeTab === 'Assets' ? (
          <>
            <ConditionalOrdersPanel userAddress={wallet.address} />
            <AssetList assets={wallet.balances?.balances} />
          </>
        ) : activeTab === 'History' ? (
          <div className="rounded-3xl border border-outline bg-surface p-6 text-on-surface-variant">History will load from backend.</div>
        ) : (
          <div className="rounded-3xl border border-outline bg-surface p-6 text-on-surface-variant">Explore is a placeholder.</div>
        )}
      </main>
      <BottomNav activeTab={activeTab} onTabChange={onTabChange} />
    </div>
  );
}
