import { z } from 'zod';

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

const WalletSafetyReasonSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  source: z.enum(['local', 'onchain', 'offchain', 'policy', 'onchain_approval']),
});

const WalletSafetyResultSchema = z.object({
  decision: z.enum(['ALLOW', 'WARN', 'REJECT']),
  riskLevel: z.enum(['low', 'medium', 'critical']),
  hardReject: z.boolean(),
  requiresExtraConfirmation: z.boolean(),
  reasons: z.array(WalletSafetyReasonSchema),
  sources: z
    .array(
      z.object({
        provider: z.string(),
        status: z.enum(['ok', 'missing', 'stale', 'error']),
      }),
    )
    .optional(),
});

export const RiskInfoSchema = z.object({
  score: z.number().min(0).max(100),
  level: z.enum(['low', 'medium', 'critical']),
  reasons: z.array(z.string()).optional(),
  requiresExtraConfirmation: z.boolean().optional(),
  walletSafety: WalletSafetyResultSchema.optional(),
});

export const ExecuteSchema = z.object({
  status: z.enum(['submitted', 'confirmed', 'failed', 'success']),
  tx_hash: z.string().optional(),
  error: z.string().optional(),
});

const OnchainGuardrailSchema = z.object({
  action_type: z.string(),
  action_hash: z.string(),
  policy_pda: z.string(),
  action_approval_pda: z.string(),
  wallet_safety_attestation_pda: z.string(),
  action_expires_at: z.string(),
  action_created_at: z.string(),
  action_amount_lamports: z.number().int().nonnegative(),
  action_recipient: z.string(),
});

export const SwapParamsSchema = z.object({
  amount_in: z.number().positive(),
  token_in: z.string(),
  token_out: z.string(),
  slippage_bps: z.number().optional(),
});

export const TransferParamsSchema = z.object({
  amount: z.number().positive(),
  token: z.string(),
  recipient: z.string(),
  memo: z.string().optional(),
});

export const StakeParamsSchema = z.object({
  amount: z.number().positive(),
  validator: z.string(),
});

export const OrcaSwapParamsSchema = z.object({
  input_token: z.enum(['USDC', 'SOL']),
  output_token: z.enum(['USDC', 'SOL']),
  input_amount: z.number().positive(),
  slippage_bps: z.number().optional(),
});

export const ConditionalBuySolParamsSchema = z.object({
  input_token: z.literal('USDC'),
  input_amount: z.number().positive(),
  target_price_usd: z.number().positive(),
  min_sol_out: z.number().positive().optional(),
  desired_sol_amount: z.number().positive().optional(),
  desired_sol_lamports: z.number().int().positive().optional(),
  max_usdc_in: z.number().positive().optional(),
  max_oracle_age_seconds: z.number().positive().optional(),
  max_confidence_bps: z.number().positive().optional(),
  recipient: z.string().optional(),
  expires_at: z.string().optional(),
  oracle_feed_pubkey: z.string().optional(),
  client_order_id: z.number().optional(),
  order_pda: z.string().optional(),
  execution_mode: z.literal('create_order_and_deposit').optional(),
});

export const FunctionExecutionSchema = z.object({
  mode: z.enum(['phantom_sign_and_send', 'phantom_execute_then_optional_backend_proof']),
  network: z.enum(['devnet', 'mainnet-beta']),
  expires_at: z.string(),
  expected_user_address: z.string().optional(),
});

export const AgentMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    content: z.string(),
    execute: ExecuteSchema.optional(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal('function_call'),
    function: z.object({
      name: z.enum(['swap', 'transfer', 'stake', 'conditional_buy_sol', 'swap_orca_usdc_to_sol']),
      params: z.union([
        SwapParamsSchema,
        TransferParamsSchema,
        StakeParamsSchema,
        ConditionalBuySolParamsSchema,
        OrcaSwapParamsSchema,
      ]),
    }),
    display: z.object({
      summary: z.string(),
      fee_usd: z.number().optional(),
      provider: z.string().optional(),
      slippage_bps: z.number().optional(),
    }),
    risk: RiskInfoSchema,
    execution: FunctionExecutionSchema.optional(),
    onchain_guardrail: OnchainGuardrailSchema.optional(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal('alert'),
    severity: z.enum(['info', 'warning', 'danger']),
    content: z.string(),
    timestamp: z.string(),
  }),
]);

export const SessionHistoryTextMessageSchema = z.object({
  role: z.enum(['user', 'agent', 'system']),
  type: z.literal('text'),
  content: z.string(),
  execute: ExecuteSchema.optional(),
  timestamp: z.string(),
});

export const SessionHistoryFunctionCallMessageSchema = z.object({
  role: z.literal('agent'),
  type: z.literal('function_call'),
  function: z.object({
    name: z.enum(['swap', 'transfer', 'stake', 'conditional_buy_sol', 'swap_orca_usdc_to_sol']),
    params: z.union([
      SwapParamsSchema,
      TransferParamsSchema,
      StakeParamsSchema,
      ConditionalBuySolParamsSchema,
      OrcaSwapParamsSchema,
    ]),
  }),
  display: z.object({
    summary: z.string(),
    fee_usd: z.number().optional(),
    provider: z.string().optional(),
    slippage_bps: z.number().optional(),
  }),
  risk: RiskInfoSchema,
  execution: FunctionExecutionSchema.optional(),
  timestamp: z.string(),
});

export const SessionHistoryAlertMessageSchema = z.object({
  role: z.literal('agent'),
  type: z.literal('alert'),
  severity: z.enum(['info', 'warning', 'danger']),
  content: z.string(),
  timestamp: z.string(),
});

export const SessionHistoryMessageSchema = z.discriminatedUnion('type', [
  SessionHistoryTextMessageSchema,
  SessionHistoryFunctionCallMessageSchema,
  SessionHistoryAlertMessageSchema,
]);

// Transaction payload schema returned by backend on approve
export const TransactionPayloadSchema = z.object({
  format: z.enum(['base64_versioned_transaction', 'base64_legacy_transaction']),
  unsigned_tx_base64: z.string(),
  recent_blockhash: z.string().optional(),
  last_valid_block_height: z.number().optional(),
  network: z.string().optional(),
  execution_type: z.string().optional(),
  onchain_guardrail: OnchainGuardrailSchema.optional(),
});

// Swap guard metadata for oracle price validation
export const SwapGuardSchema = z.object({
  program_id: z.string(),
  oracle_feed: z.string(),
  quoted_price_usd_e8: z.number(),
  oracle_price_usd_e8: z.number().optional(),
  deviation_bps: z.number().optional(),
  warning_deviation_bps: z.number(),
  max_deviation_bps: z.number(),
  staleness_seconds: z.number(),
  max_confidence_bps: z.number(),
  network: z.enum(['devnet', 'mainnet-beta']),
  on_chain_enforcement: z.boolean().optional(),
  action_approval_pda: z.string().optional(),
});

// Warning info when swap passes but price is not ideal
export const SwapGuardWarningSchema = z.object({
  code: z.literal('price_deviation_warning'),
  message: z.string(),
  deviation_bps: z.number(),
});

export const AgentMessageResponseSchema = z.object({
  messages: z.array(AgentMessageSchema),
  transaction: TransactionPayloadSchema.optional(),
  swap_execution: z.object({
    provider: z.string(),
    pair: z.string(),
    input_amount: z.number(),
    slippage_bps: z.number(),
    quote: z.unknown().nullable(),
  }).optional(),
});

export const GuardRejectionSchema = z.object({
  reason: z.string(),
  deviation_bps: z.number(),
  max_allowed_bps: z.number(),
  oracle_price_usd: z.number(),
  quoted_price_usd: z.number(),
  can_bypass: z.boolean(),
  warning_message: z.string(),
});

export const FunctionApproveResponseSchema = AgentMessageResponseSchema.extend({
  proposal_state: z.object({
    state: z.enum(['awaiting_signature', 'guard_rejected_awaiting_bypass', 'cancelled']),
    expires_at: z.string().optional(),
  }).optional(),
  transaction: TransactionPayloadSchema.extend({
    recent_blockhash: z.string(),
    last_valid_block_height: z.number().int(),
    network: z.enum(['devnet', 'mainnet-beta']),
  }).optional(),
  swap_guard: SwapGuardSchema.optional(),
  swap_guard_warning: SwapGuardWarningSchema.optional(),
  guard_rejection: GuardRejectionSchema.optional(),
  risk_accepted: z.boolean().optional(),
  guard_bypassed: z.boolean().optional(),
});

export const GetHistoryResponseSchema = z.object({
  session_id: z.string(),
  user_address: z.string().nullable(),
  updated_at: z.string(),
  messages: z.array(SessionHistoryMessageSchema),
  pending_proposal: SessionHistoryFunctionCallMessageSchema.nullable(),
});

export const ChatFunctionResultSchema = z.object({
  session_id: z.string(),
  tx_signature: z.string(),
  status: z.enum(['submitted', 'confirmed', 'failed']),
  error_message: z.string().optional(),
});

export const TokenBalanceSchema = z.object({
  symbol: z.string(),
  mint: z.string(),
  amount: z.string(),
  decimals: z.number().int().nonnegative(),
  ui_amount: z.number(),
  usd_value: z.number(),
  icon_url: z.string().optional(),
});

export const GetBalancesResponseSchema = z.object({
  balances: z.array(TokenBalanceSchema),
  total_usd: z.number(),
  network: z.enum(['devnet', 'mainnet-beta']).optional(),
  change_24h_pct: z.number().optional(),
  updated_at: z.string(),
  partial: z.boolean().optional(),
  warnings: z.array(z.object({
    code: z.literal('spl_holdings_unavailable'),
    message: z.string(),
  })).optional(),
});

export const UsdcSolQuoteResponseSchema = z.object({
  network: z.enum(['devnet']),
  provider: z.literal('orca_whirlpools_devnet'),
  input_token: z.enum(['USDC', 'SOL']),
  output_token: z.enum(['USDC', 'SOL']),
  input_amount: z.number().positive(),
  output_amount: z.number().nonnegative(),
  input_mint: z.string(),
  output_mint: z.string(),
  slippage_bps: z.number().nonnegative(),
  route_context: z.string().optional(),
  updated_at: z.string(),
});

export const AllocationItemSchema = z.object({
  symbol: z.string(),
  percentage: z.number().min(0).max(100),
  color: z.string().optional(),
});

export const GetAllocationResponseSchema = z.object({
  total_assets: z.number().int().nonnegative(),
  allocation: z.array(AllocationItemSchema),
});

export const TxHistoryItemSchema = z.object({
  tx_hash: z.string(),
  type: z.enum(['swap', 'transfer', 'stake', 'other']),
  status: z.enum(['success', 'failed']),
  timestamp: z.string(),
  summary: z.string(),
  amount: z.number().optional(),
  amount_symbol: z.string().optional(),
  amount_usd: z.number().optional(),
  explorer_url: z.string(),
});

export const GetTransactionsResponseSchema = z.object({
  transactions: z.array(TxHistoryItemSchema),
  next_cursor: z.string().optional(),
});

export const GetNetworkStatusResponseSchema = z.object({
  connected: z.boolean(),
  network: z.literal('mainnet'),
  latency_ms: z.number().nonnegative(),
  tps: z.number().optional(),
});

export const GetPricesResponseSchema = z.object({
  prices: z.record(z.number()),
  updated_at: z.string(),
});

export const ConditionalOrderStatusEnum = z.enum([
  'open',
  'executed',
  'cancelled',
  'expired',
  'reclaimed',
  'unknown',
]);

export const ConditionalOrderSchema = z.object({
  orderPda: z.string(),
  user: z.string(),
  recipient: z.string(),
  clientOrderId: z.number(),
  usdcTestMint: z.string(),
  escrowTokenAccount: z.string(),
  treasuryUsdcAta: z.string(),
  solVaultPda: z.string(),
  oracleFeed: z.string(),
  desiredSolLamports: z.number(),
  maxUsdcIn: z.number(),
  targetPriceUsdE8: z.number(),
  maxOracleAgeSeconds: z.number(),
  maxConfidenceBps: z.number(),
  escrowedUsdcAmount: z.number(),
  executedUsdcAmount: z.number(),
  executedSolLamports: z.number(),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: ConditionalOrderStatusEnum,
  observedExecutable: z.boolean(),
  observedExecutableReason: z.string().optional(),
  indexedAt: z.number(),
});

export const ConditionalOrderListResponseSchema = z.array(ConditionalOrderSchema);

export const ConditionalOrderTriggerResponseSchema = z.object({
  status: z.literal('triggered'),
  orderPda: z.string(),
  tx_signature: z.string(),
});

// ============================================================================
// SSE Schemas
// ============================================================================

export const SSEProposalSchema = z.object({
  type: z.literal('function_call'),
  function: z.object({
    name: z.union([
      z.literal('transfer'),
      z.literal('conditional_buy_sol'),
      z.literal('swap_orca_usdc_to_sol'),
      z.literal('swap'),
      z.literal('stake'),
    ]),
    params: z.union([
      TransferParamsSchema,
      SwapParamsSchema,
      StakeParamsSchema,
      ConditionalBuySolParamsSchema,
      OrcaSwapParamsSchema,
    ]),
  }),
  display: z.object({
    summary: z.string(),
    fee_usd: z.number().optional(),
    provider: z.string().optional(),
  }),
  risk: RiskInfoSchema,
  execution: z
    .object({
      mode: z.enum(['phantom_sign_and_send', 'phantom_execute_then_optional_backend_proof']),
      network: z.enum(['devnet', 'mainnet-beta']),
      expires_at: z.string(),
      expected_user_address: z.string().optional(),
    })
    .optional(),
  onchain_guardrail: OnchainGuardrailSchema.optional(),
  timestamp: z.string(),
});
