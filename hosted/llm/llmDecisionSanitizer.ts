import {
	LLM_MAX_VALUE_LENGTH,
	LLM_REDACTED,
	LLM_SENSITIVE_KEY_PATTERNS,
	LLM_TRUNCATED,
	type LlmJudgeInput,
} from "@shared/llmDecisionContracts";
import type { CompassDecision } from "@shared/executionGatewayContracts";

export type SanitizeLlmInputParams = {
	toolName: string;
	actionKind: string;
	network?: string;
	deterministicDecision: CompassDecision;
	riskClass: string;
	reasonCodes: string[];
	policyId?: string;
	evaluatedRules?: string[];
	rawContext?: Record<string, unknown>;
};

export function sanitizeLlmJudgeInput(
	params: SanitizeLlmInputParams,
): LlmJudgeInput {
	const sanitizedContext = params.rawContext
		? sanitizeObject(params.rawContext, 0)
		: undefined;

	return {
		toolName: params.toolName,
		actionKind: params.actionKind,
		network: params.network ?? "unknown",
		deterministicDecision: params.deterministicDecision,
		riskClass: params.riskClass,
		reasonCodes: params.reasonCodes,
		policyId: params.policyId,
		evaluatedRules: params.evaluatedRules,
		...(sanitizedContext ? { sanitizedContext } : {}),
		sanitized: true,
	};
}

function isSensitiveKey(key: string): boolean {
	const lowerKey = key.toLowerCase();
	return LLM_SENSITIVE_KEY_PATTERNS.some((pattern) =>
		lowerKey.includes(pattern.toLowerCase()),
	);
}

function sanitizeValue(value: unknown, depth: number): unknown {
	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === "string") {
		return value.length > LLM_MAX_VALUE_LENGTH
			? `${value.slice(0, LLM_MAX_VALUE_LENGTH)}${LLM_TRUNCATED}`
			: value;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}

	if (Array.isArray(value)) {
		return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
	}

	if (typeof value === "object") {
		return sanitizeObject(value as Record<string, unknown>, depth + 1);
	}

	return LLM_REDACTED;
}

function sanitizeObject(
	obj: Record<string, unknown>,
	depth: number,
): Record<string, unknown> {
	if (depth > 4) {
		return { _truncated: LLM_TRUNCATED };
	}

	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(obj)) {
		if (isSensitiveKey(key)) {
			result[key] = LLM_REDACTED;
			continue;
		}

		if (
			value instanceof Uint8Array ||
			(typeof Buffer !== "undefined" && Buffer.isBuffer(value)) ||
			value instanceof ArrayBuffer
		) {
			result[key] = LLM_REDACTED;
			continue;
		}

		result[key] = sanitizeValue(value, depth);
	}

	return result;
}
