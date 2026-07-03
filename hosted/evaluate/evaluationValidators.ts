import {
	HOSTED_DECISIONS,
	HOSTED_RISK_LEVELS,
	LOCAL_FINDING_SEVERITIES,
	isHostedDecision,
	isHostedRiskLevel,
	type EvaluateActionAgentContext,
	type EvaluateActionRequest,
	type EvaluateActionRequestValidationResult,
	type HostedDecision,
	type HostedRiskLevel,
	type LocalFinding,
	type LocalFindingSeverity,
} from "@shared/evaluationContracts";

export { isHostedDecision, isHostedRiskLevel };

export function validateEvaluateActionRequest(
	value: unknown,
): EvaluateActionRequestValidationResult {
	if (!isRecord(value)) {
		return { ok: false, message: "Request body must be a JSON object." };
	}

	if (!isNonEmptyString(value.correlationId)) {
		return { ok: false, message: "correlationId is required." };
	}

	if (!isNonEmptyString(value.idempotencyKey)) {
		return { ok: false, message: "idempotencyKey is required." };
	}

	if (!isNonEmptyString(value.toolName)) {
		return { ok: false, message: "toolName is required." };
	}

	if (!Array.isArray(value.localFindings)) {
		return { ok: false, message: "localFindings must be an array." };
	}

	for (const finding of value.localFindings) {
		if (
			!isRecord(finding) ||
			!isNonEmptyString(finding.code) ||
			!isLocalFindingSeverity(finding.severity) ||
			!isNonEmptyString(finding.message)
		) {
			return { ok: false, message: "localFindings entries are invalid." };
		}
	}

	if (!isNonEmptyString(value.requestedAt)) {
		return { ok: false, message: "requestedAt is required." };
	}

	if (value.arguments !== undefined && !isRecord(value.arguments)) {
		return { ok: false, message: "arguments must be an object when provided." };
	}

	if (value.agentContext !== undefined && !isRecord(value.agentContext)) {
		return { ok: false, message: "agentContext must be an object when provided." };
	}

	return {
		ok: true,
		request: {
			correlationId: value.correlationId,
			idempotencyKey: value.idempotencyKey,
			toolName: value.toolName,
			arguments: value.arguments as Record<string, unknown> | undefined,
			agentContext: value.agentContext as
				| EvaluateActionAgentContext
				| undefined,
			localFindings: value.localFindings as LocalFinding[],
			requestedAt: value.requestedAt,
			userId: isNonEmptyString(value.userId) ? value.userId : undefined,
			sessionId: isNonEmptyString(value.sessionId) ? value.sessionId : undefined,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isLocalFindingSeverity(value: unknown): value is LocalFindingSeverity {
	return Object.values(LOCAL_FINDING_SEVERITIES).includes(
		value as LocalFindingSeverity,
	);
}
