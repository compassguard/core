import { ArrowDownUp, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { ConversationActionBlockReason, PendingProposal } from '@/types/chat';
import type { OrcaSwapParams, SwapParams } from '@/types/api';
import { useAgentMessage } from '@/hooks/useAgentMessage';
import { useChatStore } from '@/stores/chatStore';
import { RiskInlineAlert } from './RiskInlineAlert';
import { SwapGuardWarning } from './SwapGuardWarning';

export function SwapProposalCard({
  proposal,
  disabled = false,
  blockReason,
}: {
  proposal: PendingProposal;
  disabled?: boolean;
  blockReason: ConversationActionBlockReason | null;
}) {
  const params = proposal.function.params as SwapParams | OrcaSwapParams;
  const isOrcaSwap = proposal.function.name === 'swap_orca_usdc_to_sol';
  const tokenLabel = (token: string) => (isOrcaSwap && token === 'USDC' ? 'devUSDC' : token);
  const payValue = isOrcaSwap
    ? `${(params as OrcaSwapParams).input_amount} ${tokenLabel((params as OrcaSwapParams).input_token)}`
    : `${(params as SwapParams).amount_in} ${(params as SwapParams).token_in}`;
  const receiveValue = isOrcaSwap
    ? tokenLabel((params as OrcaSwapParams).output_token)
    : (params as SwapParams).token_out;
  const { approveProposal, rejectProposal } = useAgentMessage();
  const uiState = useChatStore((state) => state.proposalUiState) ?? proposal.uiState;
  const swapGuardWarning = useChatStore((state) => state.swapGuardWarning);
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
    : 'Confirm Swap';

  return (
    <div className="rounded-2xl border border-outline bg-surface p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ArrowDownUp className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-semibold text-on-surface">Swap Proposal</p>
          <p className="text-xs text-on-surface-variant">{proposal.display.provider ?? 'Best route'}</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-2xl bg-background p-4">
          <p className="text-sm font-medium text-on-surface-variant">Summary</p>
          <p className="mt-1 text-lg font-semibold text-on-surface">{proposal.display.summary}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Detail label="Pay" value={payValue} />
          <Detail label="Receive" value={receiveValue} />
          {proposal.display.fee_usd !== undefined ? <Detail label="Network fee" value={`$${proposal.display.fee_usd.toFixed(2)}`} /> : null}
          {proposal.display.slippage_bps !== undefined ? <Detail label="Slippage" value={`${proposal.display.slippage_bps / 100}%`} /> : null}
        </div>
      </div>

      <RiskInlineAlert risk={proposal.risk} />

      {swapGuardWarning && <SwapGuardWarning warning={swapGuardWarning} />}

      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <button
          onClick={rejectProposal}
          disabled={disabled || busy || done || failed || cancelled}
          className="rounded-xl border border-outline px-4 py-3 text-sm font-semibold text-on-surface hover:bg-surface-hover disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={approveProposal}
          disabled={disabled || busy || done || failed || cancelled}
          className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-on-primary disabled:opacity-50 ${disabled ? 'bg-warning' : proposal.risk.level === 'critical' ? 'bg-error-text hover:bg-error-text/90' : 'bg-primary hover:bg-primary-hover'}`}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : done ? <CheckCircle2 className="h-4 w-4" /> : failed || cancelled ? <XCircle className="h-4 w-4" /> : null}
          {busy ? 'Executing…' : done ? 'Confirmed' : failed ? 'Failed' : cancelled ? 'Cancelled' : confirmLabel}
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
  return (
    <div className="rounded-xl border border-outline bg-surface px-3 py-2">
      <p className="text-xs text-on-surface-variant">{label}</p>
      <p className="mt-1 text-sm font-semibold text-on-surface">{value}</p>
    </div>
  );
}
