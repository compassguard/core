import { useQuery } from '@tanstack/react-query';
import { getConditionalOrders } from '@/lib/api/client';

export function useConditionalOrders(userAddress?: string) {
  return useQuery({
    queryKey: ['conditional-orders', userAddress],
    queryFn: () => getConditionalOrders(userAddress || ''),
    enabled: Boolean(userAddress),
    refetchInterval: 15_000,
  });
}
