import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { web3 } from '@coral-xyz/anchor';

import {
  buildConditionalBuyCreateOrderTx,
  evaluateConditionalBuy,
  toConditionalBuyProposalPayload,
  type ConditionalBuySolParams,
} from '../tools/conditionalBuySol';

describe('conditionalBuySol tool', () => {
  const realUsdcMint = process.env.USDC_TEST_MINT;
  const realTreasuryAta = process.env.TREASURY_USDC_ATA;
  const realPythFeed = process.env.PYTH_SOL_USD_FEED;

  const user = web3.Keypair.generate().publicKey.toBase58();
  const recipient = web3.Keypair.generate().publicKey.toBase58();

  beforeEach(() => {
    process.env.USDC_TEST_MINT = 'So11111111111111111111111111111111111111112';
    process.env.USDC_TEST_DECIMALS = '6';
    process.env.TREASURY_USDC_ATA = web3.Keypair.generate().publicKey.toBase58();
    process.env.PYTH_SOL_USD_FEED = web3.Keypair.generate().publicKey.toBase58();
  });

  afterEach(() => {
    if (realUsdcMint === undefined) {
      delete process.env.USDC_TEST_MINT;
    } else {
      process.env.USDC_TEST_MINT = realUsdcMint;
    }
    if (realTreasuryAta === undefined) {
      delete process.env.TREASURY_USDC_ATA;
    } else {
      process.env.TREASURY_USDC_ATA = realTreasuryAta;
    }
    if (realPythFeed === undefined) {
      delete process.env.PYTH_SOL_USD_FEED;
    } else {
      process.env.PYTH_SOL_USD_FEED = realPythFeed;
    }
  });

  it('builds a create_order_and_deposit payload that resolves required fields', async () => {
    const getLatestBlockhash = vi
      .spyOn(web3.Connection.prototype, 'getLatestBlockhash')
      .mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 12345 });

    const params: ConditionalBuySolParams = {
      input_token: 'USDC',
      input_amount: 42.5,
      target_price_usd: 190,
      desired_sol_amount: 0.1,
      recipient,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      client_order_id: 1234,
      oracle_feed_pubkey: web3.Keypair.generate().publicKey.toBase58(),
    };

    const proposalPayload = toConditionalBuyProposalPayload(params, user, 198);
    const txPayload = await buildConditionalBuyCreateOrderTx({
      userAddress: user,
      desired_sol_amount: proposalPayload.desired_sol_amount,
      desired_sol_lamports: proposalPayload.desired_sol_lamports,
      max_usdc_in: proposalPayload.max_usdc_in,
      target_price_usd: proposalPayload.target_price_usd,
      recipient: recipient,
      expires_at_unix: proposalPayload.expires_at_unix,
      client_order_id: proposalPayload.client_order_id,
      oracle_feed_pubkey: proposalPayload.oracle_feed_pubkey,
      max_oracle_age_seconds: proposalPayload.max_oracle_age_seconds,
      max_confidence_bps: proposalPayload.max_confidence_bps,
    });

    expect(txPayload.txBase64).toBeTypeOf('string');
    expect(txPayload.orderPda).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(txPayload.vaultConfig).toBeTypeOf('string');
    expect(txPayload.solVault).toBeTypeOf('string');
    expect(txPayload.blockhash).toBe('11111111111111111111111111111111');

    getLatestBlockhash.mockRestore();
  });

  it('derives desired_sol_amount from min_sol_out when desired_sol_amount is absent', () => {
    const withFallback = toConditionalBuyProposalPayload(
      {
        input_token: 'USDC',
        input_amount: 12.5,
        target_price_usd: 200,
        min_sol_out: 0.25,
      },
      user,
      200,
    );

    expect(withFallback.desired_sol_amount).toBe(0.25);
    expect(withFallback.desired_sol_lamports).toBeGreaterThan(0);
  });

  it('rejects invalid inputs from guardrail evaluator', () => {
    const rejected = evaluateConditionalBuy({
      input_token: 'USDC',
      input_amount: 1,
      target_price_usd: 0,
    });

    expect(rejected.decision).toBe('REJECT');
    expect(rejected.reasons).toContain('INVALID_TARGET_PRICE');
  });
});
