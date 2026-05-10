import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { MessageList } from '../MessageList';
import { useChatStore } from '../../../stores/chatStore';

vi.mock('../AgentMessage', () => ({
  AgentMessage: ({ message }: { message: { content: string } }) => <p>{message.content}</p>,
}));

vi.mock('../UserMessage', () => ({
  UserMessage: () => null,
}));

vi.mock('./../proposals/ProposalCard', () => ({
  ProposalCard: () => null,
}));

vi.mock('../AlertBanner', () => ({
  AlertBanner: () => null,
}));

vi.mock('../TxResultMessage', () => ({
  TxResultMessage: () => null,
}));

function reset() {
  useChatStore.getState().clearHistory();
  useChatStore.persist.clearStorage();
}

beforeEach(() => {
  reset();
});

afterEach(() => {
  cleanup();
  reset();
});

describe('MessageList', () => {
  it('shows streaming assistant text as it arrives', () => {
    const state = useChatStore.getState();
    state.startNewConversation('wallet-1');

    state.startStreaming();
    state.appendToken('Hola ');
    state.appendToken('mundo');

    render(<MessageList messages={state.messages} />);

    expect(screen.queryByText('Hola mundo')).not.toBeNull();
  });
});
