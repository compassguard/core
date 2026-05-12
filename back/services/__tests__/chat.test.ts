import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAgentToolNames,
  evaluateSolTransferFunding,
  isReadOnlyAgentTool,
  maskSolanaAddressesForModel,
  normalizeMessages,
  parseDirectTransferIntent,
  proxyAgenticChat,
  restoreMaskedSolanaAddressesInToolArgs,
} from '../chat';
import { prepareTransferResult } from '../tools/transfer';
import { createSession, getSession } from '../chatSessionStore';
import * as azureResponsesClient from '../azureResponsesClient';

function makeCompletionStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = JSON.stringify({
    type: 'response.completed',
    response: {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: content,
            },
          ],
        },
      ],
    },
  });

  const rawChunk = `data: ${payload}\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(rawChunk));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function makeTerminalDoneStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = JSON.stringify({
    type: 'response.output_text.done',
    text: content,
  });

  const rawChunk = `data: ${payload}\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(rawChunk));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

describe('chat agent tool catalog', () => {
  it('includes backend managed read-only context tools', () => {
    const toolNames = getAgentToolNames();
    expect(toolNames).toEqual(expect.arrayContaining(['get_wallet_holdings', 'get_usdc_sol_quote']));
    expect(isReadOnlyAgentTool('get_wallet_holdings')).toBe(true);
    expect(isReadOnlyAgentTool('get_usdc_sol_quote')).toBe(true);
    expect(isReadOnlyAgentTool('transfer')).toBe(false);
  });
});

describe('chat history endpoint', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns session_not_found for unknown session', async () => {
    const response = await proxyAgenticChat({
      type: 'get_history',
      session_id: 'session-missing',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns persisted messages and pending proposal in history', async () => {
    const sessionId = 'session-history-1';
    const session = createSession(sessionId, 'thread-history-1', 'wallet-1');
    const proposalMessage = {
      id: 'pending-msg-1',
      role: 'agent' as const,
      type: 'function_call' as const,
      function: {
        name: 'transfer' as const,
        params: {
          amount: 1,
          token: 'SOL',
          recipient: '11111111111111111111111111111111',
        },
      },
      display: {
        summary: 'Prepare transfer',
      },
      risk: {
        score: 10,
        level: 'low' as const,
      },
      execution: {
        mode: 'phantom_sign_and_send' as const,
        network: 'devnet' as const,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      timestamp: new Date().toISOString(),
    };
    session.messages = [proposalMessage];
    session.pendingProposal = {
      toolName: 'transfer',
      toolArgs: {
        amount: 1,
        token: 'SOL',
        recipient: '11111111111111111111111111111111',
      },
      toolResult: {
        status: 'prepared',
        reason: 'pending',
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      expectedUserAddress: 'wallet-1',
      state: 'awaiting_approval',
      proposalType: 'transfer',
      network: 'devnet',
      proposalMessage,
    };

    const response = await proxyAgenticChat({
      type: 'get_history',
      session_id: sessionId,
      user_address: 'wallet-1',
    });

    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.session_id).toBe(sessionId);
    expect(payload.pending_proposal).not.toBeNull();
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]).toMatchObject({
      role: 'agent',
      type: 'function_call',
      function: {
        name: 'transfer',
      },
    });
  });

  it('returns session_not_found for get_history if wallet-bound session omits user_address', async () => {
    createSession('session-history-no-user', 'thread-history-no-user', 'wallet-1');

    const response = await proxyAgenticChat({
      type: 'get_history',
      session_id: 'session-history-no-user',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns session_not_found for get_history if wallet-bound session has mismatched user_address', async () => {
    createSession('session-history-mismatch', 'thread-history-mismatch', 'wallet-1');

    const response = await proxyAgenticChat({
      type: 'get_history',
      session_id: 'session-history-mismatch',
      user_address: 'wallet-2',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('session_not_found');
  });

  it('includes previous transcript when building model input for user message', async () => {
    const sessionId = 'session-history-2';
    const session = createSession(sessionId, 'thread-history-2', 'wallet-1');
    session.messages.push({
      id: 'seed-1',
      role: 'user',
      type: 'text',
      content: '¿Cómo estás?',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    });

    const completionSpy = vi.spyOn(azureResponsesClient, 'callAzureResponses').mockResolvedValueOnce({
      id: 'r1',
      object: 'response',
      status: 'completed',
      output: [],
    });
    vi.spyOn(azureResponsesClient, 'callAzureResponsesStream').mockResolvedValueOnce(
      makeCompletionStream('Te ayudo con eso'),
    );

    const response = await proxyAgenticChat({
      type: 'user_message',
      content: 'Y para hoy qué me recomiendas?',
      session_id: sessionId,
      user_address: 'wallet-1',
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(completionSpy).toHaveBeenCalledTimes(1);
    const callArgs = completionSpy.mock.calls[0]?.[0];
    expect(callArgs?.input).toContain('[Usuario]: ¿Cómo estás?');
    expect(callArgs?.input).toContain('[Usuario]: Y para hoy qué me recomiendas?');
  });

  it('persists assistant text from terminal stream done events', async () => {
    const sessionId = 'session-terminal-done';
    createSession(sessionId, 'thread-terminal-done', 'wallet-1');

    vi.spyOn(azureResponsesClient, 'callAzureResponses').mockResolvedValueOnce({
      id: 'r-terminal',
      object: 'response',
      status: 'completed',
      output: [],
    });
    vi.spyOn(azureResponsesClient, 'callAzureResponsesStream').mockResolvedValueOnce(
      makeTerminalDoneStream('Respuesta final desde done'),
    );

    const response = await proxyAgenticChat({
      type: 'user_message',
      content: 'Dame un resumen',
      session_id: sessionId,
      user_address: 'wallet-1',
    });

    expect(response.status).toBe(200);
    const sseBody = await response.text();
    expect(sseBody).toContain('Respuesta final desde done');

    const session = getSession(sessionId);
    expect(session?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'agent',
          type: 'text',
          content: 'Respuesta final desde done',
        }),
      ]),
    );

    const historyResponse = await proxyAgenticChat({
      type: 'get_history',
      session_id: sessionId,
      user_address: 'wallet-1',
    });
    const history = await historyResponse.json();
    expect(history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'agent',
          type: 'text',
          content: 'Respuesta final desde done',
        }),
      ]),
    );
  });
});

describe('ownership enforcement for sensitive actions', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
  });

  it('returns session_not_found for function_approve when wallet-bound session omits user_address', async () => {
    createSession('session-approve-no-user', 'thread-approve-no-user', 'wallet-1');

    const response = await proxyAgenticChat({
      type: 'function_approve',
      session_id: 'session-approve-no-user',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns session_not_found for function_approve when wallet-bound session mismatches', async () => {
    createSession('session-approve-mismatch', 'thread-approve-mismatch', 'wallet-1');

    const response = await proxyAgenticChat({
      type: 'function_approve',
      session_id: 'session-approve-mismatch',
      user_address: 'wallet-2',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns session_not_found for function_result when wallet-bound session omits user_address', async () => {
    createSession('session-result-no-user', 'thread-result-no-user', 'wallet-1');

    const response = await proxyAgenticChat({
      type: 'function_result',
      session_id: 'session-result-no-user',
      tx_signature: 'signature-no-user',
      status: 'confirmed',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns session_not_found for function_result when wallet-bound session mismatches', async () => {
    createSession('session-result-mismatch', 'thread-result-mismatch', 'wallet-1');

    const response = await proxyAgenticChat({
      type: 'function_result',
      session_id: 'session-result-mismatch',
      tx_signature: 'signature-mismatch',
      status: 'confirmed',
      user_address: 'wallet-2',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns session_not_found for function_reject when wallet-bound session omits user_address', async () => {
    createSession('session-reject-no-user', 'thread-reject-no-user', 'wallet-1');

    const response = await proxyAgenticChat({
      type: 'function_reject',
      session_id: 'session-reject-no-user',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns session_not_found for function_reject when wallet-bound session mismatches', async () => {
    createSession('session-reject-mismatch', 'thread-reject-mismatch', 'wallet-1');

    const response = await proxyAgenticChat({
      type: 'function_reject',
      session_id: 'session-reject-mismatch',
      user_address: 'wallet-2',
      reason: 'test',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('session_not_found');
  });
});

describe('normalizeMessages', () => {
  it('normalizes valid messages array', () => {
    const input = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = normalizeMessages(input);
    expect(result).toHaveLength(2);
    expect(result![0].role).toBe('user');
    expect(result![1].role).toBe('assistant');
  });

  it('returns null for empty array', () => {
    expect(normalizeMessages([])).toBeNull();
  });

  it('returns null for missing content', () => {
    const input = [{ role: 'user' }];
    expect(normalizeMessages(input)).toBeNull();
  });

  it('returns null for non-array input', () => {
    expect(normalizeMessages('not an array')).toBeNull();
    expect(normalizeMessages(null)).toBeNull();
    expect(normalizeMessages(undefined)).toBeNull();
  });
});

describe('Solana address masking', () => {
  it('masks valid Solana addresses before sending text to the model and restores tool args', () => {
    const recipient = 'bEsfmEAaTA98rLftyi2jZ4XAzCBbqBvrJPKNW6rYJgp';
    const masked = maskSolanaAddressesForModel(`Manda 5 SOL a ${recipient}`);

    expect(masked.content).toBe('Manda 5 SOL a SOLANA_ADDRESS_1');
    expect(masked.addressByPlaceholder.SOLANA_ADDRESS_1).toBe(recipient);

    const restored = restoreMaskedSolanaAddressesInToolArgs(
      '{"amount":5,"token":"SOL","recipient":"SOLANA_ADDRESS_1"}',
      masked.addressByPlaceholder,
    );
    expect(restored).toBe(`{"amount":5,"token":"SOL","recipient":"${recipient}"}`);
  });

  it('masks address-like Solana strings even when they are malformed', () => {
    const malformedRecipient = 'iB1mdEmZixSFXKL9AoujhFfuizC8hKYCFMBzcADEQq';
    const masked = maskSolanaAddressesForModel(`Manda 1 SOL ${malformedRecipient}`);

    expect(masked.content).toBe('Manda 1 SOL SOLANA_ADDRESS_1');
    expect(masked.addressByPlaceholder.SOLANA_ADDRESS_1).toBe(malformedRecipient);
  });
});

describe('parseDirectTransferIntent', () => {
  it('parses simple transfer requests without requiring the model', () => {
    const recipient = 'bEsfmEAaTA98rLftyi2jZ4XAzCBbqBvrJPKNW6rYJgp';
    const parsed = parseDirectTransferIntent(`Manda 1 SOL ${recipient}`);

    expect(parsed).toMatchObject({
      matched: true,
      amount: 1,
      token: 'SOL',
      recipient,
      recipientValid: true,
    });
  });

  it('detects malformed recipient addresses before calling the model', () => {
    const parsed = parseDirectTransferIntent('Manda 1 SOL iB1mdEmZixSFXKL9AoujhFfuizC8hKYCFMBzcADEQq');

    expect(parsed).toMatchObject({
      matched: true,
      amount: 1,
      token: 'SOL',
      recipientValid: false,
    });
  });

  it('normalizes common SOL typos in direct transfer requests', () => {
    const recipient = 'iB1mdEmZixSFXKL9AoujhFfuizC8hKYCFMBzcADEQq2';
    const parsed = parseDirectTransferIntent(`Manda 15 sola. ${recipient}`);

    expect(parsed).toMatchObject({
      matched: true,
      amount: 15,
      token: 'SOL',
      recipient,
      recipientValid: true,
    });
  });
});

describe('prepareTransferResult', () => {
  const validFromWallet = '11111111111111111111111111111111';
  const validToWallet = 'So11111111111111111111111111111111111111112';

  it('prepares transfer for valid params', () => {
    const result = prepareTransferResult(
      { amount: 0.25, token: 'SOL', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('prepared');
    expect(result.preparedAction?.executedOnChain).toBe(false);
    expect(result.preparedAction?.requiresUserSignature).toBe(true);
    expect(result.preparedAction?.fromWallet).toBe(validFromWallet);
    expect(result.preparedAction?.toWallet).toBe(validToWallet);
  });

  it('denies invalid source wallet', () => {
    const result = prepareTransferResult(
      { amount: 0.25, token: 'SOL', recipient: validToWallet },
      'not-a-wallet'
    );

    expect(result.status).toBe('denied');
    expect(result.reason).toBe('INVALID_FROM_WALLET');
  });

  it('denies invalid recipient', () => {
    const result = prepareTransferResult(
      { amount: 0.25, token: 'SOL', recipient: 'not-a-wallet' },
      validFromWallet
    );

    expect(result.status).toBe('denied');
    expect(result.reason).toBe('INVALID_RECIPIENT');
  });

  it('denies non-positive amount', () => {
    const result = prepareTransferResult(
      { amount: 0, token: 'SOL', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('denied');
    expect(result.reason).toBe('INVALID_AMOUNT');
  });

  it('denies negative amount', () => {
    const result = prepareTransferResult(
      { amount: -1, token: 'SOL', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('denied');
    expect(result.reason).toBe('INVALID_AMOUNT');
  });

  it('defaults token to SOL', () => {
    const result = prepareTransferResult(
      { amount: 1, token: '', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('prepared');
    expect(result.preparedAction?.token).toBe('SOL');
  });

  it('normalizes SOLA typo to SOL', () => {
    const result = prepareTransferResult(
      { amount: 1, token: 'sola', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('prepared');
    expect(result.preparedAction?.token).toBe('SOL');
  });

  it('denies unsupported tokens before creating a transfer proposal', () => {
    const result = prepareTransferResult(
      { amount: 1, token: 'USDC', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('denied');
    expect(result.reason).toBe('UNSUPPORTED_TOKEN');
  });

  it('includes memo when provided', () => {
    const result = prepareTransferResult(
      { amount: 1, token: 'SOL', recipient: validToWallet, memo: 'Test memo' },
      validFromWallet
    );

    expect(result.status).toBe('prepared');
    expect(result.preparedAction?.memo).toBe('Test memo');
  });
});

describe('evaluateSolTransferFunding', () => {
  it('denies a SOL transfer when balance cannot cover amount and guardrail overhead', () => {
    const result = evaluateSolTransferFunding({
      balanceLamports: 5_000_000_000,
      amountLamports: 5_000_000_000,
      policyRentLamports: 1_000_000,
      approvalRentLamports: 2_000_000,
      feeBufferLamports: 50_000,
      policyAccountMissing: true,
    });

    expect(result.ok).toBe(false);
    expect(result.requiredLamports).toBe(5_003_050_000);
    expect(result.missingLamports).toBe(3_050_000);
  });

  it('does not include policy rent when the wallet policy already exists', () => {
    const result = evaluateSolTransferFunding({
      balanceLamports: 5_002_050_000,
      amountLamports: 5_000_000_000,
      policyRentLamports: 1_000_000,
      approvalRentLamports: 2_000_000,
      feeBufferLamports: 50_000,
      policyAccountMissing: false,
    });

    expect(result.ok).toBe(true);
    expect(result.requiredLamports).toBe(5_002_050_000);
    expect(result.overheadLamports).toBe(2_050_000);
  });
});
