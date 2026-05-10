import type { TokenBalance } from '../types/api';
import type { GetBalancesResponse } from '../types/api';
import type { AllocationItem } from '../types/api';
import { formatTokenAmount, formatUsd } from './format';

export const SOL_MINT_MAINNET = 'So11111111111111111111111111111111111111112';
export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type HighlightBalances = {
  sol?: TokenBalance;
  usdc?: TokenBalance;
};

export function getHighlightBalances(balances?: TokenBalance[]): HighlightBalances {
  const tokenBalances = balances ?? [];
  return {
    sol: tokenBalances.find((token) => token.mint === SOL_MINT_MAINNET),
    usdc: tokenBalances.find((token) => token.mint === USDC_MINT_MAINNET),
  };
}

export function formatPrimaryWalletBalance(data?: GetBalancesResponse): string {
  if (!data) return '—';
  if (data.total_usd > 0) return formatUsd(data.total_usd);

  const { sol } = getHighlightBalances(data.balances);
  if (sol) return `${formatTokenAmount(sol.ui_amount)} SOL`;

  return formatUsd(data.total_usd);
}

function getAllocationValue(token: TokenBalance): number {
  if (token.usd_value > 0) {
    return token.usd_value;
  }

  return token.ui_amount;
}

export function getAllocationFromBalances(balances?: TokenBalance[]): AllocationItem[] {
  const relevant = (balances ?? []).filter((token) => token.ui_amount >= 0);
  if (relevant.length === 0) return [];

  const weighted = relevant
    .map((token) => ({ token, value: getAllocationValue(token) }))
    .filter((entry) => entry.value > 0);

  const totalValue = weighted.reduce((sum, entry) => sum + entry.value, 0);
  if (totalValue <= 0) return [];

  return weighted
    .map((entry) => ({
      symbol: entry.token.symbol,
      percentage: Number(((entry.value / totalValue) * 100).toFixed(1)),
    }))
    .filter((item) => item.percentage > 0);
}
