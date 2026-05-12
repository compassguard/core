import { Wifi, WifiOff } from 'lucide-react';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';

export function ConnectionStatus() {
  const { data, isError, isLoading } = useNetworkStatus();
  const connected = data?.connected && !isError;

  return (
    <div className="rounded-2xl border border-outline bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-full ${connected ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning-text'}`}>
          {connected ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
        </div>
        <div>
          <p className="text-sm font-semibold text-on-surface">
            {isLoading ? 'Checking network…' : connected ? 'Mainnet Connected' : 'Network status unavailable'}
          </p>
          <p className="text-xs text-on-surface-variant">
            {data ? `${data.latency_ms}ms latency${data.tps ? ` · ${data.tps} TPS` : ''}` : '—'}
          </p>
        </div>
      </div>
    </div>
  );
}
