import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVNET_SOL_MINT, DEVNET_USDC_MINT, quoteOrcaUsdcToSol } from '../tools/orcaSwap';

const sdkMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  buildWhirlpoolClient: vi.fn(),
  swapQuoteByInputToken: vi.fn(),
}));

vi.mock('../solanaConnection', () => ({
  getConnection: vi.fn(() => ({})),
}));

vi.mock('@orca-so/whirlpools-sdk', () => ({
  IGNORE_CACHE: 'IGNORE_CACHE',
  WhirlpoolContext: {
    from: vi.fn(() => ({
      program: { programId: 'whirlpool-program' },
      fetcher: {},
    })),
  },
  buildWhirlpoolClient: sdkMocks.buildWhirlpoolClient,
  swapQuoteByInputToken: sdkMocks.swapQuoteByInputToken,
}));

function mockWhirlpoolQuote(outputBaseUnits: string, minOutputBaseUnits = outputBaseUnits) {
  sdkMocks.getPool.mockResolvedValue({ address: 'pool' });
  sdkMocks.buildWhirlpoolClient.mockReturnValue({ getPool: sdkMocks.getPool });
  sdkMocks.swapQuoteByInputToken.mockResolvedValue({
    estimatedAmountOut: { toString: () => outputBaseUnits },
    otherAmountThreshold: { toString: () => minOutputBaseUnits },
    tradeFeeAmount: { toString: () => '123' },
  });
}

describe('quoteOrcaUsdcToSol', () => {
  const originalFallbackPrice = process.env.FALLBACK_SOL_USD_PRICE;

  afterEach(() => {
    vi.restoreAllMocks();
    sdkMocks.getPool.mockReset();
    sdkMocks.buildWhirlpoolClient.mockReset();
    sdkMocks.swapQuoteByInputToken.mockReset();
    if (originalFallbackPrice === undefined) {
      delete process.env.FALLBACK_SOL_USD_PRICE;
    } else {
      process.env.FALLBACK_SOL_USD_PRICE = originalFallbackPrice;
    }
  });

  it('uses the Orca Whirlpool quote as the single source for devnet UX quotes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    mockWhirlpoolQuote('659596949', '653000979');

    const quote = await quoteOrcaUsdcToSol({
      input_token: 'USDC',
      output_token: 'SOL',
      input_amount: 60,
      slippage_bps: 100,
    });

    const inputMint = sdkMocks.swapQuoteByInputToken.mock.calls[0]?.[1];
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inputMint?.toBase58()).toBe(DEVNET_USDC_MINT);
    expect(quote.estimated_output_base_units).toBe('659596949');
    expect(quote.min_output_base_units).toBe('653000979');
    expect(quote.input_mint).toBe(DEVNET_USDC_MINT);
    expect(quote.output_mint).toBe(DEVNET_SOL_MINT);
    expect(quote.quote_source).toBe('orca_whirlpool_quote');
  });

  it('uses local SOL/USD fallback and marks quote_source when the Whirlpool quote fails', async () => {
    process.env.FALLBACK_SOL_USD_PRICE = '140';
    sdkMocks.getPool.mockResolvedValue({ address: 'pool' });
    sdkMocks.buildWhirlpoolClient.mockReturnValue({ getPool: sdkMocks.getPool });
    sdkMocks.swapQuoteByInputToken.mockRejectedValue(new Error('whirlpool unavailable'));

    const quote = await quoteOrcaUsdcToSol({
      input_token: 'USDC',
      output_token: 'SOL',
      input_amount: 420,
    });

    expect(quote.estimated_output_base_units).toBe('3000000000');
    expect(quote.quote_source).toBe('fallback_sol_usd');
  });

  it('throws when fallback is disabled and the Whirlpool quote fails', async () => {
    sdkMocks.getPool.mockResolvedValue({ address: 'pool' });
    sdkMocks.buildWhirlpoolClient.mockReturnValue({ getPool: sdkMocks.getPool });
    sdkMocks.swapQuoteByInputToken.mockRejectedValue(new Error('whirlpool unavailable'));

    await expect(
      quoteOrcaUsdcToSol({
        input_token: 'USDC',
        output_token: 'SOL',
        input_amount: 1,
        allow_fallback: false,
      }),
    ).rejects.toThrow('orca_quote_failed:whirlpool unavailable');
  });
});
