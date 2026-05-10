import { Send } from 'lucide-react';
import type { ConversationActionBlockReason, PendingProposal } from '@/types/chat';
import type { TransferParams } from '@/types/api';
import { truncateAddress } from '@/lib/format';
import { useAgentMessage } from '@/hooks/useAgentMessage';
import { RiskInlineAlert } from './RiskInlineAlert';

export function SendProposalCard({
  proposal,
  disabled = false,
  blockReason,
}: {
  proposal: PendingProposal;
  disabled?: boolean;
  blockReason: ConversationActionBlockReason | null;
}) {
  const params = proposal.function.params as TransferParams;
  const { approveProposal, rejectProposal } = useAgentMessage();
  const uiState = proposal.uiState;
  const isBusy =
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
    : 'Confirm Send';

  return (
    <div className="rounded-2xl border border-outline bg-surface p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary"><Send className="h-5 w-5" /></div>
        <div>
          <p className="text-sm font-semibold text-on-surface">Send Proposal</p>
          <p className="text-xs text-on-surface-variant">{proposal.display.summary}</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Detail label="Amount" value={`${params.amount} ${params.token}`} />
        <Detail label="Recipient" value={truncateAddress(params.recipient, 6, 6)} />
        {params.memo ? <Detail label="Memo" value={params.memo} /> : null}
        {proposal.display.fee_usd !== undefined ? <Detail label="Network fee" value={`$${proposal.display.fee_usd.toFixed(2)}`} /> : null}
      </div>
      <RiskInlineAlert risk={proposal.risk} />
      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <button
          onClick={rejectProposal}
          disabled={disabled || isBusy || done || failed || cancelled}
          className="rounded-xl border border-outline px-4 py-3 text-sm font-semibold text-on-surface hover:bg-surface-hover disabled:opacity-50"
        >
          {isBusy ? 'Cancel' : cancelled ? 'Cancelled' : done ? 'Done' : 'Cancel'}
        </button>
        <button
          onClick={approveProposal}
          disabled={disabled || isBusy || done || failed || cancelled}
          className={`flex-1 rounded-xl px-4 py-3 text-sm font-semibold text-on-primary disabled:opacity-50 ${disabled ? 'bg-warning' : proposal.risk.level === 'critical' ? 'bg-error-text hover:bg-error-text/90' : 'bg-primary hover:bg-primary-hover'}`}
        >
          {isBusy ? 'Preparing…' : done ? 'Confirmed' : failed || cancelled ? 'Failed' : confirmLabel}
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

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-outline bg-background px-3 py-2"><p className="text-xs text-on-surface-variant">{label}</p><p className="mt-1 text-sm font-semibold text-on-surface">{value}</p></div>;
}
