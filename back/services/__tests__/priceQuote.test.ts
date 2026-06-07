import { afterEach, describe, expect, it, vi } from 'vitest';
import * as orca from '../priceProviders/orcaUsdcSol';
import { getUsdcSolQuote } from '../priceQuote';

const COMMON_QUOTE = {
  input_amount_base_units: '100000000',
  min_output_base_units: '120000000',
  trade_fee_base_units: '100000',
  slippage_bps: 100,
  pool_address: '3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt',
  input_mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
  output_mint: 'So11111111111111111111111111111111111111112',
  quote_source: 'orca_whirlpool_quote' as const,
};

describe('getUsdcSolQuote', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns normalized quote for USDC -> SOL', async () => {
    vi.spyOn(orca, 'quoteOrcaUsdcToSol').mockResolvedValueOnce({
      ...COMMON_QUOTE,
      input_amount_base_units: '1000000',
      estimated_output_base_units: '2000000000',
    });

    const result = await getUsdcSolQuote({
      input_token: 'USDC',
      output_token: 'SOL',
      input_amount: 1,
      network: 'devnet',
    });

    expect(result.network).toBe('devnet');
    expect(result.provider).toBe('orca_whirlpools_devnet');
    expect(result.input_token).toBe('USDC');
    expect(result.output_token).toBe('SOL');
    expect(result.input_amount).toBe(1);
    expect(result.output_amount).toBe(2);
    expect(result.updated_at).toMatch(/T/);
    expect(result.quote_source).toBe('orca_whirlpool_quote');
    expect(orca.quoteOrcaUsdcToSol).toHaveBeenCalledWith(
      expect.objectContaining({
        input_token: 'USDC',
        output_token: 'SOL',
        input_amount: 1,
        allow_fallback: true,
      }),
    );
  });

  it('returns normalized quote for SOL -> USDC', async () => {
    vi.spyOn(orca, 'quoteOrcaUsdcToSol').mockResolvedValueOnce({
      ...COMMON_QUOTE,
      input_amount_base_units: '1000000000',
      estimated_output_base_units: '12300000',
      input_mint: 'So11111111111111111111111111111111111111112',
      output_mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
    });

    const result = await getUsdcSolQuote({
      input_token: 'SOL',
      output_token: 'USDC',
      input_amount: 1,
      network: 'devnet',
    });

    expect(result.input_token).toBe('SOL');
    expect(result.output_token).toBe('USDC');
    expect(result.output_amount).toBe(12.3);
  });

  it('rejects non-cross-pair quotes', async () => {
    await expect(
      getUsdcSolQuote({
        input_token: 'USDC',
        output_token: 'USDC',
        input_amount: 10,
        network: 'devnet',
      }),
    ).rejects.toMatchObject({ code: 'invalid_pair' });
  });

  it('maps quote provider failures to provider error', async () => {
    vi.spyOn(orca, 'quoteOrcaUsdcToSol').mockRejectedValueOnce(new Error('provider down'));
    await expect(
      getUsdcSolQuote({
        input_token: 'USDC',
        output_token: 'SOL',
        input_amount: 10,
        network: 'devnet',
      }),
    ).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('rejects provider mints that do not match devnet config', async () => {
    vi.spyOn(orca, 'quoteOrcaUsdcToSol').mockResolvedValueOnce({
      ...COMMON_QUOTE,
      input_mint: 'WrongUsdcMint111111111111111111111111111111',
      estimated_output_base_units: '2000000000',
    });

    await expect(
      getUsdcSolQuote({
        input_token: 'USDC',
        output_token: 'SOL',
        input_amount: 1,
        network: 'devnet',
      }),
    ).rejects.toMatchObject({ code: 'invalid_network_config' });
  });

  it('maps quote request timeout to provider_timeout', async () => {
    vi.spyOn(orca, 'quoteOrcaUsdcToSol').mockRejectedValueOnce(new DOMException('Request timed out', 'AbortError'));

    await expect(
      getUsdcSolQuote({
        input_token: 'USDC',
        output_token: 'SOL',
        input_amount: 10,
        network: 'devnet',
      }),
    ).rejects.toMatchObject({ code: 'provider_timeout' });
  });
});
