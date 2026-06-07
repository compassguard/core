import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

function makeJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const VALID_ADDRESS = '11111111111111111111111111111111';

describe('GET /api/wallet/transactions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns recent public transactions and a next cursor', async () => {
    const rpcSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          jsonrpc: '2.0',
          id: 1000,
          result: [
            { signature: '3N1aR5kX', err: null, blockTime: 1_700_000_000 },
            { signature: '7m2B4x9', err: { InstructionError: [0, 'Custom'] }, blockTime: 1_699_999_900 },
            { signature: '2QzA0Yy', err: null, blockTime: 1_699_999_800 },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse([
          {
            id: 1001,
            result: {
              meta: {
                preBalances: [2_000_000_000, 1],
                postBalances: [1_750_000_000, 1],
              },
              transaction: {
                message: {
                  accountKeys: [{ pubkey: VALID_ADDRESS }, { pubkey: 'Sysvar1111111111111111111111111111111111111' }],
                },
              },
            },
          },
          {
            id: 1002,
            result: {
              meta: {
                preBalances: [1_000_000_000],
                postBalances: [1_250_000_000],
              },
              transaction: {
                message: {
                  accountKeys: [VALID_ADDRESS],
                },
              },
            },
          },
        ]),
      );

    const response = await GET(new Request(`http://localhost/api/wallet/transactions?address=${VALID_ADDRESS}&limit=2`));
    const payload = (await response.json()) as { transactions: Array<Record<string, unknown>>; next_cursor?: string };

    expect(response.status).toBe(200);
    expect(rpcSpy).toHaveBeenCalledTimes(2);
    const requestBody = JSON.parse((rpcSpy.mock.calls[0]?.[1]?.body ?? '{}') as string);
    expect(requestBody.params[1].limit).toBe(3);
    const detailsRequestBody = JSON.parse((rpcSpy.mock.calls[1]?.[1]?.body ?? '[]') as string);
    expect(detailsRequestBody).toHaveLength(2);
    expect(detailsRequestBody[0].method).toBe('getTransaction');

    expect(payload.transactions).toHaveLength(2);
    expect(payload.next_cursor).toBe('7m2B4x9');
    expect(payload.transactions[0]).toMatchObject({
      tx_hash: '3N1aR5kX',
      type: 'other',
      status: 'success',
      summary: 'Public Solana transaction',
      explorer_url: 'https://explorer.solana.com/tx/3N1aR5kX',
      timestamp: new Date(1_700_000_000 * 1000).toISOString(),
      amount: -0.25,
      amount_symbol: 'SOL',
    });
    expect(payload.transactions[1].status).toBe('failed');
    expect(payload.transactions[1]).toMatchObject({ amount: 0.25, amount_symbol: 'SOL' });
    expect(payload.transactions[0]).not.toHaveProperty('counterparty');
    expect(payload.transactions[0]).not.toHaveProperty('shielded_amount');
    expect(payload.transactions[0]).not.toHaveProperty('umbra');
    expect(payload.transactions[0]).not.toHaveProperty('decrypted_payload');
    expect(payload.transactions[0]).not.toHaveProperty('viewing_grant');
  });

  it('returns 400 for missing address', async () => {
    const response = await GET(new Request('http://localhost/api/wallet/transactions'));
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({ error: { code: 'invalid_payload', message: 'Missing address query param.' } });
  });

  it('returns 400 for malformed address', async () => {
    const response = await GET(
      new Request(`http://localhost/api/wallet/transactions?address=not-a-wallet&limit=20`),
    );
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('invalid_payload');
  });

  it('returns 400 for invalid limit and clamps excessive values', async () => {
    const invalidResponse = await GET(
      new Request(`http://localhost/api/wallet/transactions?address=${VALID_ADDRESS}&limit=12.5`),
    );
    const invalidPayload = (await invalidResponse.json()) as { error: { code: string } };
    expect(invalidResponse.status).toBe(400);
    expect(invalidPayload.error.code).toBe('invalid_payload');

    const rpcSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeJsonResponse({ result: [] }));
    const clampedResponse = await GET(new Request(`http://localhost/api/wallet/transactions?address=${VALID_ADDRESS}&limit=500`));
    const clampedPayload = (await clampedResponse.json()) as {
      transactions: Array<Record<string, unknown>>;
      next_cursor?: string;
    };

    expect(clampedResponse.status).toBe(200);
    expect(clampedPayload.transactions).toEqual([]);
    const requestBody = JSON.parse((rpcSpy.mock.calls[0]?.[1]?.body ?? '{}') as string);
    expect(requestBody.params[1].limit).toBe(50);
  });

  it('returns 400 for malformed before cursor', async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/wallet/transactions?address=${VALID_ADDRESS}&limit=10&before=***not-base58***`,
      ),
    );
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({ error: { code: 'invalid_payload' } });
  });

  it('returns redacted provider_error on provider failure without leaking internals', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html>server error</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
    );

    const response = await GET(new Request(`http://localhost/api/wallet/transactions?address=${VALID_ADDRESS}`));
    const payload = (await response.json()) as {
      error: { code: string; message: string; details?: { reason?: string } };
    };

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe('provider_error');
    expect(payload.error.message).toBe('Unable to fetch public transaction history from the Solana provider.');
    expect(payload.error.details?.reason).toBe('provider_request_failed');
    expect(JSON.stringify(payload)).not.toContain('api-key');
    expect(JSON.stringify(payload)).not.toContain('server error');
  });
});
