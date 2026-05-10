import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { useAgentMessage } from '../useAgentMessage';
import { useChatStore } from '../../stores/chatStore';
import { ApiClientError } from '../../lib/api/client';
import { useWallet } from '../useWallet';
import * as chatApi from '../../lib/api/client';

vi.mock('../useWallet', () => ({
  useWallet: vi.fn(),
}));

vi.mock('../../lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api/client')>('../../lib/api/client');
  return {
    ...actual,
    streamChat: vi.fn(),
    postApprove: vi.fn(),
    postReject: vi.fn(),
  };
});

const mockedStreamChat = vi.mocked(chatApi.streamChat);
const mockedPostApprove = vi.mocked(chatApi.postApprove);

function wrapperFactory() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return wrapper;
}

function reset() {
  useChatStore.getState().clearHistory();
  useChatStore.persist.clearStorage();
}

describe('useAgentMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    vi.mocked(useWallet).mockReturnValue({
      address: 'wallet-1',
      isConnected: true,
      isConnecting: false,
      isBalancesLoading: false,
      isDisconnecting: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      exportPrivateKey: undefined,
      walletError: undefined,
      balances: undefined,
      balancesError: undefined,
    } as unknown as ReturnType<typeof useWallet>);

    mockedStreamChat.mockResolvedValue(undefined);
  });

  afterEach(() => {
    reset();
  });

  it('sends user message with current wallet when streaming chat', async () => {
    const { result } = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await act(async () => {
      await result.current.sendUserMessage('Hola, revisar cartera');
    });

    expect(mockedStreamChat).toHaveBeenCalledTimes(1);
    const requestArg = mockedStreamChat.mock.calls[0]?.[0];

    expect(requestArg).toMatchObject({
      type: 'user_message',
      content: 'Hola, revisar cartera',
      user_address: 'wallet-1',
    });
  });

  it('updates pending state when streaming starts and finishes', async () => {
    let resolveStream: (() => void) | undefined;
    mockedStreamChat.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStream = resolve;
        })
    );

    const { result } = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });
    let sendPromise: Promise<void> = Promise.resolve();

    act(() => {
      sendPromise = result.current.sendUserMessage('Hola');
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    await act(async () => {
      resolveStream?.();
      await sendPromise;
    });

    expect(result.current.isPending).toBe(false);
  });

  it('does not approve pending proposal when wallet mismatches conversation wallet', async () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.setCurrentWalletAddress('wallet-2');
    state.setSessionId('session-1');

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

    const { result } = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await act(async () => {
      await result.current.approveProposal();
    });

    expect(mockedPostApprove).not.toHaveBeenCalled();
  });

  it('forces expired conversation when backend returns session_not_found', async () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.setCurrentWalletAddress('wallet-1');
    state.setSessionId('session-1');
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

    mockedPostApprove.mockRejectedValueOnce(
      new ApiClientError({ code: 'session_not_found', message: 'session expired' }, 404)
    );

    const { result } = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await act(async () => {
      await result.current.approveProposal();
    });

    expect(mockedPostApprove).toHaveBeenCalledWith('session-1');
    expect(useChatStore.getState().getActiveConversationReadOnlyReason()).toBe('session_expired');
  });

  it('starts a new conversation when user sends on expired session', async () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.setSessionId('session-stale');
    const activeConversationId = state.activeConversationId;
    const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    useChatStore.setState((prev) => ({
      conversationsById: {
        ...prev.conversationsById,
        [activeConversationId as string]: {
          ...prev.conversationsById[activeConversationId as string],
          updatedAt: staleTimestamp,
        },
      },
    }));

    const { result } = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await act(async () => {
      await result.current.sendUserMessage('Nueva instrucción con sesión nueva');
    });

    const after = useChatStore.getState();
    expect(after.activeConversationId).not.toBe(activeConversationId);
  });
});
