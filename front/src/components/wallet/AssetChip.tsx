import type { TokenBalance } from '@/types/api';
import { formatTokenAmount } from '@/lib/format';

export function AssetChip({ asset }: { asset: TokenBalance }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-outline bg-surface px-3 py-2 shadow-sm">
      <TokenIcon symbol={asset.symbol} iconUrl={asset.icon_url} />
      <span className="text-sm font-semibold text-on-surface">{asset.symbol}</span>
      <span className="text-sm text-on-surface-variant tabular-nums">{formatTokenAmount(asset.ui_amount)}</span>
    </div>
  );
}

export function TokenIcon({ symbol, iconUrl }: { symbol: string; iconUrl?: string }) {
  return iconUrl ? (
    <img src={iconUrl} alt="" className="h-6 w-6 rounded-full" />
  ) : (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
      {symbol.slice(0, 2)}
    </span>
  );
}
