import { useQuery } from '@tanstack/react-query';
import { getBalances } from '@/lib/api/client';

export function useWalletBalances(address?: string) {
  const walletAddress = address?.trim();
  return useQuery({
    queryKey: ['wallet', 'balances', walletAddress],
    queryFn: () => getBalances(walletAddress!),
    enabled: Boolean(walletAddress),
    refetchInterval: 30_000,
  });
}
