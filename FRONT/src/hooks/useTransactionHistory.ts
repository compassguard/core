import { useInfiniteQuery } from '@tanstack/react-query';
import { getTransactions } from '../lib/api/client';

const PAGE_LIMIT = 20;

export function useTransactionHistory(address?: string, enabled = false) {
  const normalizedAddress = address?.trim();

  return useInfiniteQuery({
    queryKey: ['wallet', 'transactions', normalizedAddress, PAGE_LIMIT],
    queryFn: ({ pageParam }) =>
      getTransactions({
        address: normalizedAddress!,
        limit: PAGE_LIMIT,
        ...(pageParam ? { before: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: Boolean(normalizedAddress) && enabled,
  });
}
