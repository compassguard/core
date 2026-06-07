import { describe, expect, it } from 'vitest';

import {
  buildSwapGuardRejectionExplanation,
  buildSwapGuardWarningExplanation,
  buildTransferGuardrailExplanation,
} from '../guardrailExplanations';
import type { WalletSafetyDecisionResult } from '../walletSafetyValidation';

const createdAt = '2026-05-12T12:00:00.000Z';

function walletSafety(decision: WalletSafetyDecisionResult['decision']): WalletSafetyDecisionResult {
  const severity = decision === 'REJECT' ? 'critical' : decision === 'WARN' ? 'warning' : 'info';

  return {
    decision,
    riskLevel: decision === 'REJECT' ? 'critical' : decision === 'WARN' ? 'medium' : 'low',
    hardReject: decision === 'REJECT',
    requiresExtraConfirmation: decision === 'WARN',
    reasons: [
      {
        code: decision === 'ALLOW' ? 'wallet_format_valid' : 'destination_not_allowlisted',
        severity,
        message: decision === 'ALLOW' ? 'La dirección tiene formato Solana válido.' : 'El destino no está en tu allowlist.',
        source: 'policy',
      },
    ],
    sources: [{ provider: 'wallet_safety_policy', status: 'ok' }],
  };
}

describe('guardrail explanations', () => {
  it.each([
    ['ALLOW', 'info', 'continue'],
    ['WARN', 'warning', 'review_destination'],
    ['REJECT', 'critical', 'cancel'],
  ] as const)('builds a transfer %s explanation from computed wallet safety facts', (decision, severity, suggestedAction) => {
    const explanation = buildTransferGuardrailExplanation({
      risk: {
        score: decision === 'ALLOW' ? 10 : decision === 'WARN' ? 55 : 95,
        level: decision === 'ALLOW' ? 'low' : decision === 'WARN' ? 'medium' : 'critical',
        reasons: ['Dirección de destino con formato Solana válido'],
        walletSafety: walletSafety(decision),
      },
      walletSafety: walletSafety(decision),
      onchainGuardrail: {
        action_type: 'sol_transfer',
        action_hash: 'actionHash111',
        policy_pda: 'policyPda111',
        action_approval_pda: 'approvalPda111',
        wallet_safety_attestation_pda: 'attestationPda111',
        action_expires_at: '2026-05-12T12:05:00.000Z',
        action_created_at: createdAt,
        action_amount_lamports: 1_000_000_000,
        action_recipient: 'recipient111',
      },
      createdAt,
      amount: 1,
      token: 'SOL',
      recipient: 'recipient111',
    });

    expect(explanation.action_type).toBe('transfer');
    expect(explanation.decision).toBe(decision);
    expect(explanation.severity).toBe(severity);
    expect(explanation.suggested_user_action).toBe(suggestedAction);
    expect(explanation.reason_codes).toContain(walletSafety(decision).reasons[0].code);
    expect(explanation.checks.map((check) => check.check)).toContain('wallet_safety_decision');
    expect(explanation.technical_details).toMatchObject({
      action_hash: 'actionHash111',
      amount: 1,
      token: 'SOL',
    });
  });

  it('builds a swap warning explanation with price_or_execution_risk category', () => {
    const explanation = buildSwapGuardWarningExplanation({
      warning: {
        code: 'price_deviation_warning',
        message: 'El precio se desvió 2.00% del oráculo.',
        deviation_bps: 200,
      },
      swapGuard: {
        program_id: 'guardProgram111',
        oracle_feed: 'oracleFeed111',
        quoted_price_usd_e8: 15_300_000_000,
        oracle_price_usd_e8: 15_000_000_000,
        deviation_bps: 200,
        warning_deviation_bps: 150,
        max_deviation_bps: 500,
        staleness_seconds: 60,
        max_confidence_bps: 100,
        network: 'devnet',
        on_chain_enforcement: true,
      },
      createdAt,
    });

    expect(explanation.decision).toBe('WARN');
    expect(explanation.category).toBe('price_or_execution_risk');
    expect(explanation.reason_codes).toEqual(['price_deviation_warning']);
    expect(explanation.checks[0]).toMatchObject({ status: 'warn', source: 'oracle' });
    expect(explanation.technical_details).toMatchObject({ deviation_bps: 200, max_deviation_bps: 500 });
  });

  it('builds a swap rejection explanation with sanitized deviation technical details', () => {
    const explanation = buildSwapGuardRejectionExplanation({
      rejection: {
        reason: 'PriceDeviationExceeded',
        deviation_bps: 850,
        max_allowed_bps: 500,
        oracle_price_usd: 150,
        quoted_price_usd: 162.75,
        can_bypass: true,
        warning_message: 'El precio del swap difiere del precio de mercado.',
      },
      createdAt,
    });

    expect(explanation.decision).toBe('REJECT');
    expect(explanation.severity).toBe('critical');
    expect(explanation.reason_codes).toEqual(['PriceDeviationExceeded', 'price_deviation_rejected']);
    expect(explanation.checks[0]).toMatchObject({ status: 'fail', source: 'onchain' });
    expect(explanation.technical_details).toEqual({
      deviation_bps: 850,
      max_allowed_bps: 500,
      oracle_price_usd: 150,
      quoted_price_usd: 162.75,
      can_bypass: true,
    });
  });
});
