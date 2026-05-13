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

export type GuardrailActionType = 'transfer' | 'swap' | 'conditional_order' | 'token_risk' | 'wallet_policy' | string;
export type GuardrailDecision = 'ALLOW' | 'WARN' | 'REJECT';
export type GuardrailSeverity = 'info' | 'warning' | 'critical';
export type ExplanationCategory =
  | 'destination_trust'
  | 'token_or_protocol_safety'
  | 'price_or_execution_risk'
  | 'permission_scope'
  | 'user_policy'
  | 'network_or_provider_state'
  | 'onchain_enforcement';
export type ExplanationSource = 'local' | 'policy' | 'onchain' | 'offchain' | 'oracle' | 'onchain_approval' | 'simulation';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'error' | 'not_run';
export type SuggestedUserAction =
  | 'continue'
  | 'cancel'
  | 'review_destination'
  | 'reduce_amount'
  | 'send_test_amount'
  | 'review_price'
  | 'adjust_slippage'
  | 'wait_and_retry'
  | 'request_review';

export type GuardrailNarration = {
  summary: string;
  bullets?: string[];
  based_on: {
    explanation_id: string;
    reason_codes: string[];
    checks: string[];
    sources: string[];
  };
};

export type GuardrailExplanation = {
  id: string;
  action_type: GuardrailActionType;
  decision: GuardrailDecision;
  severity: GuardrailSeverity;
  category: ExplanationCategory;
  summary: string;
  impact?: string;
  reason_codes: string[];
  reasons: Array<{
    code: string;
    message: string;
    category: ExplanationCategory;
    source: ExplanationSource;
    severity: GuardrailSeverity;
  }>;
  checks: Array<{
    check: string;
    label: string;
    status: CheckStatus;
    source: ExplanationSource;
    evidence?: Record<string, unknown>;
  }>;
  sources: Array<{
    provider: string;
    status: 'ok' | 'missing' | 'stale' | 'error';
    checked_at?: string;
  }>;
  suggested_user_action?: SuggestedUserAction;
  technical_details?: Record<string, unknown>;
  narration?: GuardrailNarration;
  created_at: string;
};

export type RiskInfo = {
  score: number;
  level: 'low' | 'medium' | 'critical';
  reasons?: string[];
  requiresExtraConfirmation?: boolean;
  walletSafety?: {
    decision: 'ALLOW' | 'WARN' | 'REJECT';
    riskLevel: 'low' | 'medium' | 'critical';
    hardReject: boolean;
    requiresExtraConfirmation: boolean;
    reasons: {
      code: string;
      severity: 'info' | 'warning' | 'critical';
      message: string;
      source: 'local' | 'onchain' | 'offchain' | 'policy' | 'onchain_approval';
    }[];
    sources?: {
      provider: string;
      status: 'ok' | 'missing' | 'stale' | 'error';
    }[];
  };
  explanation?: GuardrailExplanation;
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

export type OnchainGuardrail = {
  action_type: string;
  action_hash: string;
  policy_pda: string;
  action_approval_pda: string;
  wallet_safety_attestation_pda: string;
  action_expires_at: string;
  action_created_at: string;
  action_amount_lamports: number;
  action_recipient: string;
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
        estimated_output_amount?: number;
        quote_source?: 'orca_whirlpool_quote' | 'fallback_sol_usd';
      };
      risk: RiskInfo;
      execution?: FunctionExecution;
      onchain_guardrail?: OnchainGuardrail;
      timestamp: string;
    }
  | {
      type: 'alert';
      severity: 'info' | 'warning' | 'danger';
      content: string;
      timestamp: string;
    };

export type SessionHistoryTextMessage = {
  id?: string;
  role: 'user' | 'agent' | 'system';
  type: 'text';
  content: string;
  execute?: ExecuteInfo;
  timestamp: string;
};

export type SessionHistoryFunctionCallMessage = {
  id?: string;
  role: 'agent';
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
    estimated_output_amount?: number;
    quote_source?: 'orca_whirlpool_quote' | 'fallback_sol_usd';
  };
  risk: RiskInfo;
  execution?: FunctionExecution;
  timestamp: string;
};

export type SessionHistoryAlertMessage = {
  id?: string;
  role: 'agent';
  type: 'alert';
  severity: 'info' | 'warning' | 'danger';
  content: string;
  timestamp: string;
};

export type SessionHistoryMessage =
  | SessionHistoryTextMessage
  | SessionHistoryFunctionCallMessage
  | SessionHistoryAlertMessage;

export type AgentMessageRequest =
  | { type: 'user_message'; content: string; session_id?: string; user_address?: string; user_threshold_usd?: number }
  | { type: 'function_approve'; session_id: string; user_address?: string }
  | { type: 'function_result'; session_id: string; tx_signature: string; status: 'submitted' | 'confirmed' | 'failed'; error_message?: string; user_address?: string }
  | { type: 'function_reject'; session_id: string; reason?: string; user_address?: string };

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
  on_chain_enforcement?: boolean;
  action_approval_pda?: string;
};

export type SwapGuardWarning = {
  code: 'price_deviation_warning';
  message: string;
  deviation_bps: number;
  explanation?: GuardrailExplanation;
};

export type GuardRejection = {
  reason: string;
  deviation_bps: number;
  max_allowed_bps: number;
  oracle_price_usd: number;
  quoted_price_usd: number;
  can_bypass: boolean;
  warning_message: string;
  explanation?: GuardrailExplanation;
};

export type AgentMessageResponse = {
  messages: AgentMessage[];
  proposal_state?: {
    state: 'awaiting_signature' | 'guard_rejected_awaiting_bypass' | 'cancelled';
    expires_at?: string;
  };
  transaction?: {
    format: 'base64_versioned_transaction' | 'base64_legacy_transaction';
    unsigned_tx_base64: string;
    recent_blockhash?: string;
    last_valid_block_height?: number;
    network?: 'devnet' | 'mainnet-beta';
    execution_type?: string;
    onchain_guardrail?: OnchainGuardrail;
  };
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

export type GetHistoryResponse = {
  session_id: string;
  user_address: string | null;
  updated_at: string;
  messages: SessionHistoryMessage[];
  pending_proposal: SessionHistoryFunctionCallMessage | null;
};

export type GetBalancesQuery = {
  address: string;
};

export type GetBalancesResponse = {
  balances: TokenBalance[];
  total_usd: number;
  network?: 'devnet' | 'mainnet-beta';
  change_24h_pct?: number;
  updated_at: string;
  partial?: boolean;
  warnings?: Array<{
    code: 'spl_holdings_unavailable';
    message: string;
  }>;
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

export type UsdcSolQuoteQuery = {
  network?: 'devnet';
  input_token: 'USDC' | 'SOL';
  output_token: 'USDC' | 'SOL';
  input_amount: number;
  slippage_bps?: number;
};

export type UsdcSolQuoteResponse = {
  network: 'devnet';
  provider: 'orca_whirlpools_devnet';
  input_token: 'USDC' | 'SOL';
  output_token: 'USDC' | 'SOL';
  input_amount: number;
  output_amount: number;
  input_mint: string;
  output_mint: string;
  slippage_bps: number;
  route_context?: string;
  quote_source: 'orca_whirlpool_quote' | 'fallback_sol_usd';
  updated_at: string;
};
