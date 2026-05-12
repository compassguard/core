// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTransactionHistory } from './useTransactionHistory';
import * as apiClient from '../lib/api/client';
import type { GetTransactionsResponse } from '../types/api';

const getTransactionsMock = vi.spyOn(apiClient, 'getTransactions');

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function makePage(nextCursor?: string) {
  return {
    transactions: [
      {
        tx_hash: `${Math.random()}`,
        type: 'other',
        status: 'success',
        timestamp: new Date().toISOString(),
        summary: 'Public Solana transaction',
        explorer_url: `https://explorer.solana.com/tx/${Math.random()}`,
      },
    ],
    next_cursor: nextCursor,
  } as GetTransactionsResponse;
}

describe('useTransactionHistory', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requests transaction pages by wallet and paginates with before cursor', async () => {
    getTransactionsMock
      .mockResolvedValueOnce(makePage('cursor-2'))
      .mockResolvedValueOnce(makePage());

    const { result } = renderHook(
      () => useTransactionHistory('  11111111111111111111111111111111  ', true),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(getTransactionsMock).toHaveBeenCalledTimes(1);
    });
    expect(getTransactionsMock).toHaveBeenCalledWith({
      address: '11111111111111111111111111111111',
      limit: 20,
      before: undefined,
    });

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(getTransactionsMock).toHaveBeenCalledTimes(2);
    });
    expect(getTransactionsMock).toHaveBeenLastCalledWith({
      address: '11111111111111111111111111111111',
      limit: 20,
      before: 'cursor-2',
    });
  });

  it('replaces query data on wallet change', async () => {
    getTransactionsMock.mockResolvedValue({
      transactions: [],
      next_cursor: undefined,
    });

    const { rerender } = renderHook(({ address }) => useTransactionHistory(address, true), {
      wrapper: createWrapper(),
      initialProps: { address: '11111111111111111111111111111111' },
    });

    await waitFor(() => {
      expect(getTransactionsMock).toHaveBeenCalledWith({
        address: '11111111111111111111111111111111',
        limit: 20,
        before: undefined,
      });
    });

    rerender({ address: '22222222222222222222222222222222' });
    await waitFor(() => {
      expect(getTransactionsMock).toHaveBeenCalledWith({
        address: '22222222222222222222222222222222',
        limit: 20,
        before: undefined,
      });
    });
  });
});
