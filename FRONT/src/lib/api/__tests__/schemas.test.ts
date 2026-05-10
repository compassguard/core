import { describe, expect, it } from 'vitest';
import { AgentMessageResponseSchema, GetBalancesResponseSchema, TransactionPayloadSchema } from '../schemas';

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

  it('validates approve response with transaction payload', () => {
    const parsed = AgentMessageResponseSchema.parse({
      messages: [
        {
          type: 'text',
          content: 'Transfer prepared. Sign in your wallet to execute.',
          timestamp: new Date().toISOString(),
        },
      ],
      transaction: {
        format: 'base64_versioned_transaction',
        unsigned_tx_base64: 'dGVzdA==', // "test" in base64
        recent_blockhash: 'abc123',
        last_valid_block_height: 12345,
        network: 'devnet',
      },
    });

    expect(parsed.messages[0].type).toBe('text');
    expect(parsed.transaction).toBeDefined();
    expect(parsed.transaction?.format).toBe('base64_versioned_transaction');
    expect(parsed.transaction?.unsigned_tx_base64).toBe('dGVzdA==');
  });

  it('validates swap execution response with transaction', () => {
    const parsed = AgentMessageResponseSchema.parse({
      messages: [
        {
          type: 'text',
          content: 'Swap prepared: 10 USDC → SOL. Sign to execute.',
          timestamp: new Date().toISOString(),
        },
      ],
      transaction: {
        format: 'base64_legacy_transaction',
        unsigned_tx_base64: 'c3dhcHR4', // "swaptx" in base64
        recent_blockhash: 'xyz789',
        network: 'devnet',
        execution_type: 'orca_swap_usdc_to_sol',
      },
      swap_execution: {
        provider: 'orca_whirlpools_devnet',
        pair: 'USDC/SOL',
        input_amount: 10,
        slippage_bps: 100,
        quote: null,
      },
    });

    expect(parsed.transaction?.format).toBe('base64_legacy_transaction');
    expect(parsed.swap_execution?.provider).toBe('orca_whirlpools_devnet');
  });

  it('validates transaction payload schema', () => {
    const parsed = TransactionPayloadSchema.parse({
      format: 'base64_versioned_transaction',
      unsigned_tx_base64: 'dGVzdA==',
    });

    expect(parsed.format).toBe('base64_versioned_transaction');
    expect(parsed.unsigned_tx_base64).toBe('dGVzdA==');
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
});
