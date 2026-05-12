import { CheckCircle2, Crown } from 'lucide-react';
import { truncateAddress } from '@/lib/format';
import { useWallet } from '@/hooks/useWallet';

export function AccountCard() {
  const { address } = useWallet();
  return (
    <div className="rounded-3xl border border-outline bg-surface p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg font-bold text-on-primary">
          W
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold text-on-surface">Verified Account</p>
            <CheckCircle2 className="h-4 w-4 text-success" />
          </div>
          <p className="font-mono text-xs text-on-surface-variant">{truncateAddress(address, 5, 5)}</p>
        </div>
      </div>
      <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-xs font-semibold text-success">
        <Crown className="h-3.5 w-3.5" /> Premium
      </div>
    </div>
  );
}
