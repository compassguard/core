import * as React from 'react';
import { useMemo, useState } from 'react';
import { AccountCard } from '../sidebar/AccountCard';
import { ChatHistoryList } from '../sidebar/ChatHistoryList';
import { QuickActionsList } from '../sidebar/QuickActionsList';
import { SettingsSheet } from '../sidebar/SettingsSheet';
import { ChatContainer } from '../chat/ChatContainer';
import { RightPanel } from './RightPanel';
import { TopBar } from './TopBar';
import { AssetList } from '../wallet/AssetList';
import { useWallet } from '../../hooks/useWallet';
import { useTransactionHistory } from '../../hooks/useTransactionHistory';
import type { TxHistoryItem } from '../../types/api';

export function DesktopShell({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const wallet = useWallet();
  const history = useTransactionHistory(wallet.address, activeTab === 'History');
  const transactions = useMemo(
    () => history.data?.pages.flatMap((page) => page.transactions) ?? [],
    [history.data],
  );

  return (
    <div className="min-h-screen bg-background">
      <TopBar activeTab={activeTab} onTabChange={onTabChange} />
      <div className="mx-auto grid max-w-[1440px] grid-cols-[280px_minmax(0,1fr)_320px] gap-6 px-6 py-6">
        <aside className="space-y-4">
          <AccountCard />
          <ChatHistoryList />
          <QuickActionsList onSettings={() => setSettingsOpen(true)} />
        </aside>
        <main className="flex min-h-[calc(100vh-8rem)] min-w-0 flex-col">
          {activeTab === 'Chat'
            ? <ChatContainer />
            : activeTab === 'Assets'
              ? <AssetList assets={wallet.balances?.balances} />
              : activeTab === 'History'
                ? (
                  <HistoryView
                    isLoading={history.isLoading}
                    items={transactions}
                    isError={Boolean(history.error)}
                    error={history.error}
                    hasNext={history.hasNextPage}
                    isLoadingMore={history.isFetchingNextPage}
                    onLoadMore={history.fetchNextPage}
                  />
                )
                : <ExplorePlaceholder />
          }
        </main>
        <RightPanel />
      </div>
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function ExplorePlaceholder() {
  return <div className="rounded-lg border border-outline bg-surface p-8 text-on-surface-variant shadow-sm">Explore is a phase 2 placeholder.</div>;
}

function formatHistoryAmount(item: TxHistoryItem): string {
  if (item.amount === undefined || !item.amount_symbol) {
    return 'Amount unavailable';
  }

  const absAmount = Math.abs(item.amount);
  const sign = item.amount > 0 ? '+' : item.amount < 0 ? '-' : '';
  const formattedAmount = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 9,
  }).format(absAmount);

  return `${sign}${formattedAmount} ${item.amount_symbol}`;
}

function HistoryView({
  isLoading,
  items,
  isError,
  error,
  hasNext,
  isLoadingMore,
  onLoadMore,
}: {
  isLoading: boolean;
  items: TxHistoryItem[];
  isError: boolean;
  error?: unknown;
  hasNext: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => Promise<unknown>;
}) {
  const errorMessage = error instanceof Error ? error.message : 'Unable to load public transaction history.';

  if (isLoading) {
    return <div className="space-y-3 rounded-lg border border-outline bg-surface p-8 text-on-surface-variant shadow-sm">Loading public history...</div>;
  }

  if (isError) {
    return (
      <div className="space-y-2 rounded-lg border border-outline bg-surface p-8 text-on-surface-variant shadow-sm">
        <p>Unable to load public transaction history.</p>
        <p className="text-sm">{errorMessage}</p>
        <p className="text-xs">This is public on-chain activity only. Umbra private history requires a separate consent-based integration.</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="space-y-2 rounded-lg border border-outline bg-surface p-8 text-on-surface-variant shadow-sm">
        <p>No public transactions found.</p>
        <p className="text-xs">This tab only shows public on-chain activity. Umbra private history is not enabled in this phase and requires explicit consent and separate tooling.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-outline bg-surface p-4 shadow-sm">
      <p className="text-xs text-on-surface-variant">
        This tab shows public on-chain activity only. Umbra private activity is disabled in this phase and requires a consent-based integration.
      </p>
      {items.map((item) => (
        <div key={item.tx_hash} className="rounded-md bg-background p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-on-surface">{item.summary}</p>
              <p className="text-xs text-on-surface-variant">{new Date(item.timestamp).toLocaleString()} - {item.status}</p>
              <p className="text-xs text-on-surface-variant">Type: {item.type}</p>
            </div>
            <div className="min-w-[112px] text-right">
              <p className="text-sm font-semibold text-on-surface">{formatHistoryAmount(item)}</p>
              <p className="text-xs text-on-surface-variant">Net wallet change</p>
            </div>
            <a
              href={item.explorer_url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-outline px-2 py-1 text-xs text-on-surface-variant transition hover:bg-surface-hover"
            >
              Explorer
            </a>
          </div>
        </div>
      ))}
      {hasNext ? (
        <button
          type="button"
          className="w-full rounded-md border border-outline bg-surface-hover px-4 py-2 text-sm font-semibold text-on-surface transition hover:bg-background"
          onClick={() => {
            void onLoadMore();
          }}
          disabled={isLoadingMore}
        >
          {isLoadingMore ? 'Loading more...' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
