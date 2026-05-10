import type {
  AgentMessage,
  ApiError,
  GetAllocationResponse,
  GetBalancesResponse,
  GetNetworkStatusResponse,
  GetPricesResponse,
  GetTransactionsQuery,
  GetTransactionsResponse,
} from '@/types/api';
import {
  AgentMessageResponseSchema,
  ApiErrorSchema,
  GetAllocationResponseSchema,
  GetBalancesResponseSchema,
  GetNetworkStatusResponseSchema,
  GetPricesResponseSchema,
  GetTransactionsResponseSchema,
  SSEProposalSchema,
} from './schemas';

// ============================================================================
// Error Handling
// ============================================================================

export class ApiClientError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly status: number;

  constructor(error: ApiError['error'], status: number) {
    super(error.message);
    this.name = 'ApiClientError';
    this.code = error.code;
    this.details = error.details;
    this.status = status;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiClientError(
      { code: 'invalid_json', message: 'The server returned invalid JSON.' },
      response.status,
    );
  }
}

function throwIfApiError(data: unknown, status: number): void {
  const parsed = ApiErrorSchema.safeParse(data);
  if (parsed.success) {
    throw new ApiClientError(parsed.data.error as ApiError['error'], status);
  }
}

async function getJson<T>(url: string, schema: { parse: (value: unknown) => T }): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await parseJson(response);
  throwIfApiError(data, response.status);
  if (!response.ok) {
    throw new ApiClientError(
      { code: 'http_error', message: `Request failed with status ${response.status}` },
      response.status,
    );
  }
  return schema.parse(data);
}

async function postJson<T>(url: string, body: unknown, schema: { parse: (value: unknown) => T }): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await parseJson(response);
  throwIfApiError(data, response.status);
  if (!response.ok) {
    throw new ApiClientError(
      { code: 'http_error', message: `Request failed with status ${response.status}` },
      response.status,
    );
  }
  return schema.parse(data);
}

// ============================================================================
// SSE Chat Types
// ============================================================================

export type ChatRequest =
  | {
      type: 'user_message';
      content: string;
      session_id?: string;
      user_address?: string;
      user_threshold_usd?: number;
    }
  | {
      type: 'function_approve';
      session_id: string;
    }
  | {
      type: 'function_reject';
      session_id: string;
      reason?: string;
    };

export type SSEEvent =
  | { event: 'session'; data: { session_id: string } }
  | { event: 'token'; data: { content: string } }
  | { event: 'proposal'; data: Extract<AgentMessage, { type: 'function_call' }> }
  | { event: 'done'; data: { session_id: string; awaiting_approval?: boolean } }
  | { event: 'error'; data: { code: string; message: string } };

export type ChatStreamCallbacks = {
  onSession?: (sessionId: string) => void;
  onToken?: (content: string) => void;
  onProposal?: (proposal: Extract<AgentMessage, { type: 'function_call' }>) => void;
  onDone?: (data: { session_id: string; awaiting_approval?: boolean }) => void;
  onError?: (error: { code: string; message: string }) => void;
};

// ============================================================================
// SSE Chat Client
// ============================================================================

/**
 * Stream chat messages via SSE.
 * Used for user_message requests that expect streaming LLM responses.
 */
export async function streamChat(
  request: Extract<ChatRequest, { type: 'user_message' }>,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const data = await parseJson(response);
    throwIfApiError(data, response.status);
    throw new ApiClientError(
      { code: 'http_error', message: `Request failed with status ${response.status}` },
      response.status,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new ApiClientError({ code: 'no_body', message: 'No response body' }, 500);
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      let currentData = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData = line.slice(6);
        } else if (line === '' && currentEvent && currentData) {
          // End of event, process it
          try {
            const data = JSON.parse(currentData);
            handleSSEEvent(currentEvent, data, callbacks);
          } catch (e) {
            console.warn('[SSE] Failed to parse event data:', currentData, e);
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function handleSSEEvent(event: string, data: unknown, callbacks: ChatStreamCallbacks) {
  switch (event) {
    case 'session':
      if (callbacks.onSession && typeof data === 'object' && data && 'session_id' in data) {
        callbacks.onSession((data as { session_id: string }).session_id);
      }
      break;
    case 'token':
      if (callbacks.onToken && typeof data === 'object' && data && 'content' in data) {
        callbacks.onToken((data as { content: string }).content);
      }
      break;
    case 'proposal':
      if (callbacks.onProposal) {
        const parsed = SSEProposalSchema.safeParse(data);
        if (parsed.success) {
          callbacks.onProposal(parsed.data as Extract<AgentMessage, { type: 'function_call' }>);
        } else {
          console.warn('[SSE] Invalid proposal data:', data);
        }
      }
      break;
    case 'done':
      if (callbacks.onDone && typeof data === 'object' && data) {
        callbacks.onDone(data as { session_id: string; awaiting_approval?: boolean });
      }
      break;
    case 'error':
      if (callbacks.onError && typeof data === 'object' && data) {
        callbacks.onError(data as { code: string; message: string });
      }
      break;
  }
}

// ============================================================================
// JSON Chat Client (for approve/reject)
// ============================================================================

export type AgentMessageResponse = {
  messages: AgentMessage[];
};

/**
 * Approve a pending proposal (JSON response)
 */
export function postApprove(sessionId: string, executeTxSignature?: string): Promise<AgentMessageResponse> {
  return postJson(
    '/api/chat',
    { type: 'function_approve', session_id: sessionId, execute_tx_signature: executeTxSignature },
    AgentMessageResponseSchema
  ) as Promise<AgentMessageResponse>;
}

/**
 * Reject a pending proposal (JSON response)
 */
export function postReject(sessionId: string, reason?: string): Promise<AgentMessageResponse> {
  return postJson(
    '/api/chat',
    { type: 'function_reject', session_id: sessionId, reason },
    AgentMessageResponseSchema
  ) as Promise<AgentMessageResponse>;
}

// ============================================================================
// Other API Clients (unchanged)
// ============================================================================

export function getBalances(address: string): Promise<GetBalancesResponse> {
  return getJson(`/api/wallet/balances?address=${encodeURIComponent(address)}`, GetBalancesResponseSchema) as Promise<GetBalancesResponse>;
}

export function getAllocation(address: string): Promise<GetAllocationResponse> {
  return getJson(`/api/wallet/allocation?address=${encodeURIComponent(address)}`, GetAllocationResponseSchema) as Promise<GetAllocationResponse>;
}

export function getTransactions(query: GetTransactionsQuery): Promise<GetTransactionsResponse> {
  const params = new URLSearchParams({ address: query.address });
  if (query.limit) params.set('limit', String(query.limit));
  if (query.before) params.set('before', query.before);
  return getJson(`/api/wallet/transactions?${params.toString()}`, GetTransactionsResponseSchema) as Promise<GetTransactionsResponse>;
}

export function getNetworkStatus(): Promise<GetNetworkStatusResponse> {
  return getJson('/api/network/status', GetNetworkStatusResponseSchema) as Promise<GetNetworkStatusResponse>;
}

export function getPrices(symbols: string[]): Promise<GetPricesResponse> {
  return getJson(`/api/prices?symbols=${encodeURIComponent(symbols.join(','))}`, GetPricesResponseSchema) as Promise<GetPricesResponse>;
}
