import { z } from 'zod';

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

export const RiskInfoSchema = z.object({
  score: z.number().min(0).max(100),
  level: z.enum(['low', 'medium', 'critical']),
  reasons: z.array(z.string()).optional(),
});

export const ExecuteSchema = z.object({
  status: z.enum(['success', 'failed']),
  tx_hash: z.string().optional(),
  error: z.string().optional(),
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
      name: z.enum(['swap', 'transfer', 'stake']),
      params: z.union([SwapParamsSchema, TransferParamsSchema, StakeParamsSchema]),
    }),
    display: z.object({
      summary: z.string(),
      fee_usd: z.number().optional(),
      provider: z.string().optional(),
      slippage_bps: z.number().optional(),
    }),
    risk: RiskInfoSchema,
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal('alert'),
    severity: z.enum(['info', 'warning', 'danger']),
    content: z.string(),
    timestamp: z.string(),
  }),
]);

export const AgentMessageResponseSchema = z.object({
  messages: z.array(AgentMessageSchema),
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
  change_24h_pct: z.number(),
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

// ============================================================================
// SSE Schemas
// ============================================================================

export const SSEProposalSchema = z.object({
  type: z.literal('function_call'),
  function: z.object({
    name: z.literal('transfer'),
    params: TransferParamsSchema,
  }),
  display: z.object({
    summary: z.string(),
    fee_usd: z.number().optional(),
    provider: z.string().optional(),
  }),
  risk: RiskInfoSchema,
  timestamp: z.string(),
});
