import { TrendingUp, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { ConversationActionBlockReason, PendingProposal } from '@/types/chat';
import type { ConditionalBuySolParams } from '@/types/api';
import { useAgentMessage } from '@/hooks/useAgentMessage';
import { RiskInlineAlert } from './RiskInlineAlert';

export function ConditionalBuyProposalCard({
  proposal,
  disabled = false,
  blockReason,
}: {
  proposal: PendingProposal;
  disabled?: boolean;
  blockReason: ConversationActionBlockReason | null;
}) {
  const params = proposal.function.params as ConditionalBuySolParams;
  const { approveProposal, rejectProposal } = useAgentMessage();
  const uiState = proposal.uiState;
  const busy =
    uiState === 'preparing_transaction' ||
    uiState === 'awaiting_signature' ||
    uiState === 'submitted' ||
    uiState === 'confirming';
  const done = uiState === 'confirmed';
  const failed = uiState === 'failed';
  const cancelled = uiState === 'cancelled';
  const confirmLabel = blockReason
    ? blockReason === 'session_expired'
      ? 'Sesión expirada'
      : blockReason === 'wallet_mismatch'
        ? 'Wallet distinta'
        : 'No reanudable'
    : 'Confirm Conditional Buy';

  const details = [
    { label: 'Entrada', value: `${params.input_amount} ${params.input_token}` },
    { label: 'Objetivo', value: `${params.target_price_usd} USD/SOL` },
    { label: 'SOL objetivo', value: `${params.desired_sol_amount || params.min_sol_out || '—'} SOL` },
    { label: 'Max USDC', value: `${params.max_usdc_in || params.input_amount} USDC` },
    { label: 'Recipient', value: params.recipient ? `${params.recipient.slice(0, 6)}…${params.recipient.slice(-4)}` : 'Tú' },
  ];
  if (params.order_pda) {
    details.push({ label: 'Orden', value: `${params.order_pda.slice(0, 6)}…${params.order_pda.slice(-4)}` });
  }
  if (params.expires_at) {
    const expiryDate = new Date(params.expires_at);
    if (!Number.isNaN(expiryDate.getTime())) {
      details.push({ label: 'Expira', value: expiryDate.toLocaleString() });
    }
  }

  return (
    <div className="rounded-2xl border border-outline bg-surface p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <TrendingUp className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-semibold text-on-surface">Conditional Buy Proposal</p>
          <p className="text-xs text-on-surface-variant">{proposal.display.provider ?? 'Guardrails Bot'}</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {details.map((item) => (
          <div key={item.label} className="rounded-xl border border-outline bg-background px-3 py-2">
            <p className="text-xs text-on-surface-variant">{item.label}</p>
            <p className="mt-1 text-sm font-semibold text-on-surface">{item.value}</p>
          </div>
        ))}
      </div>
      <RiskInlineAlert risk={proposal.risk} />
      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <button
          onClick={rejectProposal}
          disabled={disabled || busy || done || failed || cancelled}
          className="rounded-xl border border-outline px-4 py-3 text-sm font-semibold text-on-surface hover:bg-surface-hover disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => approveProposal()}
          disabled={disabled || busy || done || failed || cancelled}
          className={`flex-1 rounded-xl px-4 py-3 text-sm font-semibold text-on-primary disabled:opacity-50 ${
            disabled ? 'bg-warning' : proposal.risk.level === 'critical' ? 'bg-error-text hover:bg-error-text/90' : 'bg-primary hover:bg-primary-hover'
          }`}
        >
          {busy ? (
            <>
              <span className="inline-flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Executing…
              </span>
            </>
          ) : done ? (
            <>
              <span className="inline-flex items-center justify-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                Confirmed
              </span>
            </>
          ) : failed || cancelled ? (
            <>
              <span className="inline-flex items-center justify-center gap-2">
                <XCircle className="h-4 w-4" />
                {failed ? 'Failed' : 'Cancelled'}
              </span>
            </>
          ) : (
            confirmLabel
          )}
        </button>
      </div>
      {disabled ? (
        <p className="mt-2 text-xs text-warning">
          {blockReason === 'proposal_stale'
            ? 'Esta propuesta quedó en el historial; inicia una conversación nueva para continuar.'
            : 'No se puede aprobar en esta conversación.'}
        </p>
      ) : null}
    </div>
  );
}
