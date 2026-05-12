import { ArrowUpRight, RefreshCw } from 'lucide-react';
import type { GetBalancesResponse } from '@/types/api';
import { useWallet } from '@/hooks/useWallet';
import { formatPct } from '@/lib/format';
import { formatPrimaryWalletBalance } from '@/lib/walletBalances';

interface BalanceCardProps {
  data?: GetBalancesResponse;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}

export function BalanceCard({ data, isLoading, isError, onRetry }: BalanceCardProps) {
  const wallet = useWallet();
  const effectiveData = data ?? wallet.balances;
  const effectiveLoading = isLoading ?? wallet.isBalancesLoading;
  const effectiveError = isError ?? Boolean(wallet.balancesError);
  const effectiveOnRetry = onRetry ?? wallet.refreshBalances;

  if (effectiveLoading) {
    return <div className="h-36 animate-pulse rounded-2xl border border-outline bg-surface" />;
  }

  if (effectiveError) {
    return (
      <div className="rounded-2xl border border-outline bg-surface p-6 shadow-sm">
        <p className="text-sm text-on-surface-variant">Balance unavailable</p>
        <button
          onClick={() => {
            void effectiveOnRetry();
          }}
          className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary"
        >
          <RefreshCw className="h-4 w-4" /> Retry
        </button>
      </div>
    );
  }

  const hasData = Boolean(effectiveData);
  const change = effectiveData?.change_24h_pct;
  const hasChange = typeof change === 'number';
  const positive = hasChange && change >= 0;

  return (
    <div className="rounded-3xl border border-outline bg-surface p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-on-surface-variant">Total Balance</p>
          <p className="mt-2 text-4xl font-bold tracking-tight text-on-surface tabular-nums md:text-5xl">
            {hasData ? formatPrimaryWalletBalance(effectiveData) : '—'}
          </p>
        </div>
        <div className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold ${!hasChange ? 'bg-surface-hover text-on-surface-variant' : positive ? 'bg-success-bg text-success' : 'bg-error-bg text-error-text'}`}>
          {hasChange ? <ArrowUpRight className={`h-4 w-4 ${positive ? '' : 'rotate-90'}`} /> : null}
          {hasChange ? formatPct(change) : '—'}
        </div>
      </div>
      <p className="mt-4 text-xs text-on-surface-variant">
        Updated {effectiveData?.updated_at ? new Date(effectiveData.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
      </p>
      {hasData && effectiveData?.balances.length === 0 ? <p className="mt-2 text-sm text-on-surface-variant">No assets found.</p> : null}
    </div>
  );
}
