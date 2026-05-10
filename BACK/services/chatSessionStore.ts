/**
 * In-memory session store for chat state.
 * Maps sessionId to thread state for HITL resume support.
 * TODO: Replace with Redis/Postgres for production.
 */

import { BaseMessage } from '@langchain/core/messages';

export type PendingProposal = {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult: Record<string, unknown>;
  createdAt: number;
};

export type SessionState = {
  sessionId: string;
  threadId: string;
  userAddress: string | null;
  messages: BaseMessage[];
  pendingProposal: PendingProposal | null;
  createdAt: number;
  updatedAt: number;
};

const store = new Map<string, SessionState>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function getSession(sessionId: string): SessionState | null {
  const session = store.get(sessionId);
  if (!session) return null;

  // Check TTL
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    store.delete(sessionId);
    return null;
  }

  return session;
}

export function createSession(sessionId: string, threadId: string, userAddress?: string): SessionState {
  const now = Date.now();
  const session: SessionState = {
    sessionId,
    threadId,
    userAddress: userAddress || null,
    messages: [],
    pendingProposal: null,
    createdAt: now,
    updatedAt: now,
  };
  store.set(sessionId, session);
  return session;
}

export function updateSession(
  sessionId: string,
  updates: Partial<Pick<SessionState, 'messages' | 'pendingProposal' | 'threadId' | 'userAddress'>>
): SessionState | null {
  const session = getSession(sessionId);
  if (!session) return null;

  Object.assign(session, updates, { updatedAt: Date.now() });
  store.set(sessionId, session);
  return session;
}

export function clearPendingProposal(sessionId: string): boolean {
  const session = getSession(sessionId);
  if (!session) return false;

  session.pendingProposal = null;
  session.updatedAt = Date.now();
  store.set(sessionId, session);
  return true;
}

export function deleteSession(sessionId: string): boolean {
  return store.delete(sessionId);
}

// Cleanup expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of store.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      store.delete(id);
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
