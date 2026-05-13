import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  getHistory,
  postApprove,
  postFunctionResult,
  postReject,
  streamChat,
} from '../client';
import { getUsdcSolQuote } from '../client';

function sseResponseFromChunks(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }
  );
}

describe('streamChat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses SSE events split across network chunks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      sseResponseFromChunks([
        'event: session\n',
        'data: {"session_id":"session-1"}\n\n',
        'event: token\ndata: {"content":"Hola"}\n\n',
        'event: done\n',
        'data: {"session_id":"session-1"}\n\n',
      ])
    );

    const events: string[] = [];

    await streamChat(
      {
        type: 'user_message',
        content: 'Hola',
      },
      {
        onSession: (sessionId) => events.push(`session:${sessionId}`),
        onToken: (content) => events.push(`token:${content}`),
        onDone: (data) => events.push(`done:${data.session_id}`),
      }
    );

    expect(events).toEqual(['session:session-1', 'token:Hola', 'done:session-1']);
  });

  it('encodes usdc-sol quote query params', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          network: 'devnet',
          provider: 'orca_whirlpools_devnet',
          input_token: 'USDC',
          output_token: 'SOL',
          input_amount: 10,
          output_amount: 0.03,
          input_mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
          output_mint: 'So11111111111111111111111111111111111111112',
          slippage_bps: 100,
          quote_source: 'orca_whirlpool_quote',
          updated_at: new Date().toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await getUsdcSolQuote({
      input_token: 'USDC',
      output_token: 'SOL',
      input_amount: 10,
      slippage_bps: 100,
      network: 'devnet',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/quotes/usdc-sol?input_token=USDC&output_token=SOL&input_amount=10&slippage_bps=100&network=devnet',
      expect.anything(),
    );
  });
});

describe('chat session history endpoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and parses get_history payload', async () => {
    const now = new Date().toISOString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session_id: 'session-1',
          user_address: 'wallet-1',
          updated_at: now,
          messages: [
            {
              role: 'agent',
              type: 'text',
              content: 'Hola',
              timestamp: now,
            },
          ],
          pending_proposal: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const payload = await getHistory('session-1');

    expect(payload.session_id).toBe('session-1');
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].type).toBe('text');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends user_address when requesting history', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session_id: 'session-1',
          user_address: 'wallet-1',
          updated_at: new Date().toISOString(),
          messages: [],
          pending_proposal: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await getHistory('session-1', 'wallet-1');

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      type: 'get_history',
      session_id: 'session-1',
      user_address: 'wallet-1',
    });
  });

  it('parses function_approve response with guardrail explanation', async () => {
    const now = new Date().toISOString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [],
          proposal_state: {
            state: 'guard_rejected_awaiting_bypass',
            expires_at: now,
          },
          guard_rejection: {
            reason: 'PriceDeviationExceeded',
            deviation_bps: 850,
            max_allowed_bps: 500,
            oracle_price_usd: 150,
            quoted_price_usd: 162.75,
            can_bypass: true,
            warning_message: 'El precio del swap difiere del precio de mercado.',
            explanation: {
              id: 'swap-rejection-explanation-1',
              action_type: 'swap',
              decision: 'REJECT',
              severity: 'critical',
              category: 'price_or_execution_risk',
              summary: 'El guardrail bloqueó el swap por desviación de precio.',
              reason_codes: ['PriceDeviationExceeded', 'price_deviation_rejected'],
              reasons: [
                {
                  code: 'price_deviation_rejected',
                  message: 'El precio del swap difiere del precio de mercado.',
                  category: 'price_or_execution_risk',
                  source: 'onchain',
                  severity: 'critical',
                },
              ],
              checks: [
                {
                  check: 'swap_price_deviation',
                  label: 'Límite máximo de desviación de precio',
                  status: 'fail',
                  source: 'onchain',
                },
              ],
              sources: [{ provider: 'agent_action_guard', status: 'ok', checked_at: now }],
              suggested_user_action: 'request_review',
              created_at: now,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const payload = await postApprove('session-1');

    expect(payload.guard_rejection?.explanation?.decision).toBe('REJECT');
    expect(payload.guard_rejection?.explanation?.reason_codes).toContain('price_deviation_rejected');
  });

  it('sends user_address on function_approve', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [],
          proposal_state: {
            state: 'awaiting_signature',
            expires_at: new Date().toISOString(),
          },
          transaction: {
            format: 'base64_versioned_transaction',
            unsigned_tx_base64: 'tx',
            recent_blockhash: 'recent',
            last_valid_block_height: 1,
            network: 'devnet',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await postApprove('session-1', undefined, 'wallet-1');

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      type: 'function_approve',
      session_id: 'session-1',
      user_address: 'wallet-1',
    });
  });

  it('sends user_address on function_result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await postFunctionResult('session-1', 'sig-1', 'confirmed', undefined, 'wallet-1');

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      type: 'function_result',
      session_id: 'session-1',
      tx_signature: 'sig-1',
      status: 'confirmed',
      user_address: 'wallet-1',
    });
  });

  it('sends user_address on function_reject', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await postReject('session-1', 'cancelled', 'wallet-1');

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      type: 'function_reject',
      session_id: 'session-1',
      reason: 'cancelled',
      user_address: 'wallet-1',
    });
  });

  it('throws ApiClientError for session_not_found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 'session_not_found',
            message: 'session expired',
          },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );

    const error = await getHistory('expired').catch((e) => e);
    expect((error as ApiClientError).code).toBe('session_not_found');
  });
});
