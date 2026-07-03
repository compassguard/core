export const HOSTED_DECISIONS = {
	ALLOW: "allow",
	DENY: "deny",
	CONFIRM: "confirm",
} as const;

export type HostedDecision =
	(typeof HOSTED_DECISIONS)[keyof typeof HOSTED_DECISIONS];

export const HOSTED_RISK_LEVELS = {
	LOW: "low",
	MEDIUM: "medium",
	HIGH: "high",
	UNKNOWN: "unknown",
} as const;

export type HostedRiskLevel =
	(typeof HOSTED_RISK_LEVELS)[keyof typeof HOSTED_RISK_LEVELS];

export const LOCAL_FINDING_SEVERITIES = {
	INFO: "info",
	WARN: "warn",
	BLOCK: "block",
} as const;

export type LocalFindingSeverity =
	(typeof LOCAL_FINDING_SEVERITIES)[keyof typeof LOCAL_FINDING_SEVERITIES];

export const AUDIT_ENTRY_OUTCOMES = {
	SUCCESS: "success",
	FAILURE: "failure",
} as const;

export type AuditEntryOutcome =
	(typeof AUDIT_ENTRY_OUTCOMES)[keyof typeof AUDIT_ENTRY_OUTCOMES];

export type EvaluateActionAgentContext = {
	clientName?: string;
	userIntent?: string;
	sessionId?: string;
};

export type LocalFinding = {
	code: string;
	severity: LocalFindingSeverity;
	message: string;
};

export type EvaluateActionRequest = {
	correlationId: string;
	idempotencyKey: string;
	toolName: string;
	arguments?: Record<string, unknown>;
	agentContext?: EvaluateActionAgentContext;
	localFindings: LocalFinding[];
	requestedAt: string;
	/** Stable installation ID from local MCP config (used as userId for audit). */
	userId?: string;
	/** Unique session ID generated per MCP session (used for audit grouping). */
	sessionId?: string;
};

export type EvaluateActionResponse = {
	correlationId: string;
	decision: HostedDecision;
	riskLevel: HostedRiskLevel;
	reasons: string[];
	suggestedAction?: string;
	auditRef: string;
};

export type AuditEntry = {
	correlationId: string;
	auditRef: string;
	toolName: string;
	decision: HostedDecision;
	riskLevel: HostedRiskLevel;
	reasons: string[];
	outcome?: AuditEntryOutcome;
	occurredAt: string;
};

export type PolicySnapshot = {
	version: string;
	updatedAt: string;
	rules: Record<string, unknown>;
};

export type EvaluationService = {
	evaluateAction: (
		request: EvaluateActionRequest,
	) => Promise<EvaluateActionResponse>;
};

export type EvaluationServiceDependencies = {
	routeToolCall: (
		input: { toolName: string; toolParams?: Record<string, unknown> },
		config: { enabled: boolean; timeoutMs: number; provider?: string; model?: string },
		providerFn?: unknown,
	) => Promise<{
		classification: "transfer" | "swap" | "skip" | "unknown";
		reasoning: string;
		latencyMs: number;
	}>;
	callLlmJudge: (
		input: Record<string, unknown>,
		config: Record<string, unknown>,
		providerFn?: unknown,
	) => Promise<{
		decision: "ALLOW" | "DENY" | "REQUIRE_HUMAN_APPROVAL" | "REQUIRE_ADDITIONAL_CONTEXT";
		confidence: number;
		reasonCodes: string[];
		rationale: string;
	} | undefined>;
	loadPolicy: () => import("./policyContracts").CompassPolicy;
	evaluatePolicy: (
		input: import("./policyContracts").EvaluateActionInput,
	) => import("./policyContracts").PolicyEvaluation;
	writeAudit: (
		request: import("./auditContracts").AuditWriteRequest,
	) => Promise<import("./auditContracts").AuditWriteResponse>;
};

export type EvaluateActionRequestValidationResult =
	| { ok: true; request: EvaluateActionRequest }
	| { ok: false; message: string };

export function isHostedDecision(value: unknown): value is HostedDecision {
	return Object.values(HOSTED_DECISIONS).includes(value as HostedDecision);
}

export function isHostedRiskLevel(value: unknown): value is HostedRiskLevel {
	return Object.values(HOSTED_RISK_LEVELS).includes(value as HostedRiskLevel);
}
