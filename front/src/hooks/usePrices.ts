import { useQuery } from '@tanstack/react-query';
import { getPrices } from '@/lib/api/client';

export function usePrices(symbols: string[]) {
  return useQuery({
    queryKey: ['prices', symbols.join(',')],
    queryFn: () => getPrices(symbols),
    enabled: symbols.length > 0,
    refetchInterval: 60_000,
  });
}
