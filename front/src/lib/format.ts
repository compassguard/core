export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

export function formatPct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function formatTokenAmount(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value >= 100 ? 2 : 4,
  }).format(value);
}

export function truncateAddress(address?: string, left = 4, right = 4): string {
  if (!address) return '—';
  if (address.length <= left + right + 3) return address;
  return `${address.slice(0, left)}...${address.slice(-right)}`;
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}`;
}
