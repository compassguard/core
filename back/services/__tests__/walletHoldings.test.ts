import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWalletHoldings } from '../walletHoldings';

function makeJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const ADDRESS = '11111111111111111111111111111111';

describe('fetchWalletHoldings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches native and parsed token balances on devnet', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          jsonrpc: '2.0',
          result: { context: { slot: 1 }, value: 2_000_000_000 },
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          jsonrpc: '2.0',
          result: {
            context: { slot: 2 },
            value: [
              {
                account: {
                  data: {
                    parsed: {
                      info: {
                        mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
                        tokenAmount: {
                          uiAmount: 4.25,
                          amount: '4250000',
                          decimals: 6,
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        }),
      );

    const result = await fetchWalletHoldings({ address: ADDRESS });

    expect(result.network).toBe('devnet');
    expect(result.updated_at).toMatch(/T/);
    expect(result.balances).toHaveLength(2);
    expect(result.balances[0]).toMatchObject({
      symbol: 'SOL',
      mint: 'So11111111111111111111111111111111111111112',
      amount: '2000000000',
      decimals: 9,
      ui_amount: 2,
    });
    expect(result.balances[1]).toMatchObject({
      symbol: 'USDC',
      mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
      amount: '4250000',
      decimals: 6,
      ui_amount: 4.25,
    });
  });

  it('rejects unsupported network', async () => {
    await expect(fetchWalletHoldings({ address: ADDRESS, network: 'mainnet-beta' as never })).rejects.toMatchObject({
      code: 'unsupported_network',
    });
  });

  it('rejects invalid wallet addresses', async () => {
    await expect(fetchWalletHoldings({ address: 'not-an-address' })).rejects.toMatchObject({
      code: 'invalid_address',
    });
  });

  it('maps aborted provider fetch to provider_timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('Request timed out', 'AbortError'));

    await expect(fetchWalletHoldings({ address: ADDRESS })).rejects.toMatchObject({
      code: 'provider_timeout',
    });
  });

  it('returns native SOL as partial holdings when SPL lookup fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          jsonrpc: '2.0',
          result: { context: { slot: 1 }, value: 3_000_000_000 },
        }),
      )
      .mockRejectedValueOnce(new Error('spl rpc down'));

    const result = await fetchWalletHoldings({ address: ADDRESS });

    expect(result.partial).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'spl_holdings_unavailable',
        message: 'spl rpc down',
      }),
    ]);
    expect(result.balances).toEqual([
      expect.objectContaining({
        symbol: 'SOL',
        ui_amount: 3,
      }),
    ]);
  });
});
