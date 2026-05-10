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
  });

  it('returns a SOL balance from RPC getBalance response', async () => {
    const rpcSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        jsonrpc: '2.0',
        result: { context: { slot: 123 }, value: 7900000000 },
      }),
    );

    const response = await GET(new Request(`http://localhost/api/wallet/balances?address=${USUAL_ADDRESS}`));
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith(
      'https://api.devnet.solana.com',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(payload).toMatchObject({
      balances: [
        expect.objectContaining({
          symbol: 'SOL',
          mint: 'So11111111111111111111111111111111111111112',
          amount: '7900000000',
          decimals: 9,
          ui_amount: 7.9,
          usd_value: 0,
        }),
      ],
      total_usd: 0,
    });
  });

  it('uses configured SOLANA_RPC_URL when available', async () => {
    process.env.SOLANA_RPC_URL = 'https://custom.devnet.rpc.example';

    const rpcSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        jsonrpc: '2.0',
        result: { context: { slot: 1 }, value: 1000 },
      }),
    );

    await GET(new Request(`http://localhost/api/wallet/balances?address=${USUAL_ADDRESS}`));

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith(
      'https://custom.devnet.rpc.example',
      expect.anything(),
    );
    delete process.env.SOLANA_RPC_URL;
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
});
