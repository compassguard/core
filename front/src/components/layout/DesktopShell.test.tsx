// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopShell } from './DesktopShell';
import * as React from 'react';
import { useTransactionHistory } from '../../hooks/useTransactionHistory';
import { useWallet } from '../../hooks/useWallet';

vi.mock('../../hooks/useTransactionHistory', () => ({ useTransactionHistory: vi.fn() }));
vi.mock('../../hooks/useWallet', () => ({ useWallet: vi.fn() }));
vi.mock('./TopBar', () => ({ TopBar: () => <div>top bar</div> }));
vi.mock('../sidebar/AccountCard', () => ({ AccountCard: () => null }));
vi.mock('../sidebar/ChatHistoryList', () => ({ ChatHistoryList: () => null }));
vi.mock('../sidebar/QuickActionsList', () => ({
  QuickActionsList: ({ onSettings }: { onSettings: () => void }) => <button type="button" onClick={onSettings}>settings</button>,
}));
vi.mock('../sidebar/SettingsSheet', () => ({ SettingsSheet: () => null }));
vi.mock('../chat/ChatContainer', () => ({ ChatContainer: () => null }));
vi.mock('../wallet/AssetList', () => ({ AssetList: () => null }));
vi.mock('./RightPanel', () => ({ RightPanel: () => null }));

const mockUseTransactionHistory = vi.mocked(useTransactionHistory);
const mockUseWallet = vi.mocked(useWallet);

const sharedHistoryItem = {
  tx_hash: '3N1aR5kX',
  type: 'other' as const,
  status: 'success' as const,
  timestamp: new Date().toISOString(),
  summary: 'Public Solana transaction',
  amount: -0.125,
  amount_symbol: 'SOL',
  explorer_url: 'https://explorer.solana.com/tx/3N1aR5kX',
};

function makeHistoryState(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isFetchingNextPage: false,
    isError: false,
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    ...overrides,
  } as unknown as ReturnType<typeof useTransactionHistory>;
}

function makeWalletState() {
  return {
    isConnected: true,
    isConnecting: false,
    address: '11111111111111111111111111111111',
    isBalancesLoading: false,
    balances: undefined,
    walletError: undefined,
    balancesError: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    exportPrivateKey: undefined,
    signAndSendPreparedTransaction: vi.fn(),
    allocation: [],
    highlightBalances: {},
    refreshBalances: vi.fn(),
    isDisconnecting: false,
  };
}

describe('DesktopShell HistoryView', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('shows loading state', () => {
    mockUseWallet.mockReturnValue(makeWalletState());
    mockUseTransactionHistory.mockReturnValue(makeHistoryState({ isLoading: true }));

    render(<DesktopShell activeTab="History" onTabChange={() => {}} />);

    expect(screen.getByText('Loading public history...')).toBeDefined();
  });

  it('shows empty state and privacy boundary', () => {
    mockUseWallet.mockReturnValue(makeWalletState());
    mockUseTransactionHistory.mockReturnValue(makeHistoryState({ data: { pages: [{ transactions: [] }] } }));

    render(<DesktopShell activeTab="History" onTabChange={() => {}} />);

    expect(screen.getByText('No public transactions found.')).toBeDefined();
    expect(screen.getByText(/Umbra private history is not enabled/)).toBeDefined();
  });

  it('shows error state and privacy boundary', () => {
    mockUseWallet.mockReturnValue(makeWalletState());
    mockUseTransactionHistory.mockReturnValue(makeHistoryState({ isError: true, error: new Error('provider_error') }));

    render(<DesktopShell activeTab="History" onTabChange={() => {}} />);

    expect(screen.getByText('Unable to load public transaction history.')).toBeDefined();
    expect(screen.getByText(/public on-chain activity only/)).toBeDefined();
  });

  it('renders list items and requests next page', () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    mockUseWallet.mockReturnValue(makeWalletState());
    mockUseTransactionHistory.mockReturnValue(
      makeHistoryState({
        data: { pages: [{ transactions: [sharedHistoryItem, { ...sharedHistoryItem, tx_hash: '7m2B4x9' }] }] },
        hasNextPage: true,
        fetchNextPage: loadMore,
      }),
    );

    render(<DesktopShell activeTab="History" onTabChange={() => {}} />);

    expect(screen.getAllByText('Public Solana transaction')).toHaveLength(2);
    expect(screen.getAllByText('-0.125 SOL')).toHaveLength(2);
    expect(screen.getAllByText('Net wallet change')).toHaveLength(2);
    expect(screen.getByText('Load more')).toBeDefined();

    const loadMoreButton = screen.getByRole('button', { name: 'Load more' });
    act(() => {
      fireEvent.click(loadMoreButton);
    });

    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});
