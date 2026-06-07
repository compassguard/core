import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatHistoryList } from '../ChatHistoryList';
import { useWallet } from '../../../hooks/useWallet';
import { useChatStore } from '../../../stores/chatStore';

vi.mock('../../../hooks/useWallet', () => ({
  useWallet: vi.fn(),
}));

function reset() {
  useChatStore.getState().clearHistory();
  useChatStore.persist.clearStorage();
}

beforeEach(() => {
  vi.mocked(useWallet).mockReturnValue({
    address: 'wallet-1',
    isConnected: true,
    isConnecting: false,
    isDisconnecting: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    exportPrivateKey: undefined,
    walletError: undefined,
    balances: undefined,
    balancesError: undefined,
    isBalancesLoading: false,
  } as unknown as ReturnType<typeof useWallet>);
  reset();
});

afterEach(() => {
  cleanup();
  reset();
});

describe('ChatHistoryList', () => {
  it('shows persisted conversations and changes active conversation on select', () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    const firstConversationId = useChatStore.getState().activeConversationId;
    state.addUserMessage('Primera conversación');

    state.startNewConversation('wallet-1');
    state.addUserMessage('Segunda conversación');

    render(<ChatHistoryList />);

    const openConversationButtons = screen.getAllByRole('button', { name: /Open conversation/ });
    expect(openConversationButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation Primera conversación' }));

    expect(useChatStore.getState().activeConversationId).toBe(firstConversationId);
  });

  it('deletes a conversation and updates list', () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.addUserMessage('Primera conversación');

    state.startNewConversation('wallet-1');
    state.addUserMessage('Segunda conversación');

    render(<ChatHistoryList />);

    const deleteButtons = screen.getAllByRole('button', { name: 'Delete conversation Primera conversación' });
    const beforeCount = screen.getAllByRole('button', { name: /Open conversation/ }).length;
    fireEvent.click(deleteButtons[0]);

    const afterCount = screen.getAllByRole('button', { name: /Open conversation/ }).length;
    expect(afterCount).toBe(beforeCount - 1);
  });

  it('clears all history', () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.addUserMessage('Primera conversación');

    state.startNewConversation('wallet-1');

    render(<ChatHistoryList />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear chat history' }));

    const openButtons = screen.getAllByRole('button', { name: /Open conversation/ });
    expect(openButtons).toHaveLength(1);
    expect(state.getConversationList()[0]?.title).toBe('Nueva conversación');
  });

  it('hides conversations from a different active wallet', () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');
    state.addUserMessage('Primera conversación');
    state.setCurrentWalletAddress('wallet-2');

    vi.mocked(useWallet).mockReturnValue({
      address: 'wallet-2',
      isConnected: true,
      isConnecting: false,
      isDisconnecting: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      exportPrivateKey: undefined,
      walletError: undefined,
      balances: undefined,
      balancesError: undefined,
      isBalancesLoading: false,
    } as unknown as ReturnType<typeof useWallet>);

    render(<ChatHistoryList />);

    expect(screen.queryByText('Primera conversación')).toBeNull();
    expect(screen.getByText('Nueva conversación')).toBeDefined();
  });
});
