import { describe, expect, it, vi } from 'vitest';
import { attachGuardrailNarration, buildGuardrailNarration, validateGuardrailNarrationOutput, type GuardrailNarrationProvider } from '../guardrailNarration';
import type { GuardrailExplanation } from '../guardrailExplanations';

const explanation: GuardrailExplanation = {
  id: 'exp-123',
  action_type: 'swap',
  decision: 'WARN',
  severity: 'warning',
  category: 'price_or_execution_risk',
  summary: 'El swap está permitido, pero el precio se aleja del oráculo.',
  impact: 'Podrías recibir menos valor del esperado.',
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
      check: 'swap_price_deviation',
      label: 'Comparación contra oráculo',
      status: 'warn',
      source: 'oracle',
      evidence: { deviation_bps: 850 },
    },
  ],
  sources: [{ provider: 'pyth_oracle', status: 'ok', checked_at: '2026-05-13T12:00:00.000Z' }],
  suggested_user_action: 'review_price',
  technical_details: { action_hash: 'hash-not-for-narration' },
  created_at: '2026-05-13T12:00:00.000Z',
};

const validNarration = JSON.stringify({
  summary: 'El precio se alejó del oráculo, por eso conviene revisar antes de firmar.',
  bullets: ['La comparación contra Pyth salió con advertencia.'],
  based_on: {
    explanation_id: 'exp-123',
    reason_codes: ['price_deviation_warning'],
    checks: ['swap_price_deviation'],
    sources: ['pyth_oracle'],
  },
});

describe('guardrail narration validation', () => {
  it('accepts strict JSON tied to the original explanation', () => {
    const narration = validateGuardrailNarrationOutput(validNarration, explanation);

    expect(narration?.summary).toContain('conviene revisar');
    expect(narration?.based_on.explanation_id).toBe(explanation.id);
    expect(narration?.based_on.reason_codes).toEqual(['price_deviation_warning']);
  });

  it('rejects output that invents reason codes, checks, or sources', () => {
    const invented = JSON.stringify({
      summary: 'Hay una señal nueva.',
      based_on: {
        explanation_id: 'exp-123',
        reason_codes: ['invented_code'],
        checks: ['swap_price_deviation'],
        sources: ['pyth_oracle'],
      },
    });

    expect(validateGuardrailNarrationOutput(invented, explanation)).toBeUndefined();

    const inventedCheck = JSON.stringify({
      summary: 'Hay un chequeo nuevo.',
      based_on: {
        explanation_id: 'exp-123',
        reason_codes: ['price_deviation_warning'],
        checks: ['new_check'],
        sources: ['pyth_oracle'],
      },
    });

    expect(validateGuardrailNarrationOutput(inventedCheck, explanation)).toBeUndefined();
  });

  it('rejects output that tries to modify official decision fields', () => {
    const mutating = JSON.stringify({
      summary: 'Ahora está permitido.',
      decision: 'ALLOW',
      based_on: {
        explanation_id: 'exp-123',
        reason_codes: ['price_deviation_warning'],
        checks: ['swap_price_deviation'],
        sources: ['pyth_oracle'],
      },
    });

    expect(validateGuardrailNarrationOutput(mutating, explanation)).toBeUndefined();
  });
});

describe('buildGuardrailNarration', () => {
  it('is disabled by default and does not call the provider', async () => {
    const provider = vi.fn(async () => validNarration);

    await expect(buildGuardrailNarration(explanation, { provider })).resolves.toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
  });

  it('sends only sanitized explanation data to the provider when enabled', async () => {
    let providerInput = '';
    const provider: GuardrailNarrationProvider = vi.fn(async (input) => {
      providerInput = input.input;
      return validNarration;
    });

    const narration = await buildGuardrailNarration(explanation, { enabled: true, provider });

    expect(narration?.based_on.explanation_id).toBe('exp-123');
    expect(providerInput).toContain('price_deviation_warning');
    expect(providerInput).not.toContain('hash-not-for-narration');
    expect(providerInput).not.toContain('rawUserMessage');
  });

  it('returns undefined when provider fails or times out', async () => {
    await expect(
      buildGuardrailNarration(explanation, {
        enabled: true,
        provider: async () => {
          throw new Error('provider_down');
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      buildGuardrailNarration(explanation, {
        enabled: true,
        timeoutMs: 1,
        provider: () => new Promise((resolve) => setTimeout(() => resolve(validNarration), 20)),
      }),
    ).resolves.toBeUndefined();
  });

  it('attaches valid narration without mutating the original explanation', async () => {
    const withNarration = await attachGuardrailNarration(explanation, {
      enabled: true,
      provider: async () => validNarration,
    });

    expect(withNarration.narration?.summary).toContain('conviene revisar');
    expect(explanation.narration).toBeUndefined();
  });
});
