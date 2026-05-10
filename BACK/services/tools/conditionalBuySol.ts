import { z } from 'zod';

export type ConditionalBuySolParams = {
  input_token: 'USDC';
  input_amount: number;
  target_price_usd: number;
  min_sol_out?: number;
};

export type SimulatedBuyQuote = {
  provider: 'simulated_devnet_market';
  sol_usd_price: number;
  input_token: 'USDC';
  input_amount: number;
  estimated_sol_out: number;
  slippage_bps: number;
  price_impact_bps: number;
  expires_at: string;
};

export type ConditionalDecision =
  | { decision: 'ALLOW_WITH_CONFIRMATION'; reasons: string[] }
  | { decision: 'WAIT_CONDITION_NOT_MET'; reasons: string[] }
  | { decision: 'REJECT'; reasons: string[] };

const DEFAULT_SOL_PRICE = Number(process.env.SIMULATED_SOL_USD_PRICE || '125');
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS || '50');
const DEFAULT_PRICE_IMPACT_BPS = Number(process.env.DEFAULT_PRICE_IMPACT_BPS || '80');

export function simulateBuySolQuote(params: ConditionalBuySolParams): SimulatedBuyQuote {
  const inputAmountAfterImpact = params.input_amount * (1 - DEFAULT_PRICE_IMPACT_BPS / 10_000);
  const solOutBeforeSlippage = inputAmountAfterImpact / DEFAULT_SOL_PRICE;
  const estimatedSolOut = solOutBeforeSlippage * (1 - DEFAULT_SLIPPAGE_BPS / 10_000);

  return {
    provider: 'simulated_devnet_market',
    sol_usd_price: DEFAULT_SOL_PRICE,
    input_token: 'USDC',
    input_amount: params.input_amount,
    estimated_sol_out: Number(estimatedSolOut.toFixed(6)),
    slippage_bps: DEFAULT_SLIPPAGE_BPS,
    price_impact_bps: DEFAULT_PRICE_IMPACT_BPS,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

export function evaluateConditionalBuy(
  params: ConditionalBuySolParams,
  quote: SimulatedBuyQuote
): ConditionalDecision {
  if (!Number.isFinite(params.input_amount) || params.input_amount <= 0) {
    return { decision: 'REJECT', reasons: ['INVALID_INPUT_AMOUNT'] };
  }
  if (!Number.isFinite(params.target_price_usd) || params.target_price_usd <= 0) {
    return { decision: 'REJECT', reasons: ['INVALID_TARGET_PRICE'] };
  }

  if (quote.sol_usd_price > params.target_price_usd) {
    return {
      decision: 'WAIT_CONDITION_NOT_MET',
      reasons: [`Current SOL price (${quote.sol_usd_price}) is above target (${params.target_price_usd})`],
    };
  }

  if (params.min_sol_out && quote.estimated_sol_out < params.min_sol_out) {
    return {
      decision: 'REJECT',
      reasons: [`Estimated SOL out (${quote.estimated_sol_out}) is below min_sol_out (${params.min_sol_out})`],
    };
  }

  return {
    decision: 'ALLOW_WITH_CONFIRMATION',
    reasons: ['Price condition is met', 'Estimated output satisfies constraints'],
  };
}

export const conditionalBuySolSchema = z.object({
  input_token: z.literal('USDC').default('USDC'),
  input_amount: z.number().positive(),
  target_price_usd: z.number().positive().describe('Buy condition: execute only if SOL/USD <= target_price_usd'),
  min_sol_out: z.number().positive().optional(),
});
