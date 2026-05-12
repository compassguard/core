import { describe, expect, it } from 'vitest';
import type { TokenBalance } from '../../types/api';
import { getHighlightBalances, SOL_MINT_MAINNET, USDC_MINT_MAINNET } from '../../lib/walletBalances';

describe('getHighlightBalances', () => {
  it('derives SOL and USDC by canonical mainnet-beta mints', () => {
    const balances: TokenBalance[] = [
      {
        symbol: 'USDC',
        mint: USDC_MINT_MAINNET,
        amount: '2500000000',
        decimals: 6,
        ui_amount: 2500,
        usd_value: 2500,
      },
      {
        symbol: 'JUP',
        mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
        amount: '420000000',
        decimals: 6,
        ui_amount: 420,
        usd_value: 357,
      },
      {
        symbol: 'SOL',
        mint: SOL_MINT_MAINNET,
        amount: '125000000000',
        decimals: 9,
        ui_amount: 125,
        usd_value: 18125,
      },
    ];

    const highlighted = getHighlightBalances(balances);
    expect(highlighted.sol?.mint).toBe(SOL_MINT_MAINNET);
    expect(highlighted.usdc?.mint).toBe(USDC_MINT_MAINNET);
    expect(highlighted.sol?.symbol).toBe('SOL');
    expect(highlighted.usdc?.symbol).toBe('USDC');
  });
});
