import { randomUUID } from "node:crypto";

import type {
	EvaluateActionAgentContext,
	EvaluateActionRequest,
	LocalFinding,
} from "@shared/evaluationContracts";
import type { HostedEvaluationRequestInput } from "./mcpProxyContracts";

export type EvaluationRequestInput = HostedEvaluationRequestInput & {
	userId?: string;
	sessionId?: string;
};

export function buildEvaluateActionRequest(
	input: EvaluationRequestInput,
): EvaluateActionRequest {
	const correlationId = `corr_${randomUUID()}`;

	return {
		correlationId,
		idempotencyKey: `eval_${correlationId}`,
		toolName: normalizeToolName(input.toolName),
		arguments: normalizeArguments(input.arguments),
		agentContext: normalizeAgentContext(input.agentContext),
		localFindings: normalizeLocalFindings(input.localFindings),
		requestedAt: new Date().toISOString(),
		userId: normalizeOptionalString(input.userId),
		sessionId: normalizeOptionalString(input.sessionId),
	};
}

function normalizeToolName(toolName: string): string {
	return toolName.trim();
}

function normalizeArguments(
	argumentsValue: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!argumentsValue) {
		return undefined;
	}

	const normalizedEntries = Object.entries(argumentsValue).filter(
		([key]) => key.trim().length > 0,
	);

	return normalizedEntries.length > 0
		? Object.fromEntries(normalizedEntries)
		: undefined;
}

function normalizeAgentContext(
	agentContext: EvaluateActionAgentContext | undefined,
): EvaluateActionAgentContext | undefined {
	if (!agentContext) {
		return undefined;
	}

	const normalizedAgentContext = {
		clientName: normalizeOptionalString(agentContext.clientName),
		userIntent: normalizeOptionalString(agentContext.userIntent),
		sessionId: normalizeOptionalString(agentContext.sessionId),
	};

	return Object.values(normalizedAgentContext).some((value) => value !== undefined)
		? normalizedAgentContext
		: undefined;
}

function normalizeLocalFindings(
	localFindings: LocalFinding[] | undefined,
): LocalFinding[] {
	if (!localFindings || localFindings.length === 0) {
		return [];
	}

	return localFindings
		.map((finding) => ({
			code: finding.code.trim().toUpperCase(),
			severity: finding.severity,
			message: finding.message.trim(),
		}))
		.filter((finding) => finding.code.length > 0 && finding.message.length > 0);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalizedValue = value.trim();
	return normalizedValue.length > 0 ? normalizedValue : undefined;
}
