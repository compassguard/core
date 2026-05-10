import { describe, expect, it } from 'vitest';
import { AgentMessageResponseSchema, GetBalancesResponseSchema } from '../schemas';

describe('api schemas', () => {
  it('validates an agent function_call response', () => {
    const parsed = AgentMessageResponseSchema.parse({
      messages: [
        {
          type: 'function_call',
          function: {
            name: 'swap',
            params: { amount_in: 5, token_in: 'SOL', token_out: 'USDC' },
          },
          display: { summary: 'Swap 5 SOL → ~725 USDC', fee_usd: 0.04, provider: 'Agent' },
          risk: { score: 65, level: 'medium', reasons: ['Above threshold'] },
          timestamp: new Date().toISOString(),
        },
      ],
    });

    expect(parsed.messages[0].type).toBe('function_call');
  });

  it('validates wallet balances', () => {
    const parsed = GetBalancesResponseSchema.parse({
      balances: [
        {
          symbol: 'SOL',
          mint: 'So11111111111111111111111111111111111111112',
          amount: '1000000000',
          decimals: 9,
          ui_amount: 1,
          usd_value: 145,
        },
      ],
      total_usd: 145,
      change_24h_pct: 2.4,
      updated_at: new Date().toISOString(),
    });

    expect(parsed.balances[0].symbol).toBe('SOL');
  });

  it('allows change_24h_pct to be omitted from balances response', () => {
    const parsed = GetBalancesResponseSchema.parse({
      balances: [
        {
          symbol: 'USDC',
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          amount: '2500000000',
          decimals: 6,
          ui_amount: 2500,
          usd_value: 2500,
        },
      ],
      total_usd: 2500,
      updated_at: new Date().toISOString(),
    });

    expect(parsed.total_usd).toBe(2500);
    expect(parsed.change_24h_pct).toBeUndefined();
  });

  it('rejects wallet balances with a non-ISO updated_at timestamp', () => {
    expect(() =>
      GetBalancesResponseSchema.parse({
        balances: [],
        total_usd: 0,
        updated_at: 'not-a-date',
      }),
    ).toThrow();
  });
});
