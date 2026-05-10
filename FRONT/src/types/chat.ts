import type { AgentMessage, ExecuteInfo, RiskInfo } from './api';

export type UserChatMessage = {
  id: string;
  role: 'user';
  type: 'text';
  content: string;
  timestamp: string;
};

export type AgentChatMessage = AgentMessage & {
  id: string;
  role: 'agent';
};

export type ChatMessage = UserChatMessage | AgentChatMessage;

export type ConversationSessionStatus = 'unknown' | 'active' | 'expired';

export type ConversationWalletStatus = 'unknown' | 'match' | 'mismatch';

export type ConversationActionBlockReason = 'wallet_mismatch' | 'session_expired' | 'proposal_stale';

export type PendingProposalPreview = {
  toolName?: string;
  createdAt?: string;
};

export type PersistedConversation = {
  id: string;
  sessionId: string | null;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  walletAddressAtCreation: string | null;
  lastWalletAddress: string | null;
  hasPendingProposal: boolean;
  pendingProposalPreview: PendingProposalPreview | null;
  sessionStatus: ConversationSessionStatus;
  walletStatus: ConversationWalletStatus;
};

export type ProposalUiState =
  | 'pending'
  | 'preparing_transaction'
  | 'awaiting_signature'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

export type ChatStatus = 'idle' | 'thinking' | 'awaiting_approval' | 'executing';

export type PendingProposal = Extract<AgentChatMessage, { type: 'function_call' }> & {
  uiState: ProposalUiState;
  execute?: ExecuteInfo;
};

export type RiskPresentation = RiskInfo;
