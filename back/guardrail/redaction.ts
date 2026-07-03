/**
 * Shared sensitive-key redaction for audit, logging, and LLM sanitization.
 *
 * Used by executionGateway (audit events), debugLogger (file logs), and
 * llmDecisionSanitizer (LLM input). Single source of truth.
 */

const SENSITIVE_KEY_PATTERN =
	/(private.*key|secret|password|mnemonic|seed|api.*key|authorization|cookie|jwt|session.*token|auth.*token|access.*token|refresh.*token|prompt|raw.*prompt|raw.*user.*prompt)/i;

export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [key, redactValue(key, value)]),
	);
}

function redactValue(key: string, value: unknown): unknown {
	if (SENSITIVE_KEY_PATTERN.test(key)) {
		return "[REDACTED]";
	}

	if (Array.isArray(value)) {
		return value.map((item) => redactUnknown(item));
	}

	if (isPlainRecord(value)) {
		return redactRecord(value);
	}

	return value;
}

function redactUnknown(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => redactUnknown(item));
	}

	if (isPlainRecord(value)) {
		return redactRecord(value);
	}

	return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
