import type { ChatMessage, PendingProposal } from '@/types/chat';
import { AgentMessage } from './AgentMessage';
import { AlertBanner } from './AlertBanner';
import { TxResultMessage } from './TxResultMessage';
import { UserMessage } from './UserMessage';
import { ProposalCard } from './proposals/ProposalCard';
import { useChatStore } from '@/stores/chatStore';

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const pendingProposal = useChatStore((state) => state.pendingProposal);
  const canApproveProposal = useChatStore((state) => state.canApproveProposal());
  const activeConversationReadOnlyReason = useChatStore((state) => state.getActiveConversationReadOnlyReason());

  const blockReason = !canApproveProposal
    ? activeConversationReadOnlyReason
    : null;

  return (
    <div className="space-y-5">
      {messages.map((message) => {
        if (message.role === 'user') return <UserMessage key={message.id} message={message} />;
        if (message.type === 'alert') return <AlertBanner key={message.id} message={message} />;
        if (message.type === 'function_call') {
          const proposal: PendingProposal =
            pendingProposal && pendingProposal.id === message.id
              ? pendingProposal
              : {
                  ...(message as PendingProposal),
                  uiState: (message as PendingProposal).uiState || 'pending',
                };
          return (
            <ProposalCard
              key={message.id}
              proposal={proposal}
              disabled={!!blockReason}
              blockReason={blockReason}
            />
          );
        }
        if (message.type === 'text' && message.execute) return <TxResultMessage key={message.id} message={message} />;
        if (message.type === 'text') return <AgentMessage key={message.id} message={message} />;
        return null;
      })}
    </div>
  );
}
