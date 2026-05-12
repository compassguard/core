import { useQuery } from '@tanstack/react-query';
import { getAllocation } from '@/lib/api/client';

export function useWalletAllocation(address?: string) {
  return useQuery({
    queryKey: ['wallet', 'allocation', address],
    queryFn: () => getAllocation(address!),
    enabled: Boolean(address),
    refetchInterval: 60_000,
  });
}
