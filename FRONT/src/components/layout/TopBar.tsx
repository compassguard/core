import { AssetChip } from '@/components/wallet/AssetChip';
import { ConnectButton } from '@/components/wallet/ConnectButton';
import { NotificationBell } from '@/components/status/NotificationBell';
import { formatPrimaryWalletBalance } from '@/lib/walletBalances';
import { useWallet } from '@/hooks/useWallet';

const tabs = ['Chat', 'Assets', 'Explore', 'History'];

export function TopBar({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) {
  const { balances, isBalancesLoading, balancesError, highlightBalances, refreshBalances } = useWallet();
  const loading = isBalancesLoading;
  const hasError = Boolean(balancesError);
  const chips = hasError ? [] : [highlightBalances.sol, highlightBalances.usdc].filter(Boolean);

  const formattedTotal = loading ? '—' : formatPrimaryWalletBalance(balances);

  return (
    <header className="sticky top-0 z-30 border-b border-outline bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-20 max-w-[1440px] items-center gap-4 px-4 lg:px-6">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-on-surface-variant">Wallet Copilot</p>
          <div className="flex items-center gap-3">
            <p className="text-2xl font-bold tracking-tight text-on-surface tabular-nums">{formattedTotal}</p>
            <div className="hidden gap-2 lg:flex">
              {chips.length > 0 ? (
                chips.map((asset) => <AssetChip key={asset!.mint} asset={asset!} />)
              ) : loading ? (
                <>
                  <span className="inline-flex h-8 min-w-12 animate-pulse rounded-full bg-surface-hover" />
                  <span className="inline-flex h-8 min-w-12 animate-pulse rounded-full bg-surface-hover" />
                </>
              ) : (
                <span className="text-sm text-on-surface-variant">No highlighted assets</span>
              )}
            </div>
            {hasError ? (
              <button
                type="button"
                onClick={() => {
                  void refreshBalances();
                }}
                className="rounded-md border border-outline px-2 py-1 text-xs font-semibold text-on-surface-variant transition hover:bg-surface-hover hover:text-on-surface"
              >
                Retry balance
              </button>
            ) : null}
          </div>
        </div>

        <nav className="hidden rounded-full border border-outline bg-surface p-1 shadow-sm md:flex">
          {tabs.map((tab) => (
            <button key={tab} onClick={() => onTabChange(tab)} className={`rounded-full px-4 py-2 text-sm font-semibold transition ${activeTab === tab ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-hover hover:text-on-surface'}`}>
              {tab}
            </button>
          ))}
        </nav>

        <NotificationBell />
        <div className="hidden sm:block"><ConnectButton /></div>
      </div>
    </header>
  );
}
