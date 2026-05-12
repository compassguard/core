import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  AgentMessageResponseSchema,
  GetBalancesResponseSchema,
  GetHistoryResponseSchema,
  FunctionApproveResponseSchema,
  FunctionExecutionSchema,
  ConditionalBuySolParamsSchema,
  TransactionPayloadSchema,
  SSEProposalSchema,
  UsdcSolQuoteResponseSchema,
  ConditionalOrderListResponseSchema,
  ConditionalOrderTriggerResponseSchema,
  ConditionalOrderStatusEnum,
} from '../schemas';

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

  it('validates wallet balances without optional 24h change', () => {
    const parsed = GetBalancesResponseSchema.parse({
      balances: [
        {
          symbol: 'SOL',
          mint: 'So11111111111111111111111111111111111111112',
          amount: '7499840000',
          decimals: 9,
          ui_amount: 7.49984,
          usd_value: 0,
        },
      ],
      total_usd: 0,
      updated_at: '2026-05-10T02:03:57.138Z',
    });

    expect(parsed.change_24h_pct).toBeUndefined();
    expect(parsed.balances[0].ui_amount).toBe(7.49984);
  });

  it('validates session history payload with pending proposal', () => {
    const now = new Date().toISOString();
    const parsed = GetHistoryResponseSchema.parse({
      session_id: 'session-1',
      user_address: 'wallet-1',
      updated_at: now,
      messages: [
        {
          role: 'user',
          type: 'text',
          content: 'Quiero transferir',
          timestamp: now,
        },
        {
          role: 'agent',
          type: 'text',
          content: 'Preparo eso.',
          timestamp: now,
        },
        {
          role: 'agent',
          type: 'function_call',
          function: {
            name: 'transfer',
            params: {
              amount: 1,
              token: 'SOL',
              recipient: '11111111111111111111111111111111',
            },
          },
          display: {
            summary: 'Transfer 1 SOL',
            fee_usd: 0,
          },
          risk: {
            score: 10,
            level: 'low',
          },
          timestamp: now,
        },
      ],
      pending_proposal: {
        role: 'agent',
        type: 'function_call',
        function: {
          name: 'transfer',
          params: {
            amount: 1,
            token: 'SOL',
            recipient: '11111111111111111111111111111111',
          },
        },
        display: {
          summary: 'Transfer 1 SOL',
          fee_usd: 0,
        },
        risk: {
          score: 10,
          level: 'low',
        },
        timestamp: now,
      },
    });

    expect(parsed.session_id).toBe('session-1');
    expect(parsed.pending_proposal?.type).toBe('function_call');
    expect(parsed.messages).toHaveLength(3);
  });

  it('validates session_not_found API error payload', () => {
    const parsed = ApiErrorSchema.parse({
      error: {
        code: 'session_not_found',
        message: 'Session not found or expired',
      },
    });

    expect(parsed.error.code).toBe('session_not_found');
  });

  it('validates partial wallet balances with warnings', () => {
    const parsed = GetBalancesResponseSchema.parse({
      balances: [
        {
          symbol: 'SOL',
          mint: 'So11111111111111111111111111111111111111112',
          amount: '2500000000',
          decimals: 9,
          ui_amount: 2.5,
          usd_value: 0,
        },
      ],
      total_usd: 0,
      updated_at: '2026-05-10T02:03:57.138Z',
      partial: true,
      warnings: [
        {
          code: 'spl_holdings_unavailable',
          message: 'SPL token holdings unavailable',
        },
      ],
    });

    expect(parsed.partial).toBe(true);
    expect(parsed.warnings?.[0].code).toBe('spl_holdings_unavailable');
  });

  it('validates usdc/sol quote response', () => {
    const parsed = UsdcSolQuoteResponseSchema.parse({
      network: 'devnet',
      provider: 'orca_whirlpools_devnet',
      input_token: 'USDC',
      output_token: 'SOL',
      input_amount: 12,
      output_amount: 0.0321,
      input_mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k',
      output_mint: 'So11111111111111111111111111111111111111112',
      slippage_bps: 100,
      updated_at: '2026-05-10T02:03:57.138Z',
    });

    expect(parsed.provider).toBe('orca_whirlpools_devnet');
  });

  it('validates function approve response without signed tx submission', () => {
    const parsed = FunctionApproveResponseSchema.parse({
      messages: [
        {
          type: 'text',
          content: 'Transacción preparada. Revisa y firma en tu wallet.',
          timestamp: new Date().toISOString(),
        },
      ],
      proposal_state: {
        state: 'awaiting_signature',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      transaction: {
        format: 'base64_versioned_transaction',
        unsigned_tx_base64: 'AQB0ZXN0',
        recent_blockhash: 'testhash',
        last_valid_block_height: 1234,
        network: 'devnet',
      },
    });

    expect(parsed.proposal_state.state).toBe('awaiting_signature');
    expect(parsed.transaction?.unsigned_tx_base64).toBe('AQB0ZXN0');
    expect(parsed.messages[0].type).toBe('text');
  });

  it('validates swap approve response with proposal_state and swap execution', () => {
    const parsed = FunctionApproveResponseSchema.parse({
      messages: [
        {
          type: 'text',
          content: 'Swap preparado. Firma en tu wallet para ejecutar.',
          timestamp: new Date().toISOString(),
        },
      ],
      proposal_state: {
        state: 'awaiting_signature',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      transaction: {
        format: 'base64_versioned_transaction',
        unsigned_tx_base64: 'AQB0ZXN0',
        recent_blockhash: 'testhash',
        last_valid_block_height: 1234,
        network: 'devnet',
        execution_type: 'orca_swap',
      },
      swap_execution: {
        provider: 'orca_whirlpools_devnet',
        pair: 'SOL/USDC',
        input_amount: 0.5,
        slippage_bps: 100,
        quote: null,
      },
    });

    expect(parsed.proposal_state.state).toBe('awaiting_signature');
    expect(parsed.swap_execution?.provider).toBe('orca_whirlpools_devnet');
    expect(parsed.transaction?.execution_type).toBe('orca_swap');
  });

  it('allows conditional buy proposal params and execution envelope', () => {
    const parsedParams = ConditionalBuySolParamsSchema.parse({
      input_token: 'USDC',
      input_amount: 10,
      target_price_usd: 120,
    });

    const parsedProposal = SSEProposalSchema.parse({
      type: 'function_call',
      function: {
        name: 'conditional_buy_sol',
        params: parsedParams,
      },
      display: {
        summary: 'Conditional buy',
        provider: 'simulated',
      },
      risk: {
        score: 35,
        level: 'medium',
      },
      execution: {
        mode: 'phantom_sign_and_send',
        network: 'devnet',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      timestamp: new Date().toISOString(),
    });

    expect(parsedProposal.function.name).toBe('conditional_buy_sol');
    expect(parsedProposal.execution?.mode).toBe('phantom_sign_and_send');
  });

  it('preserves on-chain guardrail metadata in SSE proposals', () => {
    const parsedProposal = SSEProposalSchema.parse({
      type: 'function_call',
      function: {
        name: 'transfer',
        params: {
          amount: 5,
          token: 'SOL',
          recipient: 'bEsfmEAaTA98rLftyi2jZ4XAzCBbqBvrJPKNW6rYJgp',
        },
      },
      display: {
        summary: 'Enviar 5 SOL a bEsf...YJgp',
        fee_usd: 0.01,
        provider: 'solana_devnet_guarded_transfer',
      },
      risk: {
        score: 55,
        level: 'medium',
      },
      execution: {
        mode: 'phantom_sign_and_send',
        network: 'devnet',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      onchain_guardrail: {
        action_type: 'sol_transfer',
        action_hash: '8m1Y9vV1t42H8JVE3qA6RkN6sQSmDMbtKuQVppAxX4oa',
        policy_pda: '5xpP9TksL4dJ8Y6vvLMUbJECJbnmMmk2nvtbHhfk1ygn',
        action_approval_pda: 'J4nZD8Gj3oCt6Q2UoZc77YvbdMzYBdX5pZGbzLM6KFAH',
        wallet_safety_attestation_pda: 'E7Lr8EemNr7uCMtGY9rMUneG5UegHH8zGwSVXHSKzpn5',
        action_expires_at: new Date(Date.now() + 60_000).toISOString(),
        action_created_at: new Date().toISOString(),
        action_amount_lamports: 5_000_000_000,
        action_recipient: 'bEsfmEAaTA98rLftyi2jZ4XAzCBbqBvrJPKNW6rYJgp',
      },
      timestamp: new Date().toISOString(),
    });

    expect(parsedProposal.onchain_guardrail?.policy_pda).toBe(
      '5xpP9TksL4dJ8Y6vvLMUbJECJbnmMmk2nvtbHhfk1ygn',
    );
    expect(parsedProposal.onchain_guardrail?.action_approval_pda).toBe(
      'J4nZD8Gj3oCt6Q2UoZc77YvbdMzYBdX5pZGbzLM6KFAH',
    );
  });

  it('validates conditional order list and detail schemas', () => {
    const now = Math.floor(Date.now() / 1000);

    const parsed = ConditionalOrderListResponseSchema.parse([
      {
        orderPda: '11111111111111111111111111111111',
        user: '11111111111111111111111111111111',
        recipient: '11111111111111111111111111111111',
        clientOrderId: 17,
        usdcTestMint: 'So11111111111111111111111111111111111111112',
        escrowTokenAccount: '11111111111111111111111111111111',
        treasuryUsdcAta: '11111111111111111111111111111111',
        solVaultPda: '11111111111111111111111111111111',
        oracleFeed: '11111111111111111111111111111111',
        desiredSolLamports: 500_000_000,
        maxUsdcIn: 12_000_000,
        targetPriceUsdE8: 150_00000000,
        maxOracleAgeSeconds: 120,
        maxConfidenceBps: 400,
        escrowedUsdcAmount: 12_000_000,
        executedUsdcAmount: 0,
        executedSolLamports: 0,
        createdAt: now,
        expiresAt: now + 3600,
        status: 'open',
        observedExecutable: false,
        indexedAt: now,
      },
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe('open');
  });

  it('validates conditional order trigger response', () => {
    const parsed = ConditionalOrderTriggerResponseSchema.parse({
      status: 'triggered',
      orderPda: '11111111111111111111111111111111',
      tx_signature: '5TxSig',
    });

    expect(parsed.status).toBe('triggered');
  });

  it('includes all conditional order states in enum', () => {
    expect(ConditionalOrderStatusEnum.safeParse('executed').success).toBe(true);
    expect(ConditionalOrderStatusEnum.safeParse('open').success).toBe(true);
    expect(ConditionalOrderStatusEnum.safeParse('reclaimed').success).toBe(true);
  });

  it('reuses execution enum schema', () => {
    expect(() =>
      FunctionExecutionSchema.parse({
        mode: 'phantom_sign_and_send',
        network: 'mainnet-beta',
        expires_at: new Date().toISOString(),
      }),
    ).not.toThrow();
  });
});
