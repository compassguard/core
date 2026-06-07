import { useQuery } from '@tanstack/react-query';
import { getNetworkStatus } from '@/lib/api/client';

export function useNetworkStatus() {
  return useQuery({
    queryKey: ['network', 'status'],
    queryFn: getNetworkStatus,
    refetchInterval: 30_000,
  });
}
