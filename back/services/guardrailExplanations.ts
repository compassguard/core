import { createHash } from 'node:crypto';

import type { TransferRiskAssessment } from './tools/transfer';
import type { SwapGuardConfig, SwapGuardWarning } from './tools/swapGuard';
import type { WalletSafetyDecisionResult, WalletSafetySource } from './walletSafetyValidation';

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
export type ExplanationSource = WalletSafetySource | 'oracle' | 'simulation';
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

type TransferOnchainGuardrailMetadata = {
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

type SwapGuardRejectionInput = {
  reason: string;
  deviation_bps: number;
  max_allowed_bps: number;
  oracle_price_usd: number;
  quoted_price_usd: number;
  can_bypass: boolean;
  warning_message: string;
};

function hashId(prefix: string, payload: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
  return `${prefix}-${digest}`;
}

function severityFromDecision(decision: GuardrailDecision): GuardrailSeverity {
  if (decision === 'REJECT') return 'critical';
  if (decision === 'WARN') return 'warning';
  return 'info';
}

function suggestedActionFromDecision(decision: GuardrailDecision): SuggestedUserAction {
  if (decision === 'REJECT') return 'cancel';
  if (decision === 'WARN') return 'review_destination';
  return 'continue';
}

function checkStatusFromDecision(decision: GuardrailDecision): CheckStatus {
  if (decision === 'REJECT') return 'fail';
  if (decision === 'WARN') return 'warn';
  return 'pass';
}

function technicalDetailsWithoutUndefined(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

function transferSummary(decision: GuardrailDecision, risk: TransferRiskAssessment): string {
  if (decision === 'REJECT') return 'Transferencia bloqueada por el guardrail de seguridad.';
  if (decision === 'WARN') return 'Revisá la transferencia antes de firmar.';
  return `Transferencia permitida con riesgo ${risk.level}.`;
}

export function buildTransferGuardrailExplanation(input: {
  risk: TransferRiskAssessment;
  walletSafety: WalletSafetyDecisionResult;
  onchainGuardrail?: TransferOnchainGuardrailMetadata;
  createdAt?: string;
  amount?: number;
  token?: string;
  recipient?: string;
}): GuardrailExplanation {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const decision = input.walletSafety.decision;
  const severity = severityFromDecision(decision);
  const reasonCodes = input.walletSafety.reasons.map((reason) => reason.code);

  return {
    id: hashId('transfer-explanation', {
      decision,
      reasonCodes,
      actionHash: input.onchainGuardrail?.action_hash,
      createdAt,
    }),
    action_type: 'transfer',
    decision,
    severity,
    category: 'destination_trust',
    summary: transferSummary(decision, input.risk),
    impact:
      decision === 'ALLOW'
        ? undefined
        : 'Si el destino o el monto no son los esperados, una transferencia on-chain no se puede revertir.',
    reason_codes: reasonCodes,
    reasons: input.walletSafety.reasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
      category: 'destination_trust',
      source: reason.source,
      severity: reason.severity,
    })),
    checks: [
      {
        check: 'wallet_safety_decision',
        label: 'Evaluación de seguridad de la wallet destino',
        status: checkStatusFromDecision(decision),
        source: 'policy',
        evidence: {
          risk_level: input.walletSafety.riskLevel,
          requires_extra_confirmation: input.walletSafety.requiresExtraConfirmation,
          hard_reject: input.walletSafety.hardReject,
        },
      },
      ...(input.onchainGuardrail
        ? [
            {
              check: 'onchain_guardrail_metadata',
              label: 'Metadatos de enforcement on-chain preparados',
              status: 'pass' as const,
              source: 'onchain_approval' as const,
              evidence: {
                action_hash: input.onchainGuardrail.action_hash,
                action_expires_at: input.onchainGuardrail.action_expires_at,
              },
            },
          ]
        : []),
    ],
    sources: input.walletSafety.sources.map((source) => ({
      provider: source.provider,
      status: source.status,
      checked_at: createdAt,
    })),
    suggested_user_action: suggestedActionFromDecision(decision),
    technical_details: technicalDetailsWithoutUndefined({
      score: input.risk.score,
      risk_level: input.risk.level,
      requires_extra_confirmation: input.walletSafety.requiresExtraConfirmation,
      action_hash: input.onchainGuardrail?.action_hash,
      policy_pda: input.onchainGuardrail?.policy_pda,
      action_approval_pda: input.onchainGuardrail?.action_approval_pda,
      wallet_safety_attestation_pda: input.onchainGuardrail?.wallet_safety_attestation_pda,
      action_expires_at: input.onchainGuardrail?.action_expires_at,
      action_recipient: input.onchainGuardrail?.action_recipient,
      amount: input.amount,
      token: input.token,
      recipient: input.recipient,
    }),
    created_at: createdAt,
  };
}

export function buildSwapGuardWarningExplanation(input: {
  warning: NonNullable<SwapGuardWarning>;
  swapGuard?: SwapGuardConfig;
  createdAt?: string;
}): GuardrailExplanation {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const warning = input.warning;

  return {
    id: hashId('swap-warning-explanation', {
      code: warning.code,
      deviationBps: warning.deviation_bps,
      quotedPrice: input.swapGuard?.quoted_price_usd_e8,
      oraclePrice: input.swapGuard?.oracle_price_usd_e8,
      createdAt,
    }),
    action_type: 'swap',
    decision: 'WARN',
    severity: 'warning',
    category: 'price_or_execution_risk',
    summary: 'El swap está permitido, pero el precio se aleja del oráculo.',
    impact: 'Una desviación de precio puede hacer que recibas menos valor del esperado al ejecutar el swap.',
    reason_codes: [warning.code],
    reasons: [
      {
        code: warning.code,
        message: warning.message,
        category: 'price_or_execution_risk',
        source: 'oracle',
        severity: 'warning',
      },
    ],
    checks: [
      {
        check: 'swap_price_deviation',
        label: 'Comparación de precio cotizado contra oráculo',
        status: 'warn',
        source: 'oracle',
        evidence: technicalDetailsWithoutUndefined({
          deviation_bps: warning.deviation_bps,
          warning_deviation_bps: input.swapGuard?.warning_deviation_bps,
          max_deviation_bps: input.swapGuard?.max_deviation_bps,
        }),
      },
    ],
    sources: [
      {
        provider: input.swapGuard?.oracle_feed ? 'pyth_oracle' : 'swap_guard',
        status: input.swapGuard?.oracle_price_usd_e8 ? 'ok' : 'missing',
        checked_at: createdAt,
      },
    ],
    suggested_user_action: 'review_price',
    technical_details: technicalDetailsWithoutUndefined({
      oracle_feed: input.swapGuard?.oracle_feed,
      quoted_price_usd_e8: input.swapGuard?.quoted_price_usd_e8,
      oracle_price_usd_e8: input.swapGuard?.oracle_price_usd_e8,
      deviation_bps: warning.deviation_bps,
      warning_deviation_bps: input.swapGuard?.warning_deviation_bps,
      max_deviation_bps: input.swapGuard?.max_deviation_bps,
      on_chain_enforcement: input.swapGuard?.on_chain_enforcement,
      action_approval_pda: input.swapGuard?.action_approval_pda,
    }),
    created_at: createdAt,
  };
}

export function buildSwapGuardRejectionExplanation(input: {
  rejection: SwapGuardRejectionInput;
  createdAt?: string;
}): GuardrailExplanation {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const rejection = input.rejection;

  return {
    id: hashId('swap-rejection-explanation', {
      reason: rejection.reason,
      deviationBps: rejection.deviation_bps,
      maxAllowedBps: rejection.max_allowed_bps,
      createdAt,
    }),
    action_type: 'swap',
    decision: 'REJECT',
    severity: 'critical',
    category: 'price_or_execution_risk',
    summary: 'El guardrail bloqueó el swap porque la desviación de precio supera el máximo permitido.',
    impact: rejection.warning_message,
    reason_codes: [rejection.reason, 'price_deviation_rejected'],
    reasons: [
      {
        code: 'price_deviation_rejected',
        message: rejection.warning_message,
        category: 'price_or_execution_risk',
        source: 'onchain',
        severity: 'critical',
      },
    ],
    checks: [
      {
        check: 'swap_price_deviation',
        label: 'Límite máximo de desviación de precio',
        status: 'fail',
        source: 'onchain',
        evidence: {
          deviation_bps: rejection.deviation_bps,
          max_allowed_bps: rejection.max_allowed_bps,
        },
      },
    ],
    sources: [
      {
        provider: 'agent_action_guard',
        status: 'ok',
        checked_at: createdAt,
      },
    ],
    suggested_user_action: rejection.can_bypass ? 'request_review' : 'cancel',
    technical_details: {
      deviation_bps: rejection.deviation_bps,
      max_allowed_bps: rejection.max_allowed_bps,
      oracle_price_usd: rejection.oracle_price_usd,
      quoted_price_usd: rejection.quoted_price_usd,
      can_bypass: rejection.can_bypass,
    },
    created_at: createdAt,
  };
}
