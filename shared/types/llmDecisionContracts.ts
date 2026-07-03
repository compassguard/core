import type { CompassDecision } from "./executionGatewayContracts";

export type LlmJudgeConfig = {
	enabled: boolean;
	provider?: string;
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	timeoutMs?: number;
};

export type LlmJudgeInput = {
	toolName: string;
	actionKind: string;
	network: string;
	deterministicDecision: CompassDecision;
	riskClass: string;
	reasonCodes: string[];
	policyId?: string;
	evaluatedRules?: string[];
	sanitizedContext?: Record<string, unknown>;
	sanitized: true;
};

export const LLM_GUARD_DECISIONS = {
	ALLOW: "ALLOW",
	DENY: "DENY",
	REQUIRE_HUMAN_APPROVAL: "REQUIRE_HUMAN_APPROVAL",
	REQUIRE_ADDITIONAL_CONTEXT: "REQUIRE_ADDITIONAL_CONTEXT",
} as const;

export type LlmGuardDecision =
	(typeof LLM_GUARD_DECISIONS)[keyof typeof LLM_GUARD_DECISIONS];

export type LlmGuardOutput = {
	decision: LlmGuardDecision;
	confidence: number;
	reasonCodes: string[];
	rationale: string;
};

export type LlmClampedDecision = {
	decision: CompassDecision;
	llmConsulted: boolean;
	llmOutput?: LlmGuardOutput;
	clamped: boolean;
	llmReasonCodes?: string[];
	llmRationale?: string;
};

export const LLM_DECISION_STRICTNESS: Record<CompassDecision, LlmGuardDecision[]> = {
	ALLOW: [
		LLM_GUARD_DECISIONS.ALLOW,
		LLM_GUARD_DECISIONS.REQUIRE_HUMAN_APPROVAL,
		LLM_GUARD_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
		LLM_GUARD_DECISIONS.DENY,
	],
	REQUIRE_HUMAN_APPROVAL: [
		LLM_GUARD_DECISIONS.REQUIRE_HUMAN_APPROVAL,
		LLM_GUARD_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
		LLM_GUARD_DECISIONS.DENY,
	],
	REQUIRE_SIMULATION: [
		LLM_GUARD_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
		LLM_GUARD_DECISIONS.DENY,
	],
	REQUIRE_POLICY_UPDATE: [
		LLM_GUARD_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
		LLM_GUARD_DECISIONS.DENY,
	],
	REQUIRE_ADDITIONAL_CONTEXT: [
		LLM_GUARD_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
		LLM_GUARD_DECISIONS.DENY,
	],
	DENY: [LLM_GUARD_DECISIONS.DENY],
};

export const LLM_REDACTED = "[REDACTED]";
export const LLM_TRUNCATED = "[TRUNCATED]";
export const LLM_MAX_VALUE_LENGTH = 256;
export const LLM_MAX_OBJECT_DEPTH = 5;

export const LLM_SENSITIVE_KEY_PATTERNS: readonly string[] = [
	"prompt",
	"secret",
	"privatekey",
	"private_key",
	"seed",
	"mnemonic",
	"rawtransaction",
	"raw_transaction",
	"unsignedversionedtransaction",
	"unsigned_versioned_transaction",
	"unsignedtransaction",
	"unsigned_transaction",
	"transactionpayload",
	"transaction_payload",
	"authorization",
	"token",
	"cookie",
	"jwt",
	"apikey",
	"api_key",
	"password",
	"credential",
	"signer",
	"keypair",
	"secretkey",
	"secret_key",
];
