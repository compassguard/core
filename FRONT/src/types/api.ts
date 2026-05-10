export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type ApiResult<T> = T | ApiError;

export function isApiError<T>(result: ApiResult<T>): result is ApiError {
  return typeof result === 'object' && result !== null && 'error' in result;
}

export type RiskInfo = {
  score: number;
  level: 'low' | 'medium' | 'critical';
  reasons?: string[];
};

export type ExecuteInfo = {
  status: 'success' | 'failed';
  tx_hash?: string;
  error?: string;
};

export type SwapParams = {
  amount_in: number;
  token_in: string;
  token_out: string;
  slippage_bps?: number;
};

export type TransferParams = {
  amount: number;
  token: string;
  recipient: string;
  memo?: string;
};

export type StakeParams = {
  amount: number;
  validator: string;
};

export type AgentMessage =
  | {
      type: 'text';
      content: string;
      execute?: ExecuteInfo;
      timestamp: string;
    }
  | {
      type: 'function_call';
      function: {
        name: 'swap' | 'transfer' | 'stake';
        params: SwapParams | TransferParams | StakeParams;
      };
      display: {
        summary: string;
        fee_usd?: number;
        provider?: string;
        slippage_bps?: number;
      };
      risk: RiskInfo;
      timestamp: string;
    }
  | {
      type: 'alert';
      severity: 'info' | 'warning' | 'danger';
      content: string;
      timestamp: string;
    };

export type AgentMessageRequest =
  | { type: 'user_message'; content: string; session_id?: string; user_address?: string; user_threshold_usd?: number }
  | { type: 'function_approve'; session_id: string; execute_tx_signature?: string }
  | { type: 'function_reject'; session_id: string; reason?: string };

export type AgentMessageResponse = {
  messages: AgentMessage[];
};

export type GetBalancesQuery = {
  address: string;
};

export type GetBalancesResponse = {
  balances: TokenBalance[];
  total_usd: number;
  change_24h_pct: number;
  updated_at: string;
};

export type TokenBalance = {
  symbol: string;
  mint: string;
  amount: string;
  decimals: number;
  ui_amount: number;
  usd_value: number;
  icon_url?: string;
};

export type GetAllocationResponse = {
  total_assets: number;
  allocation: AllocationItem[];
};

export type AllocationItem = {
  symbol: string;
  percentage: number;
  color?: string;
};

export type GetTransactionsQuery = {
  address: string;
  limit?: number;
  before?: string;
};

export type GetTransactionsResponse = {
  transactions: TxHistoryItem[];
  next_cursor?: string;
};

export type TxHistoryItem = {
  tx_hash: string;
  type: 'swap' | 'transfer' | 'stake' | 'other';
  status: 'success' | 'failed';
  timestamp: string;
  summary: string;
  amount_usd?: number;
  explorer_url: string;
};

export type GetNetworkStatusResponse = {
  connected: boolean;
  network: 'mainnet';
  latency_ms: number;
  tps?: number;
};

export type GetPricesQuery = {
  symbols: string;
};

export type GetPricesResponse = {
  prices: Record<string, number>;
  updated_at: string;
};
