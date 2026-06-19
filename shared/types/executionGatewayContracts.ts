export const COMPASS_DECISIONS = {
	ALLOW: "ALLOW",
	DENY: "DENY",
	REQUIRE_HUMAN_APPROVAL: "REQUIRE_HUMAN_APPROVAL",
	REQUIRE_SIMULATION: "REQUIRE_SIMULATION",
	REQUIRE_POLICY_UPDATE: "REQUIRE_POLICY_UPDATE",
	REQUIRE_ADDITIONAL_CONTEXT: "REQUIRE_ADDITIONAL_CONTEXT",
} as const;

export type CompassDecision =
	(typeof COMPASS_DECISIONS)[keyof typeof COMPASS_DECISIONS];

export const TOOL_RISK_CLASSES = {
	READ_ONLY: "READ_ONLY",
	PREPARATION_SIMULATION: "PREPARATION_SIMULATION",
	SENSITIVE_EXECUTION: "SENSITIVE_EXECUTION",
	SIGNING: "SIGNING",
	BLOCKED_UNKNOWN: "BLOCKED_UNKNOWN",
} as const;

export type ToolRiskClass =
	(typeof TOOL_RISK_CLASSES)[keyof typeof TOOL_RISK_CLASSES];

export type ToolClassificationInput = {
	toolName: string;
	mutates?: boolean;
};

export type ToolClassification = {
	toolName: string;
	riskClass: ToolRiskClass;
	defaultDecision: CompassDecision;
	auditRequired: boolean;
	reasonCodes: string[];
};

export type ActionCandidateInput = {
	id?: string;
	chain: "solana";
	network: string;
	toolName: string;
	actionKind: string;
	actorWallet?: string;
	createdAt?: string;
	params?: Record<string, unknown>;
	evidence?: Record<string, unknown>;
};

export type ActionCandidate = {
	id: string;
	chain: "solana";
	network: string;
	toolName: string;
	actionKind: string;
	actorWallet?: string;
	createdAt: string;
	paramsSummary: Record<string, unknown>;
	evidence?: Record<string, unknown>;
};

export type AuditEventInput = {
	id?: string;
	occurredAt?: string;
	candidate: ActionCandidate;
	classification: ToolClassification;
	policyId?: string;
	decision: CompassDecision;
	riskScore?: number;
	approvalStatus?: "not_required" | "pending" | "approved" | "rejected";
	transactionSignature?: string;
	result?: "pending" | "success" | "failed" | "denied";
	metadata?: Record<string, unknown>;
};

export type AuditEvent = {
	id: string;
	occurredAt: string;
	candidateId: string;
	chain: "solana";
	network: string;
	toolName: string;
	actionKind: string;
	actorWallet?: string;
	riskClass: ToolRiskClass;
	policyId?: string;
	decision: CompassDecision;
	riskScore?: number;
	approvalStatus?: "not_required" | "pending" | "approved" | "rejected";
	transactionSignature?: string;
	result?: "pending" | "success" | "failed" | "denied";
	reasonCodes: string[];
	metadata: Record<string, unknown>;
};
