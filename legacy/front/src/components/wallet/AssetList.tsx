import type { TokenBalance } from '@/types/api';
import { RefreshCw } from 'lucide-react';
import { useWallet } from '@/hooks/useWallet';
import { formatTokenAmount, formatUsd } from '@/lib/format';
import { TokenIcon } from './AssetChip';

interface AssetListProps {
  assets?: TokenBalance[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  emptyMessage?: string;
}

export function AssetList({
  assets,
  isLoading,
  isError,
  onRetry,
  emptyMessage = 'No assets yet.',
}: AssetListProps) {
  const wallet = useWallet();
  const effectiveAssets = assets ?? wallet.balances?.balances ?? [];
  const effectiveLoading = isLoading ?? wallet.isBalancesLoading;
  const effectiveError = isError ?? Boolean(wallet.balancesError);
  const effectiveOnRetry = onRetry ?? wallet.refreshBalances;

  if (effectiveLoading) {
    return <div className="h-32 animate-pulse rounded-2xl border border-outline bg-surface p-3 shadow-sm" />;
  }

  if (effectiveError) {
    return (
      <div className="rounded-2xl border border-outline bg-surface p-4 text-sm text-on-surface-variant">
        <p>Assets unavailable</p>
        <button
          onClick={() => {
            void effectiveOnRetry();
          }}
          className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-primary"
        >
          <RefreshCw className="h-4 w-4" /> Retry
        </button>
      </div>
    );
  }

  if (effectiveAssets.length === 0) {
    return <p className="rounded-2xl border border-outline bg-surface p-4 text-sm text-on-surface-variant">{emptyMessage}</p>;
  }

  return (
    <div className="rounded-2xl border border-outline bg-surface p-3 shadow-sm">
      <div className="mb-2 px-2 text-sm font-semibold text-on-surface">Assets</div>
      <div className="space-y-1">
        {effectiveAssets.map((asset) => (
          <div key={asset.mint} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-hover">
            <TokenIcon symbol={asset.symbol} iconUrl={asset.icon_url} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-on-surface">{asset.symbol}</p>
              <p className="text-xs text-on-surface-variant tabular-nums">{formatTokenAmount(asset.ui_amount)}</p>
            </div>
            <p className="text-sm font-semibold text-on-surface tabular-nums">{formatUsd(asset.usd_value)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
