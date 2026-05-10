import type {
  AgentMessage,
  AgentMessageResponse as AgentMessageResponseType,
  ApiError,
  GetHistoryResponse,
  ConditionalOrderSnapshot,
  GetAllocationResponse,
  GetBalancesResponse,
  UsdcSolQuoteQuery,
  UsdcSolQuoteResponse,
  GetNetworkStatusResponse,
  GetPricesResponse,
  GetTransactionsQuery,
  GetTransactionsResponse,
} from '@/types/api';
import {
  AgentMessageResponseSchema,
  FunctionApproveResponseSchema,
  ApiErrorSchema,
  GetAllocationResponseSchema,
  GetBalancesResponseSchema,
  GetNetworkStatusResponseSchema,
  ConditionalOrderSchema,
  ConditionalOrderListResponseSchema,
  ConditionalOrderTriggerResponseSchema,
  GetPricesResponseSchema,
  UsdcSolQuoteResponseSchema,
  GetTransactionsResponseSchema,
  SSEProposalSchema,
  GetHistoryResponseSchema,
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
      type: 'function_result';
      session_id: string;
      tx_signature: string;
      status: 'submitted' | 'confirmed' | 'failed';
      error_message?: string;
    }
  | {
      type: 'function_reject';
      session_id: string;
      reason?: string;
    }
  | {
      type: 'get_history';
      session_id: string;
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
  let currentEvent = '';
  let currentDataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (normalizedLine.startsWith('event: ')) {
          currentEvent = normalizedLine.slice(7).trim();
        } else if (normalizedLine.startsWith('data: ')) {
          currentDataLines.push(normalizedLine.slice(6));
        } else if (normalizedLine === '' && currentEvent && currentDataLines.length > 0) {
          // End of event, process it
          const currentData = currentDataLines.join('\n');
          try {
            const data = JSON.parse(currentData);
            handleSSEEvent(currentEvent, data, callbacks);
          } catch (e) {
            console.warn('[SSE] Failed to parse event data:', currentData, e);
          }
          currentEvent = '';
          currentDataLines = [];
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

export type TransactionPayload = {
  format: 'base64_versioned_transaction' | 'base64_legacy_transaction';
  unsigned_tx_base64: string;
  recent_blockhash?: string;
  last_valid_block_height?: number;
  network?: string;
  execution_type?: string;
};

export type SwapGuard = {
  program_id: string;
  oracle_feed: string;
  quoted_price_usd_e8: number;
  oracle_price_usd_e8?: number;
  deviation_bps?: number;
  warning_deviation_bps: number;
  max_deviation_bps: number;
  staleness_seconds: number;
  max_confidence_bps: number;
  network: 'devnet' | 'mainnet-beta';
};

export type SwapGuardWarning = {
  code: 'price_deviation_warning';
  message: string;
  deviation_bps: number;
};

export type GuardRejection = {
  reason: string;
  deviation_bps: number;
  max_allowed_bps: number;
  oracle_price_usd: number;
  quoted_price_usd: number;
  can_bypass: boolean;
  warning_message: string;
};

export type ApproveResponse = {
  messages: AgentMessage[];
  proposal_state?: {
    state: 'awaiting_signature' | 'guard_rejected_awaiting_bypass' | 'cancelled';
    expires_at?: string;
  };
  transaction?: TransactionPayload;
  swap_execution?: {
    provider: string;
    pair: string;
    input_amount: number;
    slippage_bps: number;
    quote: unknown;
  };
  swap_guard?: SwapGuard;
  swap_guard_warning?: SwapGuardWarning;
  guard_rejection?: GuardRejection;
  risk_accepted?: boolean;
  guard_bypassed?: boolean;
};

export type AgentMessageResponse = {
  messages: AgentMessage[];
  transaction?: TransactionPayload;
  swap_execution?: {
    provider: string;
    pair: string;
    input_amount: number;
    slippage_bps: number;
    quote: unknown;
  };
};

/**
 * Approve a pending proposal (JSON response)
 */
export function postApprove(sessionId: string, acceptRisk?: boolean): Promise<ApproveResponse> {
  return postJson(
    '/api/chat',
    { type: 'function_approve', session_id: sessionId, accept_risk: acceptRisk },
    FunctionApproveResponseSchema
  ) as Promise<ApproveResponse>;
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

export function postFunctionResult(
  sessionId: string,
  txSignature: string,
  status: 'submitted' | 'confirmed' | 'failed',
  errorMessage?: string,
): Promise<AgentMessageResponseType> {
  return postJson(
    '/api/chat',
    {
      type: 'function_result',
      session_id: sessionId,
      tx_signature: txSignature,
      status,
      error_message: errorMessage,
    },
    AgentMessageResponseSchema
  ) as Promise<AgentMessageResponseType>;
}

export function getHistory(sessionId: string): Promise<GetHistoryResponse> {
  return postJson('/api/chat', { type: 'get_history', session_id: sessionId }, GetHistoryResponseSchema) as Promise<GetHistoryResponse>;
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
  const params = new URLSearchParams({ address: query.address.trim() });
  const before = query.before?.trim();
  if (query.limit) {
    const normalizedLimit = Math.min(Math.max(1, Math.floor(query.limit)), 50);
    params.set('limit', String(normalizedLimit));
  }
  if (before) {
    params.set('before', before);
  }
  return getJson(`/api/wallet/transactions?${params.toString()}`, GetTransactionsResponseSchema) as Promise<GetTransactionsResponse>;
}

export function getNetworkStatus(): Promise<GetNetworkStatusResponse> {
  return getJson('/api/network/status', GetNetworkStatusResponseSchema) as Promise<GetNetworkStatusResponse>;
}

export function getPrices(symbols: string[]): Promise<GetPricesResponse> {
  return getJson(`/api/prices?symbols=${encodeURIComponent(symbols.join(','))}`, GetPricesResponseSchema) as Promise<GetPricesResponse>;
}

export function getUsdcSolQuote(params: UsdcSolQuoteQuery): Promise<UsdcSolQuoteResponse> {
  const url = `/api/quotes/usdc-sol?` + new URLSearchParams({
    input_token: params.input_token,
    output_token: params.output_token,
    input_amount: String(params.input_amount),
    ...(params.slippage_bps === undefined ? {} : { slippage_bps: String(params.slippage_bps) }),
    ...(params.network ? { network: params.network } : {}),
  }).toString();

  return getJson(url, UsdcSolQuoteResponseSchema) as Promise<UsdcSolQuoteResponse>;
}

export function getConditionalOrders(userAddress: string): Promise<ConditionalOrderSnapshot[]> {
  return getJson(`/api/conditional-orders?user=${encodeURIComponent(userAddress)}`, ConditionalOrderListResponseSchema) as Promise<
    ConditionalOrderSnapshot[]
  >;
}

export function getConditionalOrder(orderPda: string): Promise<ConditionalOrderSnapshot> {
  return getJson(`/api/conditional-orders/${encodeURIComponent(orderPda)}`, ConditionalOrderSchema) as Promise<ConditionalOrderSnapshot>;
}

export function triggerConditionalOrder(orderPda: string): Promise<{
  status: 'triggered';
  orderPda: string;
  tx_signature: string;
}> {
  return postJson(
    `/api/conditional-orders/${encodeURIComponent(orderPda)}`,
    { trigger_now: true },
    ConditionalOrderTriggerResponseSchema,
  ) as Promise<{
    status: 'triggered';
    orderPda: string;
    tx_signature: string;
  }>;
}
