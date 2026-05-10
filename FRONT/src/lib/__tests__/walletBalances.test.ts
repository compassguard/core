import { describe, expect, it } from 'vitest';
import type { TokenBalance } from '../../types/api';
import { formatPrimaryWalletBalance, getAllocationFromBalances, SOL_MINT_MAINNET } from '../walletBalances';

describe('formatPrimaryWalletBalance', () => {
  it('falls back to SOL when total_usd is zero but real SOL is present', () => {
    expect(
      formatPrimaryWalletBalance({
        total_usd: 0,
        updated_at: new Date().toISOString(),
        balances: [
          {
            symbol: 'SOL',
            mint: SOL_MINT_MAINNET,
            amount: '7900000000',
            decimals: 9,
            ui_amount: 7.9,
            usd_value: 0,
          },
        ],
      }),
    ).toBe('7.9 SOL');
  });

  it('derives allocation percentages from available balance values when usd_value is not set', () => {
    const balances: TokenBalance[] = [
      {
        symbol: 'SOL',
        mint: SOL_MINT_MAINNET,
        amount: '5000000000',
        decimals: 9,
        ui_amount: 5,
        usd_value: 0,
      },
    ];

    expect(getAllocationFromBalances(balances)).toEqual([{ symbol: 'SOL', percentage: 100 }]);
  });

  it('ignores non-positive balances in allocation math so empty wallets do not render bogus segments', () => {
    const balances: TokenBalance[] = [
      {
        symbol: 'SOL',
        mint: SOL_MINT_MAINNET,
        amount: '0',
        decimals: 9,
        ui_amount: 0,
        usd_value: 0,
      },
    ];

    expect(getAllocationFromBalances(balances)).toEqual([]);
  });
});
