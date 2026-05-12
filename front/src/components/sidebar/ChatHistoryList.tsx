import React, { useMemo } from 'react';
import { ListMinus, Plus, Trash2 } from 'lucide-react';
import { useWallet } from '@/hooks/useWallet';
import { useChatStore } from '@/stores/chatStore';
import type { PersistedConversation } from '@/types/chat';

export function ChatHistoryList() {
  const wallet = useWallet();
  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const conversationOrder = useChatStore((state) => state.conversationOrder);
  const conversationsById = useChatStore((state) => state.conversationsById);
  const clearHistory = useChatStore((state) => state.clearHistory);
  const startNewConversation = useChatStore((state) => state.startNewConversation);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const conversations = useMemo(() => {
    return conversationOrder
      .map((id) => conversationsById[id])
      .filter((conversation): conversation is PersistedConversation => Boolean(conversation));
  }, [conversationOrder, conversationsById]);

  return (
    <div className="rounded-2xl border border-outline bg-surface p-3 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-on-surface">Chat Session</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => startNewConversation(wallet.address || null)}
            className="rounded-lg border border-outline px-2 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-hover"
            aria-label="Start new conversation"
          >
            <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> Nueva</span>
          </button>
          <button
            type="button"
            onClick={clearHistory}
            disabled={!activeConversationId}
            className="rounded-lg border border-outline px-2 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Clear chat history"
          >
            <span className="flex items-center gap-1"><ListMinus className="h-3 w-3" /> Clear</span>
          </button>
        </div>
      </div>
      {conversations.length === 0 ? (
        <p className="px-1 py-4 text-sm text-on-surface-variant">No hay conversaciones.</p>
      ) : (
        <div className="space-y-1">
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`rounded-lg border px-2 py-2 ${conversation.id === activeConversationId ? 'border-primary/60' : 'border-outline/80'}`}
            >
              <div className="space-y-1">
                <p className="truncate text-sm font-semibold text-on-surface">{conversation.title}</p>
                <p className="text-xs text-on-surface-variant">
                  {new Date(conversation.updatedAt).toLocaleString([], {
                    month: 'short',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
                {conversation.sessionStatus === 'expired' ? (
                  <p className="text-xs font-medium text-warning">Sesión expirada</p>
                ) : null}
                {conversation.walletStatus === 'mismatch' ? (
                  <p className="text-xs font-medium text-error-text">Wallet distinta</p>
                ) : null}
                {conversation.hasPendingProposal ? (
                  <p className="text-xs font-medium text-warning">Propuesta no reanudable</p>
                ) : null}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => selectConversation(conversation.id)}
                  className="rounded-lg border border-outline px-2 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-hover"
                  aria-label={`Open conversation ${conversation.title}`}
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => deleteConversation(conversation.id)}
                  className="rounded-lg border border-outline px-2 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-hover"
                  aria-label={`Delete conversation ${conversation.title}`}
                >
                  <span className="flex items-center gap-1">
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
