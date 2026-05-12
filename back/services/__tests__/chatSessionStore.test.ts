import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendSessionMessage,
  appendSessionMessages,
  createSession,
  clearPendingProposal,
  deleteSession,
  getSession,
  loadSessionFromExternalStore,
  persistSession,
  updateSession,
  type SessionHistoryMessageInput,
  type PendingProposal,
} from '../chatSessionStore';

describe('chatSessionStore', () => {
  afterEach(() => {
    // Cleanup sessions created during tests by expiring them.
    const staleTs = Date.now() - 31 * 60 * 1000;
    const sessionIds = ['sess_1', 'sess_2', 'sess_3', 'sess_4', 'sess_external'];
    for (const sessionId of sessionIds) {
      const session = getSession(sessionId);
      if (session) {
        session.updatedAt = staleTs;
        // Access through getSession again to ensure cleanup path is exercised.
        expect(getSession(sessionId)).toBeNull();
      }
    }
    delete process.env.CHAT_SESSION_REDIS_REST_URL;
    delete process.env.CHAT_SESSION_REDIS_REST_TOKEN;
    vi.restoreAllMocks();
  });

  it('appends a serialized user message with generated metadata', () => {
    const sessionId = 'sess_1';
    createSession(sessionId, 'thread-1', 'wallet-1');

    const updated = appendSessionMessage(sessionId, {
      role: 'user',
      type: 'text',
      content: 'Hola',
    });

    expect(updated).not.toBeNull();
    expect(updated!.messages).toHaveLength(1);
    expect(updated!.messages[0]).toMatchObject({
      role: 'user',
      type: 'text',
      content: 'Hola',
    });
    expect(updated!.messages[0].id).toMatch(/^sess_1-user-/);
    expect(updated!.messages[0].timestamp).toBeTypeOf('string');
  });

  it('appends multiple messages while keeping order', () => {
    const sessionId = 'sess_2';
    createSession(sessionId, 'thread-2', 'wallet-1');

    const payload: SessionHistoryMessageInput[] = [
      {
        role: 'agent',
        type: 'text',
        content: 'Bienvenido',
      },
      {
        role: 'user',
        type: 'text',
        content: 'Quiero transferir',
      },
    ];

    const updated = appendSessionMessages(sessionId, payload);

    expect(updated).not.toBeNull();
    expect(updated!.messages).toHaveLength(2);
    const firstMessage = updated!.messages[0];
    const secondMessage = updated!.messages[1];
    if (firstMessage.type !== 'text' || secondMessage.type !== 'text') {
      throw new Error('Expected text messages');
    }
    expect(firstMessage.content).toBe('Bienvenido');
    expect(secondMessage.content).toBe('Quiero transferir');
    expect(firstMessage.id).toBeTypeOf('string');
    expect(secondMessage.id).toBeTypeOf('string');
    expect(firstMessage.id).not.toBe(secondMessage.id);
  });

  it('expires session after TTL when accessed', () => {
    const sessionId = 'sess_3';
    const created = createSession(sessionId, 'thread-3');

    created.updatedAt = Date.now() - 31 * 60 * 1000;
    expect(getSession(sessionId)).toBeNull();
  });

  it('clears pending proposal without affecting messages', () => {
    const sessionId = 'sess_4';
    createSession(sessionId, 'thread-4', 'wallet-1');

    appendSessionMessage(sessionId, {
      role: 'agent',
      type: 'function_call',
      function: {
        name: 'transfer',
        params: {
          amount: 1,
          token: 'SOL',
          recipient: '11111111111111111111111111111111',
        },
      },
      display: {
        summary: 'Propuesta',
      },
      risk: {
        score: 10,
        level: 'low',
      },
      execution: {
        mode: 'phantom_sign_and_send',
        network: 'devnet',
        expires_at: new Date().toISOString(),
      },
    });

    const proposal: PendingProposal = {
      toolName: 'transfer',
      toolArgs: {
        amount: 1,
        token: 'SOL',
        recipient: '11111111111111111111111111111111',
      },
      toolResult: {
        status: 'prepared',
        reason: 'prepared',
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      expectedUserAddress: 'wallet-1',
      state: 'awaiting_approval',
      proposalType: 'transfer',
      network: 'devnet',
    };

    updateSession(sessionId, { pendingProposal: proposal });
    const withProposal = getSession(sessionId);
    expect(withProposal?.pendingProposal).toMatchObject({ toolName: 'transfer' });
    expect(withProposal?.messages.length).toBe(1);

    const wasCleared = clearPendingProposal(sessionId);
    const cleared = getSession(sessionId);

    expect(wasCleared).toBe(true);
    expect(cleared?.pendingProposal).toBeNull();
    expect(cleared?.messages).toHaveLength(1);
  });

  it('persists and reloads sessions through the external Redis REST store', async () => {
    process.env.CHAT_SESSION_REDIS_REST_URL = 'https://redis.example';
    process.env.CHAT_SESSION_REDIS_REST_TOKEN = 'redis-token';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ result: 'OK' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const sessionId = 'sess_external';
    createSession(sessionId, 'thread-external', 'wallet-1');
    appendSessionMessage(sessionId, {
      role: 'user',
      type: 'text',
      content: 'Hola externo',
    });

    await persistSession(sessionId);

    const lastSetCall = fetchSpy.mock.calls.at(-1);
    expect(lastSetCall?.[0]).toBe('https://redis.example');
    expect(lastSetCall?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer redis-token',
        'content-type': 'application/json',
      },
    });
    const setCommand = JSON.parse(String((lastSetCall?.[1] as RequestInit).body));
    expect(setCommand[0]).toBe('SET');
    expect(setCommand[1]).toBe('compass:chat:session:sess_external');
    expect(setCommand[3]).toBe('PX');

    const persistedSnapshot = JSON.stringify(getSession(sessionId));
    deleteSession(sessionId);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: persistedSnapshot }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const loaded = await loadSessionFromExternalStore(sessionId);

    expect(loaded?.sessionId).toBe(sessionId);
    expect(loaded?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          type: 'text',
          content: 'Hola externo',
        }),
      ]),
    );
  });
});
