import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { AgentMessage, ExecuteInfo } from '@/types/api';
import type {
  AgentChatMessage,
  ChatMessage,
  ChatStatus,
  ConversationActionBlockReason,
  ConversationSessionStatus,
  ConversationWalletStatus,
  PersistedConversation,
  PendingProposal,
  ProposalUiState,
  UserChatMessage,
} from '@/types/chat';

const CHAT_STORE_NAME = 'wallet-copilot-chat-history';
const CHAT_STORE_SCHEMA_VERSION = 2;
const MAX_CONVERSATIONS = 20;
const SESSION_TTL_MS = 30 * 60 * 1000;
const inMemorySessionStorage: Record<string, string> = {};

function isoNow(): string {
  return new Date().toISOString();
}

function getSafeChatStorage() {
  const browserStorage =
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
      ? window.localStorage
      : null;

  const hasSetItem =
    !!browserStorage &&
    typeof browserStorage.getItem === 'function' &&
    typeof browserStorage.setItem === 'function' &&
    typeof browserStorage.removeItem === 'function' &&
    typeof browserStorage.clear === 'function';

  if (hasSetItem) return browserStorage;

  return {
    getItem: (key: string) => {
      return key in inMemorySessionStorage ? inMemorySessionStorage[key] : null;
    },
    setItem: (key: string, value: string) => {
      inMemorySessionStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete inMemorySessionStorage[key];
    },
    clear: () => {
      Object.keys(inMemorySessionStorage).forEach((key) => {
        delete inMemorySessionStorage[key];
      });
    },
  };
}

function toId(prefix = 'msg') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toIso(timestamp: string | number): number {
  return typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
}

function safeIsoDate(value: string): string {
  return Number.isFinite(toIso(value)) ? value : isoNow();
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toConversationStatus(conversation: PersistedConversation, now = Date.now()): ConversationSessionStatus {
  if (!conversation.sessionId) return 'unknown';
  const updatedAt = toIso(conversation.updatedAt);
  if (!Number.isFinite(updatedAt)) return 'unknown';
  return now - updatedAt > SESSION_TTL_MS ? 'expired' : 'active';
}

function toWalletStatus(
  conversation: PersistedConversation,
  currentWalletAddress: string | null
): ConversationWalletStatus {
  if (!currentWalletAddress) return conversation.lastWalletAddress ? 'mismatch' : 'unknown';
  if (!conversation.lastWalletAddress) return 'unknown';
  return conversation.lastWalletAddress === currentWalletAddress ? 'match' : 'mismatch';
}

function deriveConversationTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user');
  if (firstUser?.type === 'text' && firstUser.content.trim()) {
    return firstUser.content.trim().slice(0, 50).trim();
  }

  const firstProposal = messages.find((message) => message.type === 'function_call');
  if (firstProposal && firstProposal.type === 'function_call' && firstProposal.display?.summary) {
    return firstProposal.display.summary.slice(0, 50).trim();
  }

  return 'Nueva conversación';
}

function syncConversationMetadata(
  conversation: PersistedConversation,
  currentWalletAddress: string | null,
  now = Date.now()
): PersistedConversation {
  const explicitSessionStatus =
    conversation.sessionStatus === 'expired' ? 'expired' : toConversationStatus(conversation, now);
  return {
    ...conversation,
    sessionStatus: explicitSessionStatus,
    walletStatus: toWalletStatus(conversation, currentWalletAddress),
  };
}

function makeWelcomeMessage(): AgentChatMessage {
  return {
    id: toId('welcome'),
    role: 'agent',
    type: 'text',
    content: 'Hola, soy Compass. Dime qué quieres hacer en Solana y te ayudaré a hacerlo de forma segura.',
    timestamp: isoNow(),
  };
}

function makeConversation(params: {
  walletAddress: string | null;
}): PersistedConversation {
  const now = isoNow();
  const messages = [makeWelcomeMessage()];
  return {
    id: toId('conv'),
    sessionId: null,
    title: deriveConversationTitle(messages),
    messages,
    createdAt: now,
    updatedAt: now,
    walletAddressAtCreation: params.walletAddress,
    lastWalletAddress: params.walletAddress,
    hasPendingProposal: false,
    pendingProposalPreview: null,
    sessionStatus: 'unknown',
    walletStatus: 'unknown',
  };
}

type PersistedStoreShape = {
  schemaVersion: number;
  activeConversationId: string | null;
  activeWalletAddress: string | null;
  sessionId: string | null;
  conversationsById: Record<string, PersistedConversation>;
  conversationOrder: string[];
};

export type SwapGuardWarningState = {
  code: 'price_deviation_warning';
  message: string;
  deviation_bps: number;
} | null;

type ChatStore = {
  schemaVersion: number;
  activeConversationId: string | null;
  activeWalletAddress: string | null;
  conversationsById: Record<string, PersistedConversation>;
  conversationOrder: string[];
  sessionId: string | null;
  messages: ChatMessage[];
  pendingProposal: PendingProposal | null;
  proposalUiState: ProposalUiState | null;
  swapGuardWarning: SwapGuardWarningState;
  status: ChatStatus;
  streamingContent: string;

  // Computed helpers
  isInputBlocked: () => boolean;
  getActiveConversation: () => PersistedConversation | null;
  getConversationList: () => PersistedConversation[];
  getActiveConversationReadOnlyReason: () => ConversationActionBlockReason | null;
  canApproveProposal: () => boolean;

  // Conversation management
  startNewConversation: (walletAddress?: string | null) => void;
  selectConversation: (conversationId: string) => void;
  deleteConversation: (conversationId: string) => void;
  clearHistory: () => void;
  ensureConversationForInput: (walletAddress: string | null) => void;
  setCurrentWalletAddress: (walletAddress: string | null) => void;
  setConversationExpired: () => void;
  // Legacy alias for compatibility
  clearChat: () => void;

  // Session actions
  setSessionId: (sessionId: string) => void;

  // Message actions
  addUserMessage: (content: string) => void;
  addAgentMessages: (messages: AgentMessage[]) => void;

  // Streaming actions
  startStreaming: () => void;
  appendToken: (content: string) => void;
  finishStreaming: () => void;

  // Proposal actions
  setPendingProposal: (proposal: PendingProposal | null) => void;
  setProposalFromSSE: (proposal: Extract<AgentMessage, { type: 'function_call' }>) => void;
  setProposalUiState: (state: ProposalUiState | null) => void;
  setSwapGuardWarning: (warning: SwapGuardWarningState) => void;
  completeProposal: (status: 'success' | 'confirmed' | 'failed', execute?: ExecuteInfo) => void;

  // Status actions
  setStatus: (status: ChatStatus) => void;
};

function getConversationReadOnlyReason(
  conversation: PersistedConversation | null,
  pendingProposal: PendingProposal | null = null,
  now = Date.now()
): ConversationActionBlockReason | null {
  if (!conversation) return null;
  if (conversation.sessionStatus === 'expired') {
    return 'session_expired';
  }
  if (toConversationStatus(conversation, now) === 'expired') {
    return 'session_expired';
  }
  if (conversation.walletStatus === 'mismatch') {
    return 'wallet_mismatch';
  }
  if (conversation.hasPendingProposal && !pendingProposal) {
    return 'proposal_stale';
  }
  return null;
}

function orderConversationsFromIds(ids: string[]): string[] {
  return Array.from(new Set(ids)).filter(Boolean);
}

function pruneConversations(
  conversationsById: Record<string, PersistedConversation>,
  conversationOrder: string[]
): {
  conversationsById: Record<string, PersistedConversation>;
  conversationOrder: string[];
} {
  const dedupedOrder = orderConversationsFromIds(conversationOrder);
  const prunedIds = dedupedOrder.slice(0, MAX_CONVERSATIONS);
  const prunedById = Object.fromEntries(
    Object.entries(conversationsById).filter(([id]) => prunedIds.includes(id))
  );
  return {
    conversationsById: prunedById,
    conversationOrder: prunedIds,
  };
}

function ensureConversationOrder(order: string[], activeId: string): string[] {
  const filtered = orderConversationsFromIds(order).filter((id) => id !== activeId);
  return [activeId, ...filtered];
}

function migratePersistedState(rawState: unknown): PersistedStoreShape {
  const parsed = rawState && typeof rawState === 'object' ? (rawState as Record<string, unknown>) : {};
  const baseState = parsed.state && typeof parsed.state === 'object' ? (parsed.state as Record<string, unknown>) : parsed;
  const safeNow = isoNow();
  const migratedSessionId =
    typeof (baseState as { sessionId?: unknown } | null)?.sessionId === 'string'
      ? (baseState as { sessionId: string }).sessionId
      : null;
  const migratedActiveWalletAddress = toNullableString(baseState.activeWalletAddress);

  if (
    baseState &&
    typeof baseState === 'object' &&
    'conversationsById' in baseState &&
    'conversationOrder' in baseState
  ) {
    const maybe = baseState as PersistedStoreShape;
    const nextById = Object.fromEntries(
      Object.entries(maybe.conversationsById ?? {}).map(([id, conversation]) => {
        const base = conversation as PersistedConversation & { sessionStatus?: ConversationSessionStatus; walletStatus?: ConversationWalletStatus };
        const fallbackConversation = makeConversation({ walletAddress: null });
        return [
          id,
          syncConversationMetadata({
            id,
            sessionId: (base.sessionId as string | null | undefined) ?? migratedSessionId,
            title: base.title && typeof base.title === 'string' ? base.title : fallbackConversation.title,
            messages: Array.isArray(base.messages) ? base.messages : fallbackConversation.messages,
            createdAt: safeIsoDate(base.createdAt || safeNow),
            updatedAt: safeIsoDate(base.updatedAt || safeNow),
            walletAddressAtCreation: base.walletAddressAtCreation ?? null,
            lastWalletAddress: base.lastWalletAddress ?? null,
            hasPendingProposal: Boolean(base.hasPendingProposal),
            pendingProposalPreview: base.pendingProposalPreview ?? null,
            sessionStatus: base.sessionStatus ?? 'unknown',
            walletStatus: base.walletStatus ?? 'unknown',
          }, migratedActiveWalletAddress),
        ];
      })
    );

    const normalizedOrder = Array.isArray(maybe.conversationOrder)
      ? orderConversationsFromIds(maybe.conversationOrder.filter((id) => !!nextById[id]))
      : [];
    if (Object.keys(nextById).length === 0) {
      const fallbackConversation = syncConversationMetadata(
        makeConversation({ walletAddress: migratedActiveWalletAddress }),
        migratedActiveWalletAddress
      );
      nextById[fallbackConversation.id] = fallbackConversation;
      return {
        schemaVersion: CHAT_STORE_SCHEMA_VERSION,
        activeConversationId: fallbackConversation.id,
        activeWalletAddress: migratedActiveWalletAddress,
        sessionId: migratedSessionId,
        conversationsById: nextById,
        conversationOrder: [fallbackConversation.id],
      };
    }

    const activeConversationId = typeof maybe.activeConversationId === 'string' && nextById[maybe.activeConversationId]
      ? maybe.activeConversationId
      : normalizedOrder[0];

    if (!activeConversationId) {
      const first = Object.keys(nextById)[0];
      return {
        schemaVersion: CHAT_STORE_SCHEMA_VERSION,
        activeConversationId: first,
        activeWalletAddress: migratedActiveWalletAddress,
        sessionId: migratedSessionId,
        conversationsById: nextById,
        conversationOrder: normalizedOrder,
      };
    }

    return {
      schemaVersion: CHAT_STORE_SCHEMA_VERSION,
      activeConversationId,
      activeWalletAddress: migratedActiveWalletAddress,
      sessionId: migratedSessionId,
      conversationsById: nextById,
      conversationOrder: normalizedOrder,
    };
  }

  if (
    baseState &&
    typeof baseState === 'object' &&
    'sessionId' in baseState &&
    'messages' in baseState
  ) {
    const fallbackConversation = syncConversationMetadata(
      {
        id: toId('conv'),
        sessionId:
          typeof (baseState as { sessionId: unknown }).sessionId === 'string'
            ? (baseState as { sessionId: string }).sessionId
            : null,
        title: 'Nueva conversación',
        messages: Array.isArray((baseState as { messages: unknown }).messages)
          ? ((baseState as { messages: ChatMessage[] }).messages || []).map((message) => message)
          : [makeWelcomeMessage()],
        createdAt: safeNow,
        updatedAt: safeNow,
        walletAddressAtCreation: null,
        lastWalletAddress: null,
        hasPendingProposal: false,
        pendingProposalPreview: null,
        sessionStatus: 'unknown',
        walletStatus: 'unknown',
      },
      null
    );
    fallbackConversation.title = deriveConversationTitle(fallbackConversation.messages);
    const finalState = syncConversationMetadata(fallbackConversation, null);
    return {
      schemaVersion: CHAT_STORE_SCHEMA_VERSION,
      activeConversationId: finalState.id,
      activeWalletAddress: null,
      sessionId: migratedSessionId,
      conversationsById: { [finalState.id]: finalState },
      conversationOrder: [finalState.id],
    };
  }

  const initialConversation = syncConversationMetadata(
    makeConversation({ walletAddress: null }),
    null
  );
  return {
    schemaVersion: CHAT_STORE_SCHEMA_VERSION,
    activeConversationId: initialConversation.id,
    activeWalletAddress: null,
    sessionId: null,
    conversationsById: { [initialConversation.id]: initialConversation },
    conversationOrder: [initialConversation.id],
  };
}

function sanitizeIncomingState(rawState: unknown): PersistedStoreShape {
  const migrated = migratePersistedState(rawState);
  const now = Date.now();
  const conversationsById = Object.fromEntries(
    Object.entries(migrated.conversationsById).map(([id, conversation]) => [
      id,
      syncConversationMetadata(
        {
          ...conversation,
          sessionId: conversation.sessionId ?? migrated.sessionId,
        },
        migrated.activeWalletAddress,
        now
      ),
    ])
  );

  const order = ensureConversationOrder(
    pruneConversations(conversationsById, migrated.conversationOrder).conversationOrder,
    migrated.activeConversationId || ''
  );

  const existingActiveConversationId = order.includes(migrated.activeConversationId || '')
    ? migrated.activeConversationId || ''
    : order[0] || Object.keys(conversationsById)[0];

  const activeConversationId = existingActiveConversationId || toId('conv');
  const hasActive = !!conversationsById[activeConversationId];
  if (!hasActive) {
    const fallback = syncConversationMetadata(
      makeConversation({ walletAddress: migrated.activeWalletAddress }),
      migrated.activeWalletAddress
    );
    conversationsById[fallback.id] = fallback;
    return {
      schemaVersion: CHAT_STORE_SCHEMA_VERSION,
      activeConversationId: fallback.id,
      activeWalletAddress: migrated.activeWalletAddress,
      sessionId: migrated.sessionId,
      conversationsById,
      conversationOrder: ensureConversationOrder([fallback.id], fallback.id),
    };
  }

  const pruned = pruneConversations(conversationsById, order);
  return {
    schemaVersion: CHAT_STORE_SCHEMA_VERSION,
    activeConversationId,
    activeWalletAddress: migrated.activeWalletAddress,
    sessionId: migrated.sessionId,
    conversationsById: pruned.conversationsById,
    conversationOrder: pruned.conversationOrder,
  };
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => {
      const baseConversation = syncConversationMetadata(
        makeConversation({ walletAddress: null }),
        null
      );
      const baseState: ChatStore = {
        schemaVersion: CHAT_STORE_SCHEMA_VERSION,
        activeConversationId: baseConversation.id,
        activeWalletAddress: null,
        conversationsById: { [baseConversation.id]: baseConversation },
        conversationOrder: [baseConversation.id],
        sessionId: null,
        messages: [makeWelcomeMessage()],
        pendingProposal: null,
        proposalUiState: null,
        swapGuardWarning: null,
        status: 'idle',
        streamingContent: '',

        // Computed
        isInputBlocked: () => {
          const state = get();
          return state.status !== 'idle' || state.pendingProposal !== null;
        },

        getActiveConversation: () => {
          const state = get();
          const conversation = state.activeConversationId ? state.conversationsById[state.activeConversationId] : null;
          if (!conversation) return null;
          return syncConversationMetadata(conversation, state.activeWalletAddress);
        },

        getConversationList: () => {
          const state = get();
          return Object.values(state.conversationsById).sort((a, b) => {
            return toIso(b.updatedAt) - toIso(a.updatedAt);
          });
        },

        getActiveConversationReadOnlyReason: () => {
          const state = get();
          const active = state.getActiveConversation();
          return getConversationReadOnlyReason(active, state.pendingProposal);
        },

        canApproveProposal: () => {
          const state = get();
          const active = state.getActiveConversation();
          if (!active) return false;
          if (getConversationReadOnlyReason(active, state.pendingProposal)) return false;
          return state.pendingProposal !== null && state.status !== 'thinking' && state.status !== 'executing';
        },

        setCurrentWalletAddress: (walletAddress) => {
          set((state) => {
            const now = Date.now();
            const conversationsById = Object.fromEntries(
              Object.entries(state.conversationsById).map(([id, conversation]) => [
                id,
                syncConversationMetadata(conversation, walletAddress, now),
              ]),
            );
            return {
              activeWalletAddress: walletAddress,
              conversationsById,
            };
          });
        },

        ensureConversationForInput: (walletAddress) => {
          const state = get();
          state.setCurrentWalletAddress(walletAddress);
          const active = state.getActiveConversation();
          if (!active) {
            state.startNewConversation(walletAddress);
            return;
          }
          const reason = getConversationReadOnlyReason(active, get().pendingProposal);
          if (reason) {
            state.startNewConversation(walletAddress);
          }
        },

        setConversationExpired: () => {
          set((state) => {
            if (!state.activeConversationId) return {};
            const conversation = state.conversationsById[state.activeConversationId];
            if (!conversation) return {};
            const now = isoNow();
            const expiredConversation: PersistedConversation = {
              ...conversation,
              sessionStatus: 'expired',
              updatedAt: now,
            };
            return {
              conversationsById: {
                ...state.conversationsById,
                [state.activeConversationId]: expiredConversation,
              },
              pendingProposal: null,
              proposalUiState: null,
              status: 'idle',
            };
          });
        },

        startNewConversation: (walletAddress) => {
          const safeWalletAddress = walletAddress ?? get().activeWalletAddress;
          const now = isoNow();
          const welcomeMessage = makeWelcomeMessage();
          const conversation = syncConversationMetadata(
            {
              id: toId('conv'),
              sessionId: null,
              title: deriveConversationTitle([welcomeMessage]),
              messages: [welcomeMessage],
              createdAt: now,
              updatedAt: now,
              walletAddressAtCreation: safeWalletAddress,
              lastWalletAddress: safeWalletAddress,
              hasPendingProposal: false,
              pendingProposalPreview: null,
              sessionStatus: 'unknown',
              walletStatus: safeWalletAddress ? 'match' : 'unknown',
            },
            safeWalletAddress
          );
          const conversationOrder = ensureConversationOrder(get().conversationOrder, conversation.id);
          const pruned = pruneConversations(
            {
              ...get().conversationsById,
              [conversation.id]: conversation,
            },
            conversationOrder
          );
          set({
            activeConversationId: conversation.id,
            sessionId: null,
            messages: [welcomeMessage],
            pendingProposal: null,
            proposalUiState: null,
            status: 'idle',
            streamingContent: '',
            conversationsById: {
              ...pruned.conversationsById,
              [conversation.id]: conversation,
            },
            conversationOrder: pruned.conversationOrder,
          });
        },

        selectConversation: (conversationId) => {
          set((state) => {
            const conversation = state.conversationsById[conversationId];
            if (!conversation) return {};

            const syncedConversation = syncConversationMetadata(
              conversation,
              state.activeWalletAddress
            );

            return {
              activeConversationId: conversationId,
              sessionId: syncedConversation.sessionId,
              messages: syncedConversation.messages,
              status: 'idle',
              pendingProposal: syncedConversation.hasPendingProposal ? null : null,
              proposalUiState: syncedConversation.hasPendingProposal ? 'pending' : null,
              streamingContent: '',
              conversationsById: {
                ...state.conversationsById,
                [conversationId]: syncedConversation,
              },
            };
          });
        },

        deleteConversation: (conversationId) => {
          set((state) => {
            if (!state.conversationsById[conversationId]) return {};
            const nextById = { ...state.conversationsById };
            delete nextById[conversationId];
            const nextOrder = orderConversationsFromIds(
              state.conversationOrder.filter((id) => id !== conversationId)
            );
            const nextPruned = pruneConversations(nextById, nextOrder);
            let nextActiveConversationId = state.activeConversationId;
            if (state.activeConversationId === conversationId) {
              nextActiveConversationId = nextPruned.conversationOrder[0] || null;
            }

            if (!nextActiveConversationId) {
              const nextConversation = makeConversation({ walletAddress: state.activeWalletAddress });
              return {
                conversationsById: {
                  ...nextPruned.conversationsById,
                  [nextConversation.id]: syncConversationMetadata(
                    nextConversation,
                    state.activeWalletAddress
                  ),
                },
                conversationOrder: ensureConversationOrder(nextPruned.conversationOrder, nextConversation.id),
                activeConversationId: nextConversation.id,
                sessionId: null,
                messages: [makeWelcomeMessage()],
                pendingProposal: null,
                proposalUiState: null,
                status: 'idle',
                streamingContent: '',
              };
            }

            return {
              conversationsById: nextPruned.conversationsById,
              conversationOrder: nextPruned.conversationOrder,
              activeConversationId: nextActiveConversationId,
              ...(() => {
                const conversation = nextPruned.conversationsById[nextActiveConversationId];
                if (!conversation) return {};
                return {
                  sessionId: conversation.sessionId,
                  messages: conversation.messages,
                  status: 'idle',
                  pendingProposal: conversation.hasPendingProposal ? null : null,
                  proposalUiState: conversation.hasPendingProposal ? 'pending' : null,
                  streamingContent: '',
                };
              })(),
            };
          });
        },

        clearHistory: () => {
          const conversation = syncConversationMetadata(
            makeConversation({ walletAddress: get().activeWalletAddress }),
            get().activeWalletAddress
          );
          set({
            activeConversationId: conversation.id,
            conversationsById: { [conversation.id]: conversation },
            conversationOrder: [conversation.id],
            sessionId: null,
            messages: [makeWelcomeMessage()],
            pendingProposal: null,
            proposalUiState: null,
            status: 'idle',
            streamingContent: '',
          });
        },

        // Session actions
        setSessionId: (sessionId) => {
          set((state) => {
            if (!state.activeConversationId) return {};
            const activeConversation = state.conversationsById[state.activeConversationId];
            if (!activeConversation) return {};
            return {
              sessionId,
              conversationsById: {
                ...state.conversationsById,
                [state.activeConversationId]: {
                  ...activeConversation,
                  sessionId,
                  updatedAt: isoNow(),
                },
              },
            };
          });
        },

        // Message actions
        addUserMessage: (content) => {
          set((state) => {
            const activeConversationId = state.activeConversationId;
            if (!activeConversationId) return {};
            const conversation = state.conversationsById[activeConversationId];
            if (!conversation) return {};
            const now = isoNow();
            const message: UserChatMessage = {
              id: toId('user'),
              role: 'user',
              type: 'text',
              content,
              timestamp: now,
            };
            const nextMessages = [...conversation.messages, message];
            const touchedConversation: PersistedConversation = {
              ...conversation,
              messages: nextMessages,
              title: deriveConversationTitle(nextMessages),
              updatedAt: now,
              lastWalletAddress: state.activeWalletAddress ?? conversation.lastWalletAddress,
              hasPendingProposal: false,
              pendingProposalPreview: conversation.pendingProposalPreview ?? null,
            };

            return {
              messages: nextMessages,
              conversationsById: {
                ...state.conversationsById,
                [activeConversationId]: syncConversationMetadata(
                  touchedConversation,
                  state.activeWalletAddress
                ),
              },
              conversationOrder: pruneConversations(
                state.conversationsById,
                ensureConversationOrder(state.conversationOrder, activeConversationId)
              ).conversationOrder,
              status: 'thinking',
              pendingProposal: null,
              proposalUiState: null,
              streamingContent: '',
            };
          });
        },

        addAgentMessages: (agentMessages) => {
          set((state) => {
            const activeConversationId = state.activeConversationId;
            if (!activeConversationId) return {};
            const conversation = state.conversationsById[activeConversationId];
            if (!conversation) return {};
            const now = isoNow();
            const chatMessages = agentMessages.map((message) => ({
              ...message,
              id: toId('agent'),
              role: 'agent',
            })) as AgentChatMessage[];
            const functionCall = chatMessages.find((message) => message.type === 'function_call');
            const pendingProposal = functionCall
              ? ({
                  ...functionCall,
                  id: functionCall.id,
                  role: 'agent',
                  uiState: 'pending',
                } as PendingProposal)
              : null;

            const nextMessages = [...conversation.messages, ...chatMessages];
              const touchedConversation: PersistedConversation = {
                ...conversation,
                messages: nextMessages,
                title: deriveConversationTitle(nextMessages),
                updatedAt: now,
                sessionStatus: 'active',
                hasPendingProposal: Boolean(functionCall),
                pendingProposalPreview: functionCall
                  ? {
                    toolName: functionCall.function.name,
                    createdAt: functionCall.timestamp,
                  }
                : null,
            };

            return {
              messages: nextMessages,
              conversationsById: {
                ...state.conversationsById,
                [activeConversationId]: syncConversationMetadata(
                  touchedConversation,
                  state.activeWalletAddress
                ),
              },
              conversationOrder: pruneConversations(
                state.conversationsById,
                ensureConversationOrder(state.conversationOrder, activeConversationId)
              ).conversationOrder,
              streamingContent: '',
              status: functionCall ? 'awaiting_approval' : 'idle',
              pendingProposal,
              proposalUiState: functionCall ? 'pending' : null,
            };
          });
        },

        // Streaming actions
        startStreaming: () => {
          set((state) => ({
            streamingContent: '',
            status: state.status === 'awaiting_approval' ? state.status : 'thinking',
          }));
        },

        appendToken: (content) => {
          set((state) => ({
            streamingContent: state.streamingContent + content,
          }));
        },

        finishStreaming: () => {
          set((state) => {
            if (!state.streamingContent.trim()) {
              return {
                streamingContent: '',
                status: state.status === 'awaiting_approval' ? state.status : 'idle',
              };
            }

            const activeConversation = state.activeConversationId
              ? state.conversationsById[state.activeConversationId]
              : null;
            if (!activeConversation) return {};

            const now = isoNow();
            const message: AgentChatMessage = {
              id: toId('agent'),
              role: 'agent',
              type: 'text',
              content: state.streamingContent,
              timestamp: now,
            };
            const nextMessages = [...activeConversation.messages, message];
            const touchedConversation: PersistedConversation = {
              ...activeConversation,
              messages: nextMessages,
              updatedAt: now,
              title: deriveConversationTitle(nextMessages),
            };

            return {
              streamingContent: '',
              messages: nextMessages,
              conversationsById: {
                ...state.conversationsById,
                [activeConversation.id]: syncConversationMetadata(
                  touchedConversation,
                  state.activeWalletAddress
                ),
              },
              status: state.status === 'awaiting_approval' ? state.status : 'idle',
            };
          });
        },

        // Proposal actions
        setPendingProposal: (proposal) => set({ pendingProposal: proposal }),

        setProposalFromSSE: (proposal) => {
          set((state) => {
            const activeConversationId = state.activeConversationId;
            if (!activeConversationId) return {};
            const conversation = state.conversationsById[activeConversationId];
            if (!conversation) return {};

            const now = isoNow();
            const chatMessage: AgentChatMessage = {
              ...proposal,
              id: toId('agent'),
              role: 'agent',
            };
            const pendingProposal = {
              ...chatMessage,
              uiState: 'pending',
            } as PendingProposal;

            const messages: AgentChatMessage[] = [];
            if (state.streamingContent.trim()) {
              messages.push({
                id: toId('agent'),
                role: 'agent',
                type: 'text',
                content: state.streamingContent,
                timestamp: now,
              });
            }
            messages.push(chatMessage);

            const nextMessages = [...conversation.messages, ...messages];
            const touchedConversation: PersistedConversation = {
              ...conversation,
              messages: nextMessages,
              updatedAt: now,
              title: deriveConversationTitle(nextMessages),
              sessionStatus: 'active',
              hasPendingProposal: true,
              pendingProposalPreview: {
                toolName: proposal.function.name,
                createdAt: proposal.timestamp,
              },
            };

            return {
              messages: nextMessages,
              conversationsById: {
                ...state.conversationsById,
                [activeConversationId]: syncConversationMetadata(
                  touchedConversation,
                  state.activeWalletAddress
                ),
              },
              streamingContent: '',
              status: 'awaiting_approval',
              pendingProposal,
              proposalUiState: 'pending',
            };
          });
        },

        setProposalUiState: (proposalUiState) => set({ proposalUiState }),

        setSwapGuardWarning: (swapGuardWarning) => set({ swapGuardWarning }),

        completeProposal: (status, execute) => {
          set((state) => {
            const activeConversationId = state.activeConversationId;
            if (!activeConversationId) return {};
            const conversation = state.conversationsById[activeConversationId];
            if (!conversation) return {};
            const now = isoNow();

            if (execute) {
              const resultMessage: AgentChatMessage = {
                id: toId('agent'),
                role: 'agent',
                type: 'text',
                content: status === 'success'
                  ? `Transacción ejecutada exitosamente.${execute.tx_hash ? ` TX: ${execute.tx_hash.slice(0, 8)}...` : ''}`
                  : `Error en la transacción: ${execute.error || 'Error desconocido'}`,
                execute,
                timestamp: now,
              };
              const nextMessages = [...state.messages, resultMessage];
              const touchedConversation: PersistedConversation = {
                ...conversation,
                messages: nextMessages,
                hasPendingProposal: false,
                pendingProposalPreview: null,
                updatedAt: now,
                title: deriveConversationTitle(nextMessages),
              };
              return {
                messages: nextMessages,
                conversationsById: {
                  ...state.conversationsById,
                  [activeConversationId]: syncConversationMetadata(
                    touchedConversation,
                    state.activeWalletAddress
                  ),
                },
                pendingProposal: null,
                proposalUiState: status === 'success' ? 'confirmed' : 'failed',
                swapGuardWarning: null,
                status: 'idle',
              };
            }

            return {
              conversationsById: {
                ...state.conversationsById,
                [activeConversationId]: syncConversationMetadata(
                  {
                    ...conversation,
                    hasPendingProposal: false,
                    pendingProposalPreview: null,
                    updatedAt: now,
                    title: deriveConversationTitle(conversation.messages),
                  },
                  state.activeWalletAddress
                ),
              },
              pendingProposal: null,
              proposalUiState: status === 'success' ? 'confirmed' : 'failed',
              swapGuardWarning: null,
              status: 'idle',
            };
          });
        },

        setStatus: (status) => set({ status }),
        clearChat: () => {
          const activeWalletAddress = get().activeWalletAddress;
          const conversation = syncConversationMetadata(makeConversation({ walletAddress: activeWalletAddress }), activeWalletAddress);
          set({
            conversationsById: {
              ...get().conversationsById,
              [conversation.id]: conversation,
            },
            conversationOrder: ensureConversationOrder(get().conversationOrder, conversation.id),
            activeConversationId: conversation.id,
            sessionId: null,
            messages: [makeWelcomeMessage()],
            pendingProposal: null,
            proposalUiState: null,
            status: 'idle',
            streamingContent: '',
          });
        },
      };

      return baseState;
    },
    {
      name: CHAT_STORE_NAME,
      version: CHAT_STORE_SCHEMA_VERSION,
      storage: createJSONStorage(getSafeChatStorage),
      migrate: (persistedState) => sanitizeIncomingState(persistedState),
      partialize: (state) => {
        const conversationsById = Object.fromEntries(
          Object.entries(state.conversationsById).map(([id, conversation]) => [
            id,
            syncConversationMetadata(conversation, state.activeWalletAddress),
          ])
        );
        return {
          schemaVersion: CHAT_STORE_SCHEMA_VERSION,
          activeConversationId: state.activeConversationId,
          activeWalletAddress: state.activeWalletAddress,
          sessionId: state.sessionId,
          messages: state.messages,
          conversationsById,
          conversationOrder: state.conversationOrder,
        };
      },
    }
  )
);
