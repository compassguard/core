import { createHash } from "node:crypto";

import { debug } from "@back/guardrail/debugLogger";
import { getPostHogClient, getInstallationDistinctId } from "@back/posthog/posthogClient";
import {
	buildAuditEvent,
	classifyToolCall,
	createActionCandidate,
} from "@back/guardrail/execution/executionGateway";
import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import { loadDefaultPolicy } from "@hosted/policy/loadPolicy";
import { evaluateAction } from "@hosted/policy/policyEngine";
import type {
	PolicyEvaluation,
	PolicyEvaluationContext,
} from "@shared/policyContracts";
import {
	TRANSFER_FAIL_CLOSED_REASONS,
	type BuildTransferAuditEventInput,
	type BuildTransferGatewayApprovalMetadataInput,
	type EvaluateTransferGatewayInput,
	type TransferAuditEvent,
	type TransferGatewayDecisionMetadata,
	type TransferGatewayEvaluation,
	type TransferGatewayGate,
	type TransferWalletSafetyEvidence,
	type VerifyTransferGatewayMetadataInput,
	type VerifyTransferGatewayMetadataResult,
} from "./transferGatewayContracts";

const SOL_TOKEN_SYMBOL = "SOL";
const TRANSFER_ACTION_KIND = "transfer";

export async function evaluateTransferGateway(
	input: EvaluateTransferGatewayInput,
): Promise<TransferGatewayEvaluation> {
	debug("gateway", "transfer", "Evaluating transfer gateway", {
		amountSol: input.amountSol,
		recipient: input.recipientAddress,
	});
	const policy = input.policy ?? loadDefaultPolicy();
	const toolName = input.toolName ?? "transfer";
	const classification = classifyToolCall({ toolName, mutates: true });
	const quote = await safeQuoteUsd(input);
	const policyContext = deriveTransferPolicyContext(input, quote);
	const candidate = createActionCandidate({
		id: input.id,
		chain: "solana",
		network: input.network,
		toolName,
		actionKind: TRANSFER_ACTION_KIND,
		actorWallet: input.actorWallet,
		createdAt: input.createdAt,
		params: {
			amountSol: input.amountSol,
			token: SOL_TOKEN_SYMBOL,
			recipient: input.recipientAddress,
		},
		evidence: buildTransferCandidateEvidence(input.walletSafety, quote),
	});
	const policyEvaluation = evaluateAction({
		candidate,
		classification,
		context: policyContext,
		policy,
	});
	const gate = gateTransferPolicyDecision(policyEvaluation);
	const evaluatedAt = input.createdAt ?? new Date().toISOString();
	const metadata = buildTransferGatewayDecisionMetadata({
		candidateId: candidate.id,
		candidate,
		policyContext,
		policyEvaluation,
		classificationReasonCodes: classification.reasonCodes,
		evaluatedAt,
	});

	getPostHogClient().capture({
		distinctId: input.actorWallet ?? getInstallationDistinctId(),
		event: "transfer_evaluated",
		properties: {
			tool_name: toolName,
			network: input.network,
			decision: policyEvaluation.decision,
			proposal_eligible: gate.proposalEligible,
			requires_approval_card: gate.requiresApprovalCard,
			amount_sol: input.amountSol,
			amount_usd: policyContext.amount_usd,
			reason_codes: policyEvaluation.reasonCodes,
			fail_closed_reason: "failClosedReason" in gate ? gate.failClosedReason : undefined,
		},
	});

	return {
		classification,
		candidate,
		policyContext,
		policyEvaluation,
		metadata,
		...gate,
	};
}

export function gateTransferPolicyDecision(
	policyEvaluation: PolicyEvaluation,
): TransferGatewayGate {
	switch (policyEvaluation.decision) {
		case COMPASS_DECISIONS.ALLOW:
		case COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL:
			return {
				proposalEligible: true,
				requiresApprovalCard: true,
			};
		case COMPASS_DECISIONS.DENY:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason: TRANSFER_FAIL_CLOSED_REASONS.POLICY_DENIED,
			};
		case COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason:
					TRANSFER_FAIL_CLOSED_REASONS.POLICY_REQUIRES_ADDITIONAL_CONTEXT,
			};
		case COMPASS_DECISIONS.REQUIRE_SIMULATION:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason:
					TRANSFER_FAIL_CLOSED_REASONS.POLICY_REQUIRES_SIMULATION,
			};
		case COMPASS_DECISIONS.REQUIRE_POLICY_UPDATE:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason:
					TRANSFER_FAIL_CLOSED_REASONS.POLICY_REQUIRES_POLICY_UPDATE,
			};
	}
}

function isApprovalEligibleDecision(
	decision: PolicyEvaluation["decision"],
): boolean {
	return (
		decision === COMPASS_DECISIONS.ALLOW ||
		decision === COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL
	);
}

export function buildTransferGatewayApprovalMetadata(
	input: BuildTransferGatewayApprovalMetadataInput,
): TransferGatewayDecisionMetadata {
	const toolName = input.toolName ?? "transfer";
	const classification = classifyToolCall({ toolName, mutates: true });
	const expectedPolicyId =
		input.expectedPolicyId ?? loadDefaultPolicy().policy_id;
	const approvalEligibleDecision = isApprovalEligibleDecision(
		input.stored.decision,
	)
		? input.stored.decision
		: COMPASS_DECISIONS.ALLOW;

	return {
		candidateId: input.candidateId,
		candidateFingerprint: buildTransferCandidateFingerprint({
			candidateId: input.candidateId,
			network: input.network,
			toolName,
			actorWallet: input.actorWallet,
			amountSol: input.amountSol,
			recipientAddress: input.recipientAddress,
			createdAt: input.createdAt ?? input.stored.evaluatedAt,
		}),
		policyId: expectedPolicyId,
		decision: approvalEligibleDecision,
		reasonCodes: [...input.stored.reasonCodes],
		evaluatedRules: [...input.stored.evaluatedRules],
		classificationReasonCodes: classification.reasonCodes,
		contextFingerprint: input.stored.contextFingerprint,
		evaluatedAt: input.stored.evaluatedAt,
	};
}

export function verifyTransferGatewayMetadata(
	input: VerifyTransferGatewayMetadataInput,
): VerifyTransferGatewayMetadataResult {
	if (!input.stored || !input.current) {
		return { ok: false, reason: "gateway_context_missing" };
	}

	const fieldsToCompare: (keyof TransferGatewayDecisionMetadata)[] = [
		"candidateId",
		"candidateFingerprint",
		"policyId",
		"decision",
		"reasonCodes",
		"evaluatedRules",
		"classificationReasonCodes",
		"contextFingerprint",
	];
	const mismatchedFields = fieldsToCompare.filter(
		(field) =>
			stableStringify(input.stored?.[field]) !==
			stableStringify(input.current?.[field]),
	);

	if (mismatchedFields.length > 0) {
		return {
			ok: false,
			reason: "gateway_metadata_mismatch",
			mismatchedFields,
		};
	}

	return { ok: true };
}

export function buildTransferAuditEvent(
	input: BuildTransferAuditEventInput,
): TransferAuditEvent {
	const { evaluation } = input;

	return buildAuditEvent({
		id: input.id,
		occurredAt: input.occurredAt,
		candidate: evaluation.candidate,
		classification: evaluation.classification,
		policyId: evaluation.policyEvaluation.policyId,
		decision: evaluation.policyEvaluation.decision,
		approvalStatus: input.approvalStatus,
		transactionSignature: input.transactionSignature,
		result: input.result as Parameters<typeof buildAuditEvent>[0]["result"],
		metadata: {
			...input.metadata,
			lifecycle: input.lifecycle,
			policyReasonCodes: evaluation.policyEvaluation.reasonCodes,
			evaluatedRules: evaluation.policyEvaluation.evaluatedRules,
			candidateFingerprint: evaluation.metadata.candidateFingerprint,
			contextFingerprint: evaluation.metadata.contextFingerprint,
		},
	}) as TransferAuditEvent;
}

function deriveTransferPolicyContext(
	input: EvaluateTransferGatewayInput,
	quote: Awaited<ReturnType<typeof safeQuoteUsd>>,
): PolicyEvaluationContext {
	const context: PolicyEvaluationContext = {
		recipient_address: input.recipientAddress,
	};

	if (typeof input.recipientKnown === "boolean") {
		context.recipient_known = input.recipientKnown;
	}

	if (
		typeof quote?.amountUsd === "number" &&
		Number.isFinite(quote.amountUsd)
	) {
		context.amount_usd = quote.amountUsd;
	}

	const flags = buildPolicyFlags(input.walletSafety);
	if (flags) {
		context.flags = flags;
	}

	return context;
}

async function safeQuoteUsd(input: EvaluateTransferGatewayInput) {
	if (!input.quoteUsd) {
		return undefined;
	}

	try {
		const quote = await input.quoteUsd();
		if (
			!quote ||
			typeof quote.amountUsd !== "number" ||
			!Number.isFinite(quote.amountUsd) ||
			typeof quote.source !== "string"
		) {
			return undefined;
		}

		return quote;
	} catch {
		return undefined;
	}
}

function buildTransferCandidateEvidence(
	walletSafety: TransferWalletSafetyEvidence | undefined,
	quote: Awaited<ReturnType<typeof safeQuoteUsd>>,
): Record<string, unknown> {
	return {
		quoteSource: quote?.source,
		walletSafetyStatus: walletSafety?.status,
		walletSafetyReasonCodes: walletSafety?.reasonCodes,
	};
}

function buildPolicyFlags(
	walletSafety: TransferWalletSafetyEvidence | undefined,
): PolicyEvaluationContext["flags"] | undefined {
	const flags = walletSafety?.flags;
	if (!flags) {
		return undefined;
	}

	const policyFlags = {
		unknown_program: flags.unknown_program,
		unlimited_delegate: flags.unlimited_delegate,
		authority_change: flags.authority_change,
		suspicious_recipient: flags.suspicious_recipient,
	};

	if (Object.values(policyFlags).some((value) => typeof value === "boolean")) {
		return policyFlags;
	}

	return undefined;
}

function buildTransferGatewayDecisionMetadata(input: {
	candidateId: string;
	candidate: unknown;
	policyContext: PolicyEvaluationContext;
	policyEvaluation: PolicyEvaluation;
	classificationReasonCodes: string[];
	evaluatedAt: string;
}): TransferGatewayDecisionMetadata {
	return {
		candidateId: input.candidateId,
		candidateFingerprint: fingerprintTransferCandidateWithoutEvidence(
			input.candidate,
		),
		policyId: input.policyEvaluation.policyId,
		decision: input.policyEvaluation.decision,
		reasonCodes: [...input.policyEvaluation.reasonCodes],
		evaluatedRules: [...input.policyEvaluation.evaluatedRules],
		classificationReasonCodes: [...input.classificationReasonCodes],
		contextFingerprint: fingerprint(input.policyContext),
		evaluatedAt: input.evaluatedAt,
	};
}

function fingerprintTransferCandidateWithoutEvidence(
	candidate: unknown,
): string {
	if (isPlainRecord(candidate)) {
		const candidateWithoutEvidence = { ...candidate };
		delete candidateWithoutEvidence.evidence;
		return fingerprint(candidateWithoutEvidence);
	}

	return fingerprint(candidate);
}

function buildTransferCandidateFingerprint(input: {
	candidateId: string;
	network: string;
	toolName: string;
	actorWallet?: string;
	amountSol: number;
	recipientAddress: string;
	createdAt: string;
}): string {
	const candidate = createActionCandidate({
		id: input.candidateId,
		chain: "solana",
		network: input.network,
		toolName: input.toolName,
		actionKind: TRANSFER_ACTION_KIND,
		actorWallet: input.actorWallet,
		createdAt: input.createdAt,
		params: {
			amountSol: input.amountSol,
			token: SOL_TOKEN_SYMBOL,
			recipient: input.recipientAddress,
		},
	});

	return fingerprint(candidate);
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sortForStableStringify(item));
	}

	if (isPlainRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, item]) => typeof item !== "undefined")
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, sortForStableStringify(item)]),
		);
	}

	return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
