import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import * as quoteService from '../../../../back/services/priceQuote';

describe('GET /api/quotes/usdc-sol', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns normalized quote payload', async () => {
    vi.spyOn(quoteService, 'getUsdcSolQuote').mockResolvedValueOnce({
      network: 'devnet',
      provider: 'orca_whirlpools_devnet',
      input_token: 'USDC',
      output_token: 'SOL',
      input_amount: 12,
      output_amount: 0.0321,
      input_mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
      output_mint: 'So11111111111111111111111111111111111111112',
      slippage_bps: 100,
      quote_source: 'orca_whirlpool_quote',
      updated_at: new Date().toISOString(),
    });

    const response = await GET(
      new Request('http://localhost/api/quotes/usdc-sol?input_token=USDC&output_token=SOL&input_amount=12'),
    );
    const payload = (await response.json()) as { network: string; input_amount: number };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(payload.network).toBe('devnet');
    expect(payload.input_amount).toBe(12);
  });

  it('rejects invalid pair', async () => {
    vi.spyOn(quoteService, 'getUsdcSolQuote').mockRejectedValueOnce({
      code: 'invalid_pair',
      message: 'Only USDC/SOL cross-pairs are supported',
    });

    const response = await GET(
      new Request('http://localhost/api/quotes/usdc-sol?input_token=USDC&output_token=USDC&input_amount=12'),
    );
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('invalid_payload');
  });

  it('rejects non-devnet network', async () => {
    const response = await GET(
      new Request('http://localhost/api/quotes/usdc-sol?input_token=USDC&output_token=SOL&input_amount=12&network=mainnet-beta'),
    );
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('unsupported_network');
  });

  it('returns provider error with stable code on quote service failure', async () => {
    vi.spyOn(quoteService, 'getUsdcSolQuote').mockRejectedValueOnce(new Error('provider down'));
    const response = await GET(
      new Request('http://localhost/api/quotes/usdc-sol?input_token=USDC&output_token=SOL&input_amount=12'),
    );
    const payload = (await response.json()) as {
      error: {
        code: string;
        message: string;
        details: { reason: string };
      };
    };

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe('quote_provider_failed');
    expect(payload.error.message).toBe('Unable to fetch USDC/SOL quote from provider.');
  });

  it('returns provider error on quote timeout', async () => {
    vi.spyOn(quoteService, 'getUsdcSolQuote').mockRejectedValueOnce(new DOMException('Request timed out', 'AbortError'));

    const response = await GET(
      new Request('http://localhost/api/quotes/usdc-sol?input_token=USDC&output_token=SOL&input_amount=12'),
    );
    const payload = (await response.json()) as {
      error: { code: string; message: string; details: { reason: string } };
    };

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe('quote_provider_failed');
    expect(payload.error.details.reason).toBe('Request timed out');
  });

  it('returns stable config error for invalid devnet quote configuration', async () => {
    const error = new Error('Quote provider mints do not match configured devnet mints') as Error & { code: string };
    error.code = 'invalid_network_config';
    vi.spyOn(quoteService, 'getUsdcSolQuote').mockRejectedValueOnce(error);

    const response = await GET(
      new Request('http://localhost/api/quotes/usdc-sol?input_token=USDC&output_token=SOL&input_amount=12'),
    );
    const payload = (await response.json()) as { error: { code: string; details: { reason: string } } };

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(payload.error.code).toBe('invalid_network_config');
    expect(payload.error.details.reason).toBe('Quote provider mints do not match configured devnet mints');
  });
});
