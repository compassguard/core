import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

function makeJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const USUAL_ADDRESS = '11111111111111111111111111111111';

describe('GET /api/wallet/balances', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SOLANA_RPC_URL;
  });

  it('returns SOL and SPL balances from real wallet data', async () => {
    const solBalanceCall = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          jsonrpc: '2.0',
          result: { context: { slot: 123 }, value: 7_900_000_000 },
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          jsonrpc: '2.0',
          result: {
            context: { slot: 124 },
            value: [
              {
                pubkey: 'HfW8L...WSOL',
                account: {
                  data: {
                    parsed: {
                      type: 'account',
                      info: {
                        mint: 'So11111111111111111111111111111111111111112',
                        tokenAmount: {
                          uiAmount: 0.5,
                          amount: '500000000',
                          decimals: 9,
                        },
                      },
                    },
                  },
                },
              },
              {
                pubkey: 'HfW8L...USDC',
                account: {
                  data: {
                    parsed: {
                      type: 'account',
                      info: {
                        mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
                        tokenAmount: {
                          uiAmount: 12.34,
                          amount: '12340000',
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

    const response = await GET(new Request(`http://localhost/api/wallet/balances?address=${USUAL_ADDRESS}`));
    const payload = (await response.json()) as {
      network: string;
      balances: Array<Record<string, unknown>>;
      total_usd: number;
      updated_at: string;
    };

    expect(response.status).toBe(200);
    expect(solBalanceCall).toHaveBeenCalledTimes(2);
    expect(payload.network).toBe('devnet');
    expect(payload.total_usd).toBe(0);
    expect(payload.balances).toHaveLength(3);
    expect(payload.balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: 'SOL',
          mint: 'So11111111111111111111111111111111111111112',
          amount: '7900000000',
          decimals: 9,
          ui_amount: 7.9,
          usd_value: 0,
        }),
        expect.objectContaining({
          symbol: 'WSOL',
          mint: 'So11111111111111111111111111111111111111112',
          amount: '500000000',
          decimals: 9,
          ui_amount: 0.5,
          usd_value: 0,
        }),
        expect.objectContaining({
          symbol: 'USDC',
          mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
          amount: '12340000',
          decimals: 6,
          ui_amount: 12.34,
          usd_value: 0,
        }),
      ]),
    );
  });

  it('uses configured SOLANA_RPC_URL when available', async () => {
    process.env.SOLANA_RPC_URL = 'https://custom.devnet.rpc.example';

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          jsonrpc: '2.0',
          result: { context: { slot: 1 }, value: 1000 },
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          jsonrpc: '2.0',
          result: { context: { slot: 1 }, value: [] },
        }),
      );

    await GET(new Request(`http://localhost/api/wallet/balances?address=${USUAL_ADDRESS}`));

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      'https://custom.devnet.rpc.example',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://custom.devnet.rpc.example',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns error when network is not supported', async () => {
    const response = await GET(
      new Request(`http://localhost/api/wallet/balances?address=${USUAL_ADDRESS}&network=mainnet-beta`),
    );
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('unsupported_network');
  });

  it('returns error when address param is missing', async () => {
    const response = await GET(new Request('http://localhost/api/wallet/balances'));
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      error: {
        code: 'invalid_payload',
        message: 'Missing address query param.',
      },
    });
  });

  it('returns error when address is invalid', async () => {
    const response = await GET(new Request('http://localhost/api/wallet/balances?address=not-a-wallet'));
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('invalid_payload');
    expect(payload.error.message).toBe('Invalid wallet address');
  });

  it('returns provider timeout as service error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('Timed out', 'AbortError'));

    const response = await GET(new Request(`http://localhost/api/wallet/balances?address=${USUAL_ADDRESS}`));
    const payload = (await response.json()) as { error: { code: string; details: { reason: string } } };

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe('wallet_balance_fetch_failed');
    expect(payload.error.details.reason).toBe('Provider request timed out');
  });

  it('returns partial native SOL holdings when SPL lookup fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          jsonrpc: '2.0',
          result: { context: { slot: 1 }, value: 2_500_000_000 },
        }),
      )
      .mockRejectedValueOnce(new Error('spl rpc down'));

    const response = await GET(new Request(`http://localhost/api/wallet/balances?address=${USUAL_ADDRESS}`));
    const payload = (await response.json()) as {
      partial?: boolean;
      warnings?: Array<{ code: string; message: string }>;
      balances: Array<{ symbol: string; ui_amount: number }>;
    };

    expect(response.status).toBe(200);
    expect(payload.partial).toBe(true);
    expect(payload.warnings?.[0]).toMatchObject({
      code: 'spl_holdings_unavailable',
      message: 'spl rpc down',
    });
    expect(payload.balances).toEqual([
      expect.objectContaining({
        symbol: 'SOL',
        ui_amount: 2.5,
      }),
    ]);
  });
});
