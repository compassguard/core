import { create } from 'zustand';
import type { AgentMessage, ExecuteInfo } from '@/types/api';
import type { AgentChatMessage, ChatMessage, ChatStatus, PendingProposal, ProposalUiState, UserChatMessage } from '@/types/chat';

function id(prefix = 'msg') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toAgentChatMessage(message: AgentMessage): AgentChatMessage {
  return { ...message, id: id('agent'), role: 'agent' } as AgentChatMessage;
}

interface ChatStore {
  // State
  sessionId: string | null;
  messages: ChatMessage[];
  pendingProposal: PendingProposal | null;
  proposalUiState: ProposalUiState | null;
  status: ChatStatus;
  streamingContent: string;

  // Computed
  isInputBlocked: () => boolean;

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
  completeProposal: (status: ExecuteInfo['status'], execute?: ExecuteInfo) => void;

  // Status actions
  setStatus: (status: ChatStatus) => void;
  clearChat: () => void;
}

const welcomeMessage: AgentChatMessage = {
  id: 'welcome',
  role: 'agent',
  type: 'text',
  content: 'Hola, soy tu Wallet Copilot. Dime qué quieres hacer en Solana y te ayudaré a hacerlo de forma segura.',
  timestamp: new Date().toISOString(),
};

export const useChatStore = create<ChatStore>((set, get) => ({
  // Initial state
  sessionId: null,
  messages: [welcomeMessage],
  pendingProposal: null,
  proposalUiState: null,
  status: 'idle',
  streamingContent: '',

  // Computed
  isInputBlocked: () => {
    const state = get();
    return state.status !== 'idle' || state.pendingProposal !== null;
  },

  // Session actions
  setSessionId: (sessionId) => set({ sessionId }),

  // Message actions
  addUserMessage: (content) => {
    const message: UserChatMessage = {
      id: id('user'),
      role: 'user',
      type: 'text',
      content,
      timestamp: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, message] }));
  },

  addAgentMessages: (agentMessages) => {
    const chatMessages = agentMessages.map(toAgentChatMessage);
    const functionCall = chatMessages.find((message) => message.type === 'function_call') as PendingProposal | undefined;

    set((state) => ({
      messages: [...state.messages, ...chatMessages],
      pendingProposal: functionCall ? { ...functionCall, uiState: 'pending' } : state.pendingProposal,
      proposalUiState: functionCall ? 'pending' : state.proposalUiState,
      status: functionCall ? 'awaiting_approval' : 'idle',
    }));
  },

  // Streaming actions
  startStreaming: () => set({ streamingContent: '', status: 'thinking' }),

  appendToken: (content) => set((state) => ({ 
    streamingContent: state.streamingContent + content 
  })),

  finishStreaming: () => {
    const { streamingContent } = get();
    if (streamingContent.trim()) {
      const message: AgentChatMessage = {
        id: id('agent'),
        role: 'agent',
        type: 'text',
        content: streamingContent,
        timestamp: new Date().toISOString(),
      };
      set((state) => ({
        messages: [...state.messages, message],
        streamingContent: '',
        status: 'idle',
      }));
    } else {
      set({ streamingContent: '', status: 'idle' });
    }
  },

  // Proposal actions
  setPendingProposal: (proposal) => set({ pendingProposal: proposal }),

  setProposalFromSSE: (proposal) => {
    const chatMessage: AgentChatMessage = {
      ...proposal,
      id: id('agent'),
      role: 'agent',
    };
    const pendingProposal: PendingProposal = {
      ...chatMessage,
      uiState: 'pending',
    };
    
    // Also add any streaming content as a message before the proposal
    const { streamingContent } = get();
    const messages: AgentChatMessage[] = [];
    
    if (streamingContent.trim()) {
      messages.push({
        id: id('agent'),
        role: 'agent',
        type: 'text',
        content: streamingContent,
        timestamp: new Date().toISOString(),
      });
    }
    messages.push(chatMessage);

    set((state) => ({
      messages: [...state.messages, ...messages],
      streamingContent: '',
      pendingProposal,
      proposalUiState: 'pending',
      status: 'awaiting_approval',
    }));
  },

  setProposalUiState: (proposalUiState) => set({ proposalUiState }),

  completeProposal: (status, execute) => {
    // Add result message if there's execute info
    if (execute) {
      const resultMessage: AgentChatMessage = {
        id: id('agent'),
        role: 'agent',
        type: 'text',
        content: status === 'success' 
          ? `Transferencia ejecutada exitosamente.${execute.tx_hash ? ` TX: ${execute.tx_hash.slice(0, 8)}...` : ''}`
          : `Error en la transferencia: ${execute.error || 'Error desconocido'}`,
        execute,
        timestamp: new Date().toISOString(),
      };
      set((state) => ({
        messages: [...state.messages, resultMessage],
        pendingProposal: null,
        proposalUiState: status === 'success' ? 'confirmed' : 'failed',
        status: 'idle',
      }));
    } else {
      set({
        pendingProposal: null,
        proposalUiState: status === 'success' ? 'confirmed' : 'failed',
        status: 'idle',
      });
    }
  },

  // Status actions
  setStatus: (status) => set({ status }),

  clearChat: () => set({
    sessionId: null,
    messages: [welcomeMessage],
    pendingProposal: null,
    proposalUiState: null,
    status: 'idle',
    streamingContent: '',
  }),
}));
