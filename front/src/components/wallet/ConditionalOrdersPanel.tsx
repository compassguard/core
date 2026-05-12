import { Clock3, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { triggerConditionalOrder } from '@/lib/api/client';
import type { ConditionalOrderSnapshot } from '@/types/api';
import { useConditionalOrders } from '@/hooks/useConditionalOrders';

function formatSol(lamports: number): string {
  return `${(lamports / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
}

function formatUsdc(amount: number): string {
  return `${(amount / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC_TEST`;
}

function formatTarget(priceE8: number): string {
  return `$${(priceE8 / 100_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function statusVariant(status: ConditionalOrderSnapshot['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'executed') return 'default';
  if (status === 'cancelled' || status === 'expired') return 'destructive';
  if (status === 'open') return 'secondary';
  return 'outline';
}

function OrderRow({ order }: { order: ConditionalOrderSnapshot }) {
  const queryClient = useQueryClient();
  const triggerMutation = useMutation({
    mutationFn: () => triggerConditionalOrder(order.orderPda),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['conditional-orders'] });
    },
  });

  const canTrigger = order.status === 'open' && order.observedExecutable;
  const expiresAt = new Date(order.expiresAt * 1000);

  return (
    <div className="border-t border-outline py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-on-surface">{formatSol(order.desiredSolLamports)}</p>
            <Badge variant={statusVariant(order.status)} className="capitalize">
              {order.status}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-on-surface-variant">Order {shortAddress(order.orderPda)}</p>
        </div>
        {canTrigger ? (
          <button
            onClick={() => triggerMutation.mutate()}
            disabled={triggerMutation.isPending}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-primary px-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
          >
            {triggerMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Trigger
          </button>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-on-surface-variant">Max escrow</p>
          <p className="mt-1 font-medium text-on-surface">{formatUsdc(order.maxUsdcIn)}</p>
        </div>
        <div>
          <p className="text-on-surface-variant">Target</p>
          <p className="mt-1 font-medium text-on-surface">{formatTarget(order.targetPriceUsdE8)}</p>
        </div>
        <div>
          <p className="text-on-surface-variant">Escrow</p>
          <p className="mt-1 font-medium text-on-surface">{shortAddress(order.escrowTokenAccount)}</p>
        </div>
        <div>
          <p className="text-on-surface-variant">Vault</p>
          <p className="mt-1 font-medium text-on-surface">{shortAddress(order.solVaultPda)}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-on-surface-variant">
        {order.observedExecutable ? <ShieldCheck className="h-4 w-4 text-success" /> : <Clock3 className="h-4 w-4" />}
        <span>{order.observedExecutable ? 'Observed executable' : order.observedExecutableReason || 'Waiting for condition'}</span>
      </div>
      <p className="mt-2 text-xs text-on-surface-variant">Expires {Number.isFinite(expiresAt.getTime()) ? expiresAt.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</p>
      {triggerMutation.error ? (
        <p className="mt-2 text-xs font-medium text-error-text">
          {triggerMutation.error instanceof Error ? triggerMutation.error.message : 'Trigger failed'}
        </p>
      ) : null}
    </div>
  );
}

export function ConditionalOrdersPanel({ userAddress }: { userAddress?: string }) {
  const query = useConditionalOrders(userAddress);

  return (
    <div className="rounded-2xl border border-outline bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-on-surface">Conditional Orders</p>
          <p className="mt-1 text-xs text-on-surface-variant">Devnet escrow settlement</p>
        </div>
        <button
          onClick={() => {
            void query.refetch();
          }}
          disabled={!userAddress || query.isFetching}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-outline text-on-surface-variant hover:bg-surface-hover disabled:opacity-50"
          aria-label="Refresh conditional orders"
        >
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {!userAddress ? (
        <p className="mt-4 text-sm text-on-surface-variant">Connect Phantom to view your open escrow orders.</p>
      ) : query.isLoading ? (
        <div className="mt-4 h-24 animate-pulse rounded-xl bg-surface-hover" />
      ) : query.isError ? (
        <p className="mt-4 text-sm text-error-text">Unable to load conditional orders.</p>
      ) : query.data && query.data.length > 0 ? (
        <div className="mt-4">
          {query.data.slice(0, 3).map((order) => (
            <OrderRow key={order.orderPda} order={order} />
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-on-surface-variant">No conditional escrow orders found.</p>
      )}
    </div>
  );
}
