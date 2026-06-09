import { randomUUID } from "node:crypto";

import {
	COMPASS_DECISIONS,
	TOOL_RISK_CLASSES,
	type ActionCandidate,
	type ActionCandidateInput,
	type AuditEvent,
	type AuditEventInput,
	type ToolClassification,
	type ToolClassificationInput,
} from "./executionGatewayContracts";

const READ_ONLY_TOOLS = new Set(["get_wallet_holdings", "get_usdc_sol_quote"]);
const PREPARATION_SIMULATION_TOOLS = new Set([
	"quote_swap",
	"simulate_transaction",
	"decode_transaction",
	"simulate_conditional_buy_oracle_check",
]);
const SENSITIVE_EXECUTION_TOOLS = new Set([
	"transfer_sol",
	"transfer",
	"guarded_transfer",
	"orca_swap",
	"swap",
	"conditional_buy_sol",
]);
const SIGNING_TOOLS = new Set([
	"sign_transaction",
	"sign_and_send_transaction",
]);

const SENSITIVE_KEY_PATTERN =
	/(private.*key|secret|password|mnemonic|seed|api.*key|authorization|cookie|jwt|session.*token|auth.*token|access.*token|refresh.*token|prompt|raw.*prompt|raw.*user.*prompt)/i;

export function classifyToolCall(
	input: ToolClassificationInput,
): ToolClassification {
	const toolName = input.toolName;

	if (READ_ONLY_TOOLS.has(toolName)) {
		return {
			toolName,
			riskClass: TOOL_RISK_CLASSES.READ_ONLY,
			defaultDecision: COMPASS_DECISIONS.ALLOW,
			auditRequired: true,
			reasonCodes: ["KNOWN_READ_ONLY_TOOL"],
		};
	}

	if (PREPARATION_SIMULATION_TOOLS.has(toolName)) {
		return {
			toolName,
			riskClass: TOOL_RISK_CLASSES.PREPARATION_SIMULATION,
			defaultDecision: COMPASS_DECISIONS.ALLOW,
			auditRequired: true,
			reasonCodes: ["KNOWN_PREPARATION_SIMULATION_TOOL"],
		};
	}

	if (SIGNING_TOOLS.has(toolName)) {
		return {
			toolName,
			riskClass: TOOL_RISK_CLASSES.SIGNING,
			defaultDecision: COMPASS_DECISIONS.DENY,
			auditRequired: true,
			reasonCodes:
				toolName === "sign_and_send_transaction"
					? ["DIRECT_SIGN_AND_SEND_BLOCKED"]
					: ["DIRECT_SIGNING_TOOL"],
		};
	}

	if (SENSITIVE_EXECUTION_TOOLS.has(toolName)) {
		return {
			toolName,
			riskClass: TOOL_RISK_CLASSES.SENSITIVE_EXECUTION,
			defaultDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			auditRequired: true,
			reasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
		};
	}

	if (input.mutates) {
		return {
			toolName,
			riskClass: TOOL_RISK_CLASSES.BLOCKED_UNKNOWN,
			defaultDecision: COMPASS_DECISIONS.DENY,
			auditRequired: true,
			reasonCodes: ["UNKNOWN_MUTATING_TOOL"],
		};
	}

	return {
		toolName,
		riskClass: TOOL_RISK_CLASSES.BLOCKED_UNKNOWN,
		defaultDecision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
		auditRequired: true,
		reasonCodes: ["UNKNOWN_TOOL_REQUIRES_CONTEXT"],
	};
}

export function createActionCandidate(
	input: ActionCandidateInput,
): ActionCandidate {
	return {
		id: input.id ?? randomUUID(),
		chain: input.chain,
		network: input.network,
		toolName: input.toolName,
		actionKind: input.actionKind,
		actorWallet: input.actorWallet,
		createdAt: input.createdAt ?? new Date().toISOString(),
		paramsSummary: redactRecord(input.params ?? {}),
		evidence: input.evidence ? redactRecord(input.evidence) : undefined,
	};
}

export function buildAuditEvent(input: AuditEventInput): AuditEvent {
	const candidate = input.candidate;

	return {
		id: input.id ?? randomUUID(),
		occurredAt: input.occurredAt ?? new Date().toISOString(),
		candidateId: candidate.id,
		chain: candidate.chain,
		network: candidate.network,
		toolName: candidate.toolName,
		actionKind: candidate.actionKind,
		actorWallet: candidate.actorWallet,
		riskClass: input.classification.riskClass,
		policyId: input.policyId,
		decision: input.decision,
		riskScore: input.riskScore,
		approvalStatus: input.approvalStatus,
		transactionSignature: input.transactionSignature,
		result: input.result,
		reasonCodes: input.classification.reasonCodes,
		metadata: redactRecord(input.metadata ?? {}),
	};
}

function redactRecord(
	record: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [
			key,
			redactValue(key, value),
		]),
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
