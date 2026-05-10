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
  status: 'submitted' | 'confirmed' | 'failed' | 'success';
  tx_hash?: string;
  error?: string;
};

export type SwapParams = {
  amount_in: number;
  token_in: string;
  token_out: string;
  slippage_bps?: number;
};

export type OrcaSwapParams = {
  input_token: 'USDC' | 'SOL';
  output_token: 'USDC' | 'SOL';
  input_amount: number;
  slippage_bps?: number;
};

export type TransferParams = {
  amount: number;
  token: string;
  recipient: string;
  memo?: string;
};

export type ConditionalBuySolParams = {
  input_token: 'USDC';
  input_amount: number;
  target_price_usd: number;
  min_sol_out?: number;
  desired_sol_amount?: number;
  desired_sol_lamports?: number;
  max_usdc_in?: number;
  max_oracle_age_seconds?: number;
  max_confidence_bps?: number;
  recipient?: string;
  expires_at?: string;
  oracle_feed_pubkey?: string;
  client_order_id?: number;
  order_pda?: string;
  execution_mode?: 'create_order_and_deposit';
};

export type ConditionalOrderSnapshot = {
  orderPda: string;
  user: string;
  recipient: string;
  clientOrderId: number;
  usdcTestMint: string;
  escrowTokenAccount: string;
  treasuryUsdcAta: string;
  solVaultPda: string;
  oracleFeed: string;
  desiredSolLamports: number;
  maxUsdcIn: number;
  targetPriceUsdE8: number;
  maxOracleAgeSeconds: number;
  maxConfidenceBps: number;
  escrowedUsdcAmount: number;
  executedUsdcAmount: number;
  executedSolLamports: number;
  status: 'open' | 'executed' | 'cancelled' | 'expired' | 'reclaimed' | 'unknown';
  observedExecutable: boolean;
  observedExecutableReason?: string;
  indexedAt: number;
  createdAt: number;
  expiresAt: number;
};

export type FunctionExecution = {
  mode: 'phantom_sign_and_send' | 'phantom_execute_then_optional_backend_proof';
  network: 'devnet' | 'mainnet-beta';
  expires_at: string;
  expected_user_address?: string;
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
        name: 'swap' | 'transfer' | 'stake' | 'conditional_buy_sol' | 'swap_orca_usdc_to_sol';
        params: SwapParams | TransferParams | StakeParams | ConditionalBuySolParams | OrcaSwapParams;
      };
      display: {
        summary: string;
        fee_usd?: number;
        provider?: string;
        slippage_bps?: number;
      };
      risk: RiskInfo;
      execution?: FunctionExecution;
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
  | { type: 'function_approve'; session_id: string }
  | { type: 'function_result'; session_id: string; tx_signature: string; status: 'submitted' | 'confirmed' | 'failed'; error_message?: string }
  | { type: 'function_reject'; session_id: string; reason?: string };

export type AgentMessageResponse = {
  messages: AgentMessage[];
  proposal_state?: {
    state: 'awaiting_signature';
    expires_at: string;
  };
  transaction?: {
    format: 'base64_versioned_transaction';
    unsigned_tx_base64: string;
    recent_blockhash: string;
    last_valid_block_height: number;
    network: 'devnet' | 'mainnet-beta';
  };
};

export type GetBalancesQuery = {
  address: string;
};

export type GetBalancesResponse = {
  balances: TokenBalance[];
  total_usd: number;
  change_24h_pct?: number;
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
  amount?: number;
  amount_symbol?: string;
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
