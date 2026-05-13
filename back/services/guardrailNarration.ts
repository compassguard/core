import { callAzureResponses, type ResponsesApiResponse } from './azureResponsesClient';
import type { GuardrailExplanation, GuardrailNarration } from './guardrailExplanations';

const DEFAULT_TIMEOUT_MS = 2500;
const FORBIDDEN_MUTATION_KEYS = new Set([
  'decision',
  'severity',
  'score',
  'requiresExtraConfirmation',
  'requires_extra_confirmation',
  'suggested_user_action',
]);

type NarrationProviderInput = {
  input: string;
  instructions: string;
  maxOutputTokens: number;
};

export type GuardrailNarrationProvider = (input: NarrationProviderInput) => Promise<string>;

type BuildGuardrailNarrationOptions = {
  enabled?: boolean;
  timeoutMs?: number;
  provider?: GuardrailNarrationProvider;
};

function isNarrationEnabled(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return process.env.GUARDRAIL_NARRATION_ENABLED === 'true';
}

function sanitizeExplanationForNarration(explanation: GuardrailExplanation) {
  return {
    id: explanation.id,
    action_type: explanation.action_type,
    decision: explanation.decision,
    severity: explanation.severity,
    category: explanation.category,
    summary: explanation.summary,
    impact: explanation.impact,
    reason_codes: explanation.reason_codes,
    reasons: explanation.reasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
      category: reason.category,
      source: reason.source,
      severity: reason.severity,
    })),
    checks: explanation.checks.map((check) => ({
      check: check.check,
      label: check.label,
      status: check.status,
      source: check.source,
    })),
    sources: explanation.sources.map((source) => ({
      provider: source.provider,
      status: source.status,
    })),
    suggested_user_action: explanation.suggested_user_action,
  };
}

function extractAzureText(response: ResponsesApiResponse): string {
  return response.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function defaultNarrationProvider(input: NarrationProviderInput): Promise<string> {
  const response = await callAzureResponses(input);
  return extractAzureText(response);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error('guardrail_narration_timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error) => {
        clearTimeout(handle);
        reject(error);
      },
    );
  });
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseStrictJsonObject(raw: string): unknown | null {
  try {
    const parsed = JSON.parse(stripJsonFence(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function containsForbiddenMutationKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenMutationKeys);

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_MUTATION_KEYS.has(key)) return true;
    if (containsForbiddenMutationKeys(nested)) return true;
  }
  return false;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSubset(values: string[], allowed: Set<string>): boolean {
  return values.every((value) => allowed.has(value));
}

export function validateGuardrailNarrationOutput(
  raw: string,
  explanation: GuardrailExplanation,
): GuardrailNarration | undefined {
  const parsed = parseStrictJsonObject(raw);
  if (!parsed || containsForbiddenMutationKeys(parsed)) return undefined;

  const value = parsed as Record<string, unknown>;
  if (!hasOnlyKeys(value, ['summary', 'bullets', 'based_on'])) return undefined;
  if (typeof value.summary !== 'string' || !value.summary.trim()) return undefined;
  if (value.bullets !== undefined && !isStringArray(value.bullets)) return undefined;
  if (!value.based_on || typeof value.based_on !== 'object' || Array.isArray(value.based_on)) return undefined;

  const basedOn = value.based_on as Record<string, unknown>;
  if (!hasOnlyKeys(basedOn, ['explanation_id', 'reason_codes', 'checks', 'sources'])) return undefined;
  if (basedOn.explanation_id !== explanation.id) return undefined;
  if (!isStringArray(basedOn.reason_codes) || !isStringArray(basedOn.checks) || !isStringArray(basedOn.sources)) return undefined;

  const allowedReasonCodes = new Set(explanation.reason_codes);
  const allowedChecks = new Set(explanation.checks.map((check) => check.check));
  const allowedSources = new Set(explanation.sources.map((source) => source.provider));

  if (!isSubset(basedOn.reason_codes, allowedReasonCodes)) return undefined;
  if (!isSubset(basedOn.checks, allowedChecks)) return undefined;
  if (!isSubset(basedOn.sources, allowedSources)) return undefined;

  const bullets = isStringArray(value.bullets) ? value.bullets.map((bullet) => bullet.trim()).filter(Boolean) : undefined;

  return {
    summary: value.summary.trim(),
    bullets,
    based_on: {
      explanation_id: explanation.id,
      reason_codes: basedOn.reason_codes,
      checks: basedOn.checks,
      sources: basedOn.sources,
    },
  };
}

export async function buildGuardrailNarration(
  explanation: GuardrailExplanation,
  options: BuildGuardrailNarrationOptions = {},
): Promise<GuardrailNarration | undefined> {
  if (!isNarrationEnabled(options.enabled)) return undefined;

  const provider = options.provider ?? defaultNarrationProvider;
  const input = JSON.stringify(sanitizeExplanationForNarration(explanation));
  const instructions = [
    'You write short Spanish UX micro-explanations for Solana guardrail decisions.',
    'Use only the structured JSON input. Do not infer or add new facts.',
    'Return strict JSON only with keys: summary, bullets, based_on.',
    'based_on must reference only existing explanation_id, reason_codes, checks, and sources from the input.',
    'Do not include or modify decision, severity, score, requiresExtraConfirmation, or suggested_user_action.',
  ].join(' ');

  try {
    const raw = await withTimeout(
      provider({ input, instructions, maxOutputTokens: 300 }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return validateGuardrailNarrationOutput(raw, explanation);
  } catch {
    return undefined;
  }
}

export async function attachGuardrailNarration(
  explanation: GuardrailExplanation,
  options: BuildGuardrailNarrationOptions = {},
): Promise<GuardrailExplanation> {
  const narration = await buildGuardrailNarration(explanation, options);
  if (!narration) return explanation;
  return { ...explanation, narration };
}
