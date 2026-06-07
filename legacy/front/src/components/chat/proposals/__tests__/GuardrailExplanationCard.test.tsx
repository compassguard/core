import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuardrailExplanation, RiskInfo, GuardRejection, SwapGuardWarning as SwapGuardWarningData } from '@/types/api';
import { GuardrailExplanationCard } from '../GuardrailExplanationCard';
import { RiskInlineAlert } from '../RiskInlineAlert';
import { SwapGuardBypassWarning } from '../SwapGuardBypassWarning';
import { SwapGuardWarning } from '../SwapGuardWarning';

const settingsState = vi.hoisted(() => ({ riskWarningsEnabled: true }));

vi.mock('@/hooks/useAgentMessage', () => ({
  useAgentMessage: () => ({
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
  }),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

const baseExplanation: GuardrailExplanation = {
  id: 'exp-test-1',
  action_type: 'swap',
  decision: 'WARN',
  severity: 'warning',
  category: 'price_or_execution_risk',
  summary: 'El precio cotizado se aleja del precio de referencia.',
  impact: 'Podrías recibir menos SOL del esperado.',
  reason_codes: ['price_deviation_warning'],
  reasons: [
    {
      code: 'price_deviation_warning',
      message: 'La desviación supera el umbral de advertencia.',
      category: 'price_or_execution_risk',
      source: 'oracle',
      severity: 'warning',
    },
  ],
  checks: [
    {
      check: 'pyth_price_deviation',
      label: 'Precio comparado contra Pyth',
      status: 'warn',
      source: 'oracle',
    },
  ],
  sources: [
    {
      provider: 'pyth',
      status: 'ok',
      checked_at: '2026-05-13T12:00:00.000Z',
    },
  ],
  suggested_user_action: 'review_price',
  technical_details: {
    action_hash: 'hash_123',
    deviation_bps: 850,
  },
  created_at: '2026-05-13T12:00:00.000Z',
};

beforeEach(() => {
  settingsState.riskWarningsEnabled = true;
});

afterEach(() => {
  cleanup();
});

describe('GuardrailExplanationCard', () => {
  it('shows summary by default and keeps details collapsed', () => {
    render(<GuardrailExplanationCard explanation={baseExplanation} />);

    expect(screen.queryByText('WARN · Revisá antes de firmar')).not.toBeNull();
    expect(screen.queryByText('El precio cotizado se aleja del precio de referencia.')).not.toBeNull();
    expect(screen.queryByText('Podrías recibir menos SOL del esperado.')).not.toBeNull();
    expect(screen.queryByText('price_deviation_warning')).toBeNull();
    expect(screen.queryByText('action_hash')).toBeNull();
  });

  it('expands details and keeps technical details behind an explicit action', () => {
    render(<GuardrailExplanationCard explanation={baseExplanation} />);

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }));

    expect(screen.queryByText('price_deviation_warning')).not.toBeNull();
    expect(screen.queryByText('Precio comparado contra Pyth')).not.toBeNull();
    expect(screen.queryByText('pyth: OK')).not.toBeNull();
    expect(screen.queryByText('action_hash')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ver técnico' }));

    expect(screen.queryByText('action_hash')).not.toBeNull();
    expect(screen.queryByText('hash_123')).not.toBeNull();
  });

  it('renders valid narration as secondary help without model metadata', () => {
    render(
      <GuardrailExplanationCard
        explanation={{
          ...baseExplanation,
          narration: {
            summary: 'El precio está fuera del rango habitual, por eso conviene revisar antes de firmar.',
            bullets: ['El chequeo contra Pyth salió con advertencia.'],
            based_on: {
              explanation_id: baseExplanation.id,
              reason_codes: ['price_deviation_warning'],
              checks: ['pyth_price_deviation'],
              sources: ['pyth'],
            },
          },
        }}
      />,
    );

    expect(screen.queryByLabelText('Ayuda narrativa del guardrail')).not.toBeNull();
    expect(screen.queryByText('El precio está fuera del rango habitual, por eso conviene revisar antes de firmar.')).not.toBeNull();
    expect(screen.queryByText('El chequeo contra Pyth salió con advertencia.')).not.toBeNull();
    expect(screen.queryByText(/la decisión oficial es la de arriba/i)).not.toBeNull();
    expect(screen.queryByText(/model/i)).toBeNull();
  });
});

describe('RiskInlineAlert', () => {
  it('renders explanation first when risk.explanation exists', () => {
    const risk: RiskInfo = {
      score: 42,
      level: 'medium',
      explanation: baseExplanation,
    };

    render(<RiskInlineAlert risk={risk} />);

    expect(screen.queryByText('El precio cotizado se aleja del precio de referencia.')).not.toBeNull();
    expect(screen.queryByText(/Riesgo bajo/)).toBeNull();
  });

  it('keeps the legacy fallback when explanation is absent', () => {
    const risk: RiskInfo = {
      score: 4,
      level: 'low',
      walletSafety: {
        decision: 'ALLOW',
        riskLevel: 'low',
        hardReject: false,
        requiresExtraConfirmation: false,
        reasons: [],
        sources: [{ provider: 'solana-rpc', status: 'ok' }],
      },
    };

    render(<RiskInlineAlert risk={risk} />);

    expect(screen.queryByText('Riesgo bajo · 4/100')).not.toBeNull();
    expect(screen.queryByText('Cuenta consultada en Solana RPC.')).not.toBeNull();
  });
});

describe('swap guard explanation rendering', () => {
  it('renders swap warning explanation when available and preserves fallback without it', () => {
    const warning: SwapGuardWarningData = {
      code: 'price_deviation_warning',
      message: 'El precio está fuera del rango recomendado.',
      deviation_bps: 850,
      explanation: baseExplanation,
    };

    const { rerender } = render(<SwapGuardWarning warning={warning} />);

    expect(screen.queryByText('El precio cotizado se aleja del precio de referencia.')).not.toBeNull();
    expect(screen.queryByText(/Precio poco favorable/)).toBeNull();

    rerender(<SwapGuardWarning warning={{ ...warning, explanation: undefined }} />);

    expect(screen.queryByText('Precio poco favorable (8.5% desviación)')).not.toBeNull();
    expect(screen.queryByText('El precio está fuera del rango recomendado.')).not.toBeNull();
  });

  it('renders bypass explanation above the protected-vs-unprotected action copy', () => {
    const guardRejection: GuardRejection = {
      reason: 'price_deviation_rejected',
      deviation_bps: 1250,
      max_allowed_bps: 500,
      oracle_price_usd: 150,
      quoted_price_usd: 169,
      can_bypass: true,
      warning_message: 'Podés cancelar o ejecutar sin protección de precio.',
      explanation: { ...baseExplanation, decision: 'REJECT', severity: 'critical', summary: 'El guard de precio bloqueó este swap.' },
    };

    render(<SwapGuardBypassWarning guardRejection={guardRejection} />);

    expect(screen.queryByText('El guard de precio bloqueó este swap.')).not.toBeNull();
    expect(screen.queryByText('Ejecutar sin protección')).not.toBeNull();
    expect(screen.queryByText(/máximo permitido: 5.0%/)).not.toBeNull();
  });
});
