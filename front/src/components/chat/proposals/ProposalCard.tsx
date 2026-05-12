import type { ConversationActionBlockReason, PendingProposal } from '@/types/chat';
import { SendProposalCard } from './SendProposalCard';
import { SwapProposalCard } from './SwapProposalCard';
import { ConditionalBuyProposalCard } from './ConditionalBuyProposalCard';

export function ProposalCard({
  proposal,
  disabled,
  blockReason,
}: {
  proposal: PendingProposal;
  disabled?: boolean;
  blockReason: ConversationActionBlockReason | null;
}) {
  if (proposal.function.name === 'swap' || proposal.function.name === 'swap_orca_usdc_to_sol') {
    return <SwapProposalCard proposal={proposal} disabled={disabled} blockReason={blockReason} />;
  }
  if (proposal.function.name === 'transfer') return <SendProposalCard proposal={proposal} disabled={disabled} blockReason={blockReason} />;
  if (proposal.function.name === 'conditional_buy_sol') {
    return <ConditionalBuyProposalCard proposal={proposal} disabled={disabled} blockReason={blockReason} />;
  }
  return (
    <div className="rounded-2xl border border-outline bg-surface p-6 shadow-sm">
      <p className="text-sm font-semibold text-on-surface">Unsupported proposal UI</p>
      <p className="mt-1 text-sm text-on-surface-variant">{proposal.display.summary}</p>
    </div>
  );
}
