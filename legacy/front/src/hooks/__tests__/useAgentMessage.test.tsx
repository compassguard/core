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
    postFunctionResult: vi.fn(),
    getHistory: vi.fn(),
  };
});

const mockedStreamChat = vi.mocked(chatApi.streamChat);
const mockedPostApprove = vi.mocked(chatApi.postApprove);
const mockedPostReject = vi.mocked(chatApi.postReject);
const mockedPostFunctionResult = vi.mocked(chatApi.postFunctionResult);
const mockedGetHistory = vi.mocked(chatApi.getHistory);

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
      isResolved: true,
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
    mockedGetHistory.mockResolvedValue({
      session_id: 'session-1',
      user_address: 'wallet-1',
      updated_at: new Date().toISOString(),
      messages: [],
      pending_proposal: null,
    });
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

  it('rehydrates active session from backend when sessionId is present', async () => {
    useChatStore.getState().setSessionId('session-hydrate');
    mockedGetHistory.mockResolvedValueOnce({
      session_id: 'session-hydrate',
      user_address: 'wallet-1',
      updated_at: new Date().toISOString(),
      messages: [
        {
          id: 'agent-1',
          role: 'agent',
          type: 'text',
          content: 'Hola, te ayudo.',
          timestamp: new Date().toISOString(),
        },
      ],
      pending_proposal: {
        id: 'pending-1',
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
          summary: 'Transfer 1 SOL',
        },
        risk: {
          score: 10,
          level: 'low',
        },
        timestamp: new Date().toISOString(),
      },
    });

    const { result } = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await waitFor(() => {
      expect(useChatStore.getState().sessionId).toBe('session-hydrate');
      expect(result.current.error).toBeNull();
      expect(
        useChatStore
          .getState()
          .messages.some((message) => message.type === 'text' && message.content === 'Hola, te ayudo.'),
      ).toBe(true);
      expect(useChatStore.getState().pendingProposal?.id).toBe('pending-1');
      expect(mockedGetHistory).toHaveBeenCalledWith('session-hydrate', 'wallet-1');
    });
  });

  it('does not hydrate before wallet resolution finishes', async () => {
    useChatStore.getState().setCurrentWalletAddress('wallet-1');
    useChatStore.getState().setSessionId('session-hydrate');
    vi.mocked(useWallet).mockReturnValue({
      address: 'wallet-1',
      isConnected: true,
      isConnecting: false,
      isResolved: false,
      isBalancesLoading: false,
      isDisconnecting: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      exportPrivateKey: undefined,
      walletError: undefined,
      balances: undefined,
      balancesError: undefined,
    } as unknown as ReturnType<typeof useWallet>);

    renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await waitFor(() => {
      expect(mockedGetHistory).not.toHaveBeenCalled();
    });
  });

  it('clears local session when history API returns session_not_found', async () => {
    useChatStore.getState().setSessionId('session-removed');
    mockedGetHistory.mockRejectedValueOnce(new ApiClientError({ code: 'session_not_found', message: 'expired' }, 404));

    renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await waitFor(() => {
      expect(useChatStore.getState().sessionId).toBeNull();
      expect(useChatStore.getState().messages).toHaveLength(1);
    });
  });

  it('does not clear the active wallet when a stale hydration returns session_not_found', async () => {
    let rejectStaleHydration: ((error: Error) => void) | undefined;
    mockedGetHistory
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectStaleHydration = reject;
          }),
      )
      .mockImplementationOnce(() => new Promise(() => undefined));

    const state = useChatStore.getState();
    state.setCurrentWalletAddress('wallet-1');
    state.setSessionId('session-race-a');

    const hook = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await waitFor(() => {
      expect(mockedGetHistory).toHaveBeenCalledWith('session-race-a', 'wallet-1');
    });

    vi.mocked(useWallet).mockReturnValue({
      address: 'wallet-2',
      isConnected: true,
      isConnecting: false,
      isResolved: true,
      isBalancesLoading: false,
      isDisconnecting: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      exportPrivateKey: undefined,
      walletError: undefined,
      balances: undefined,
      balancesError: undefined,
    } as unknown as ReturnType<typeof useWallet>);

    await act(async () => {
      useChatStore.getState().setCurrentWalletAddress('wallet-2');
      useChatStore.getState().setSessionId('session-race-b');
      hook.rerender();
    });

    await act(async () => {
      rejectStaleHydration?.(new ApiClientError({ code: 'session_not_found', message: 'expired' }, 404));
    });

    expect(useChatStore.getState().activeWalletAddress).toBe('wallet-2');
    expect(useChatStore.getState().sessionId).toBe('session-race-b');
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

    expect(mockedPostApprove).toHaveBeenCalledWith('session-1', undefined, 'wallet-1');
    expect(useChatStore.getState().getActiveConversationReadOnlyReason()).toBe('session_expired');
  });

  it('passes current wallet to sensitive actions', async () => {
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

    mockedPostApprove.mockResolvedValueOnce({
      messages: [],
    });

    const { result } = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await act(async () => {
      await result.current.approveProposal();
    });

    expect(mockedPostApprove).toHaveBeenCalledWith('session-1', undefined, 'wallet-1');
  });

  it('passes current wallet to function_result callback after approval', async () => {
    const state = useChatStore.getState();
    const signAndSend = vi.fn().mockResolvedValue({ tx_signature: 'tx-signature-1' });
    vi.mocked(useWallet).mockReturnValue({
      address: 'wallet-1',
      isConnected: true,
      isConnecting: false,
      isResolved: true,
      isBalancesLoading: false,
      isDisconnecting: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      signAndSendPreparedTransaction: signAndSend,
      exportPrivateKey: undefined,
      walletError: undefined,
      balances: undefined,
      balancesError: undefined,
    } as unknown as ReturnType<typeof useWallet>);

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
      execution: {
        mode: 'phantom_sign_and_send',
        network: 'devnet',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    mockedPostApprove.mockResolvedValueOnce({
      messages: [
        {
          type: 'text',
          content: 'Listo para aprobar.',
          timestamp: new Date().toISOString(),
        },
      ],
      transaction: {
        format: 'base64_versioned_transaction',
        unsigned_tx_base64: 'AQAB',
        recent_blockhash: 'blockhash',
        last_valid_block_height: 100,
        network: 'devnet',
      },
    });
    mockedPostFunctionResult.mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await act(async () => {
      await result.current.approveProposal();
    });

    expect(signAndSend).toHaveBeenCalledOnce();
    expect(mockedPostFunctionResult).toHaveBeenCalledWith(
      'session-1',
      'tx-signature-1',
      'submitted',
      undefined,
      'wallet-1',
    );
    expect(mockedPostFunctionResult).toHaveBeenCalledWith(
      'session-1',
      'tx-signature-1',
      'confirmed',
      undefined,
      'wallet-1',
    );
  });

  it('passes current wallet to postReject', async () => {
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
    mockedPostReject.mockResolvedValueOnce({ messages: [] });

    const { result } = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    await act(async () => {
      await result.current.rejectProposal();
    });

    expect(mockedPostReject).toHaveBeenCalledWith('session-1', undefined, 'wallet-1');
    expect(useChatStore.getState().proposalUiState).toBe('cancelled');
  });

  it('clears chat state on wallet disconnect and keeps wallet-scoped state clean', async () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.setCurrentWalletAddress('wallet-1');
    state.setSessionId('session-1');
    state.addUserMessage('Mensaje inicial');

    const hook = renderHook(() => useAgentMessage(), { wrapper: wrapperFactory() });

    vi.mocked(useWallet).mockReturnValue({
      address: undefined,
      isConnected: false,
      isConnecting: false,
      isResolved: true,
      isBalancesLoading: false,
      isDisconnecting: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      exportPrivateKey: undefined,
      walletError: undefined,
      balances: undefined,
      balancesError: undefined,
    } as unknown as ReturnType<typeof useWallet>);

    hook.rerender();

    await waitFor(() => {
      expect(useChatStore.getState().sessionId).toBeNull();
      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().activeWalletAddress).toBeNull();
    });
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
