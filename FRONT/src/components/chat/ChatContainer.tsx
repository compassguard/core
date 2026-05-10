import { useEffect, useRef } from 'react';
import { useAgentMessage } from '@/hooks/useAgentMessage';
import { useChatStore } from '@/stores/chatStore';
import { useWallet } from '@/hooks/useWallet';
import { ChatInput } from './ChatInput';
import { MessageList } from './MessageList';

export function ChatContainer() {
  const messages = useChatStore((state) => state.messages);
  const status = useChatStore((state) => state.status);
  const pendingProposal = useChatStore((state) => state.pendingProposal);
  const blocked = useChatStore((state) => state.isInputBlocked());
  const readOnlyReason = useChatStore((state) => state.getActiveConversationReadOnlyReason());
  const setCurrentWalletAddress = useChatStore((state) => state.setCurrentWalletAddress);
  const wallet = useWallet();
  const { sendUserMessage, isPending } = useAgentMessage();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCurrentWalletAddress(wallet.address || null);
  }, [wallet.address, setCurrentWalletAddress]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, status]);

  const disabledPlaceholder = pendingProposal
    ? 'Confirm or cancel the proposal first'
    : status === 'executing'
      ? 'Preparing transaction...'
      : 'Wallet Copilot is responding...';

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-none bg-transparent md:rounded-3xl md:border md:border-outline md:bg-surface md:shadow-sm">
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-4 md:px-6 md:py-6">
        {readOnlyReason === 'session_expired' ? (
          <p className="mb-3 rounded-lg border border-warning bg-warning-bg px-3 py-2 text-sm text-warning">Esta conversación tiene sesión expirada. Envía un mensaje para continuar en una conversación nueva.</p>
        ) : null}
        {readOnlyReason === 'wallet_mismatch' ? (
          <p className="mb-3 rounded-lg border border-warning bg-warning-bg px-3 py-2 text-sm text-warning">Esta conversación fue creada con otra wallet. Selecciona o inicia una nueva para enviar.</p>
        ) : null}
        {readOnlyReason === 'proposal_stale' ? (
          <p className="mb-3 rounded-lg border border-warning bg-warning-bg px-3 py-2 text-sm text-warning">Esta conversación tiene una propuesta guardada solo como historial. Envía un mensaje para continuar en una conversación nueva.</p>
        ) : null}
        <MessageList messages={messages} />
        {status === 'thinking' ? <p className="mt-4 text-sm text-on-surface-variant">Copilot is thinking…</p> : null}
        <div ref={bottomRef} />
      </div>
      <div className="sticky bottom-0 bg-background/90 p-3 backdrop-blur md:rounded-b-3xl md:bg-surface/90 md:p-5">
        <ChatInput
          disabled={blocked || isPending}
          disabledPlaceholder={disabledPlaceholder}
          isThinking={status === 'thinking'}
          onSubmit={sendUserMessage}
        />
      </div>
    </section>
  );
}
