import React, { useMemo } from 'react';
import { ListMinus, Plus, Trash2 } from 'lucide-react';
import { useWallet } from '@/hooks/useWallet';
import { useChatStore } from '@/stores/chatStore';

export function ChatHistoryList() {
  const wallet = useWallet();
  const conversationsById = useChatStore((state) => state.conversationsById);
  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const clearHistory = useChatStore((state) => state.clearHistory);
  const startNewConversation = useChatStore((state) => state.startNewConversation);

  const visibleConversations = useMemo(
    () =>
      Object.values(conversationsById).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      ),
    [conversationsById]
  );

  return (
    <div className="rounded-2xl border border-outline bg-surface p-3 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-on-surface">Chat History</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => startNewConversation(wallet.address || null)}
            className="rounded-lg border border-outline px-2 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-hover"
            aria-label="Start new conversation"
          >
            <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> Nuevo</span>
          </button>
          <button
            type="button"
            onClick={clearHistory}
            disabled={visibleConversations.length === 0}
            className="rounded-lg border border-outline px-2 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Clear chat history"
          >
            <span className="flex items-center gap-1"><ListMinus className="h-3 w-3" /> Clear</span>
          </button>
        </div>
      </div>
      {visibleConversations.length === 0 ? (
        <p className="px-1 py-4 text-sm text-on-surface-variant">No tienes historial guardado.</p>
      ) : null}
      <div className="space-y-1">
        {visibleConversations.map((conversation) => {
          const isActive = conversation.id === activeConversationId;
          return (
            <div
              key={conversation.id}
              className={`rounded-lg border px-2 py-2 ${
                isActive ? 'border-primary bg-surface-hover' : 'border-outline/80 bg-surface'
              }`}
            >
              <button
                type="button"
                onClick={() => selectConversation(conversation.id)}
                className="w-full text-left"
                aria-label={`Open conversation ${conversation.title}`}
              >
                <p className="truncate text-sm font-semibold text-on-surface">{conversation.title}</p>
                <p className="mt-1 text-xs text-on-surface-variant">
                  {new Date(conversation.updatedAt).toLocaleString([], {
                    month: 'short',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
                {conversation.sessionStatus === 'expired' ? (
                  <p className="mt-1 text-xs font-medium text-warning">Sesión expirada</p>
                ) : null}
                {conversation.walletStatus === 'mismatch' ? (
                  <p className="mt-1 text-xs font-medium text-error-text">Wallet distinta</p>
                ) : null}
                {conversation.hasPendingProposal ? (
                  <p className="mt-1 text-xs font-medium text-warning">Propuesta no reanudable</p>
                ) : null}
              </button>
              <div className="mt-2 flex items-center justify-end border-t border-outline/70 pt-2">
                <button
                  type="button"
                  onClick={() => deleteConversation(conversation.id)}
                  className="flex items-center gap-1 rounded-md border border-outline px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-hover"
                  aria-label={`Delete conversation ${conversation.title}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Borrar</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
