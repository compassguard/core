import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useChatStore } from '../chatStore';

const STORAGE_KEY = 'wallet-copilot-chat-history';
const inMemoryStorage: Record<string, unknown> = {};
const inMemoryStorageAdapter = {
  getItem: (key: string) => (key in inMemoryStorage ? inMemoryStorage[key] : null),
  setItem: (key: string, value: unknown) => {
    inMemoryStorage[key] = value;
  },
  removeItem: (key: string) => {
    delete inMemoryStorage[key];
  },
  clear: () => {
    Object.keys(inMemoryStorage).forEach((key) => {
      delete inMemoryStorage[key];
    });
  },
};

function reset() {
  inMemoryStorageAdapter.clear();
  useChatStore.persist.setOptions({
    storage: inMemoryStorageAdapter as never,
  });
  useChatStore.getState().clearHistory();
  useChatStore.persist.clearStorage();
}

describe('chatStore conversation persistence', () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    reset();
  });

  it('migrates a legacy single-session payload into the conversation model', async () => {
    const oldTimestamp = new Date('2026-01-01T00:00:00.000Z').toISOString();

    const legacyState = {
      version: 1,
      state: {
        sessionId: 'legacy-session',
        messages: [
          {
            id: 'msg-user-1',
            role: 'user',
            type: 'text',
            content: 'Swap SOL to USDC',
            timestamp: oldTimestamp,
          },
        ],
        pendingProposal: null,
        proposalUiState: null,
        status: 'idle',
        streamingContent: '',
        activeWalletAddress: 'wallet-1',
      },
    };

    inMemoryStorage[STORAGE_KEY] = legacyState;
    await useChatStore.persist.rehydrate();

    const activeConversation = useChatStore.getState().getActiveConversation();

    expect(activeConversation).not.toBeNull();
    expect(activeConversation?.sessionId).toBe('legacy-session');
    expect(activeConversation?.messages).toHaveLength(1);
    expect(activeConversation?.title).toBe('Swap SOL to USDC');
  });

  it('keeps at most 20 conversations in memory/history', () => {
    const state = useChatStore.getState();
    state.setCurrentWalletAddress('wallet-1');
    for (let index = 0; index < 25; index++) {
      state.startNewConversation('wallet-1');
    }

    const list = state.getConversationList();
    expect(list).toHaveLength(20);
  });

  it('filters conversation history by active wallet', () => {
    const state = useChatStore.getState();
    state.setCurrentWalletAddress('wallet-1');
    state.addUserMessage('Wallet 1 question');

    state.setCurrentWalletAddress('wallet-2');
    state.addUserMessage('Wallet 2 question');

    expect(state.getConversationList()).not.toHaveLength(0);
    expect(state.getConversationList().every((conversation) => conversation.lastWalletAddress === 'wallet-2')).toBe(true);

    state.setCurrentWalletAddress('wallet-1');
    expect(state.getConversationList()).not.toHaveLength(0);
    expect(state.getConversationList().every((conversation) => conversation.lastWalletAddress === 'wallet-1')).toBe(true);
  });

  it('selectConversation loads the selected conversation messages in active panel state', () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    const firstConversationId = useChatStore.getState().activeConversationId;
    expect(firstConversationId).toBeTruthy();

    state.addUserMessage('Primera pregunta');

    state.startNewConversation('wallet-1');
    const secondConversationId = useChatStore.getState().activeConversationId;
    expect(secondConversationId).toBeTruthy();

    state.addUserMessage('Segunda pregunta');
    expect(useChatStore.getState().activeConversationId).toBe(secondConversationId);

    state.selectConversation(firstConversationId as string);

    expect(useChatStore.getState().activeConversationId).toBe(firstConversationId);
    const activeConversation = useChatStore.getState().getActiveConversation();
    expect(activeConversation?.messages.map((message) => ('content' in message ? message.content : ''))).toContain('Primera pregunta');
  });

  it('marks stale session as read-only', () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.setSessionId('session-1');
    const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    useChatStore.setState((prev) => {
      const activeId = prev.activeConversationId;
      if (!activeId) return {};
      return {
        conversationsById: {
          ...prev.conversationsById,
          [activeId]: {
            ...prev.conversationsById[activeId],
            updatedAt: staleTimestamp,
          },
        },
      };
    });

    expect(state.getActiveConversationReadOnlyReason()).toBe('session_expired');
  });

  it('blocks approvals when wallet mismatches conversation wallet', () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.setPendingProposal({
      id: 'pending-1',
      role: 'agent',
      type: 'function_call',
      function: {
        name: 'transfer',
        params: { amount: 1, token: 'SOL', recipient: '11111111111111111111111111111111' },
      },
      display: { summary: 'Transfer 1 SOL', fee_usd: 0 },
      risk: { score: 10, level: 'low' },
      timestamp: new Date().toISOString(),
      uiState: 'pending',
    });

    state.setCurrentWalletAddress('wallet-1');
    useChatStore.setState((prev) => {
      const activeConversationId = prev.activeConversationId;
      if (!activeConversationId) {
        return {};
      }
      return {
        activeWalletAddress: 'wallet-2',
        conversationsById: {
          ...prev.conversationsById,
          [activeConversationId]: {
            ...prev.conversationsById[activeConversationId],
            lastWalletAddress: 'wallet-1',
          },
        },
      };
    });

    expect(state.getActiveConversationReadOnlyReason()).toBe('wallet_mismatch');
    expect(state.canApproveProposal()).toBe(false);
  });

  it('treats rehydrated pending proposals as non-actionable history', () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.setCurrentWalletAddress('wallet-1');
    const originalConversationId = useChatStore.getState().activeConversationId;

    state.addAgentMessages([
      {
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
          summary: 'Send 1 SOL',
        },
        risk: {
          score: 10,
          level: 'low',
        },
        timestamp: new Date().toISOString(),
      },
    ]);

    expect(useChatStore.getState().canApproveProposal()).toBe(true);

    useChatStore.setState({
      pendingProposal: null,
      proposalUiState: 'pending',
      status: 'idle',
    });

    expect(useChatStore.getState().getActiveConversationReadOnlyReason()).toBe('proposal_stale');
    expect(useChatStore.getState().canApproveProposal()).toBe(false);

    useChatStore.getState().ensureConversationForInput('wallet-1');

    expect(useChatStore.getState().activeConversationId).not.toBe(originalConversationId);
    expect(useChatStore.getState().getActiveConversationReadOnlyReason()).toBeNull();
  });

  it('persists session bootstrap scoped by wallet', async () => {
    const state = useChatStore.getState();
    state.setCurrentWalletAddress('wallet-1');
    state.setSessionId('session-minimal');
    state.addUserMessage('Mensaje local');

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 0);
    });

    const rawStored = inMemoryStorage[STORAGE_KEY];
    const stored = typeof rawStored === 'string' ? JSON.parse(rawStored) : rawStored;

    expect(stored?.state?.sessionsByWallet).toMatchObject({
      'wallet-1': {
        sessionId: 'session-minimal',
      },
    });
    expect(stored?.state?.activeWalletAddress).toBe('wallet-1');
    expect(stored?.state?.messages).toBeUndefined();
    expect(stored?.state?.conversationsById).toBeUndefined();
    expect(stored?.state?.pendingProposal).toBeUndefined();
  });

  it('loads wallet-specific bootstrap for each wallet and restores per-wallet session id', async () => {
    const state = useChatStore.getState();
    state.setCurrentWalletAddress('wallet-a');
    state.setSessionId('session-a');
    state.setCurrentWalletAddress('wallet-b');
    state.setSessionId('session-b');

    const conversationForB = useChatStore.getState().sessionId;
    expect(conversationForB).toBe('session-b');
    state.setCurrentWalletAddress('wallet-a');
    expect(useChatStore.getState().sessionId).toBe('session-a');
  });

  it('clears wallet bootstrap when session data is cleared', () => {
    const state = useChatStore.getState();
    state.setCurrentWalletAddress('wallet-1');
    state.setSessionId('session-1');
    state.addUserMessage('Mensaje inicial');

    state.clearSessionData();

    expect(useChatStore.getState().sessionId).toBeNull();
    expect((useChatStore.getState().sessionsByWallet as Record<string, { sessionId: string }>)['wallet-1']).toBeUndefined();
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().getActiveConversation()?.messages[0]).toMatchObject({
      type: 'text',
    });
  });
});
