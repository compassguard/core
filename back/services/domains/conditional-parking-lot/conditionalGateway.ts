import { createHash } from "node:crypto";

import { debug } from "@back/guardrail/debugLogger";
import { getPostHogClient, getInstallationDistinctId } from "@back/posthog/posthogClient";
import {
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
	CONDITIONAL_FAIL_CLOSED_REASONS,
	type ConditionalGatewayDecisionMetadata,
	type ConditionalGatewayEvaluation,
	type ConditionalGatewayGate,
	type EvaluateConditionalGatewayInput,
} from "./conditionalGatewayContracts";

const CONDITIONAL_ACTION_KIND = "conditional_buy";
const CONDITIONAL_TOOL_NAME = "conditional_buy_sol";

export async function evaluateConditionalGateway(
	input: EvaluateConditionalGatewayInput,
): Promise<ConditionalGatewayEvaluation> {
	debug("gateway", "conditional", "Evaluating conditional gateway", {
		inputToken: input.inputToken,
		inputAmountUsdc: input.inputAmountUsdc,
		targetPriceUsd: input.targetPriceUsd,
	});
	const policy = input.policy ?? loadDefaultPolicy();
	const toolName = input.toolName ?? CONDITIONAL_TOOL_NAME;
	const classification = classifyToolCall({ toolName, mutates: true });
	const policyContext = deriveConditionalPolicyContext(input);
	const candidate = createActionCandidate({
		id: input.id,
		chain: "solana",
		network: input.network,
		toolName,
		actionKind: CONDITIONAL_ACTION_KIND,
		actorWallet: input.actorWallet,
		createdAt: input.createdAt,
		params: {
			inputToken: input.inputToken,
			inputAmountUsdc: input.inputAmountUsdc,
			targetPriceUsd: input.targetPriceUsd,
			desiredSolLamports: input.desiredSolLamports,
			maxSlippageBps: input.maxSlippageBps,
			oracleFeedPubkey: input.oracleFeedPubkey,
			recipient: input.recipient,
			expiresAtUnix: input.expiresAtUnix,
		},
		evidence: {
			oraclePriceUsd: input.oraclePriceUsd,
			oracleAgeSeconds: input.oracleAgeSeconds,
			maxOracleAgeSeconds: input.maxOracleAgeSeconds,
			oracleConfidenceBps: input.oracleConfidenceBps,
			maxConfidenceBps: input.maxConfidenceBps,
		},
	});
	const policyEvaluation = evaluateAction({
		candidate,
		classification,
		context: policyContext,
		policy,
	});
	const gate = gateConditionalPolicyDecision(policyEvaluation);
	const evaluatedAt = input.createdAt ?? new Date().toISOString();
	const metadata = buildConditionalGatewayDecisionMetadata({
		candidateId: candidate.id,
		candidate,
		policyContext,
		policyEvaluation,
		classificationReasonCodes: classification.reasonCodes,
		evaluatedAt,
	});

	getPostHogClient().capture({
		distinctId: input.actorWallet ?? getInstallationDistinctId(),
		event: "conditional_buy_evaluated",
		properties: {
			tool_name: toolName,
			network: input.network,
			decision: policyEvaluation.decision,
			proposal_eligible: gate.proposalEligible,
			requires_approval_card: gate.requiresApprovalCard,
			input_token: input.inputToken,
			input_amount_usdc: input.inputAmountUsdc,
			target_price_usd: input.targetPriceUsd,
			max_slippage_bps: input.maxSlippageBps,
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

export function gateConditionalPolicyDecision(
	policyEvaluation: PolicyEvaluation,
): ConditionalGatewayGate {
	switch (policyEvaluation.decision) {
		case COMPASS_DECISIONS.ALLOW:
		case COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL:
			return { proposalEligible: true, requiresApprovalCard: true };
		case COMPASS_DECISIONS.DENY:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason: CONDITIONAL_FAIL_CLOSED_REASONS.POLICY_DENIED,
			};
		case COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason:
					CONDITIONAL_FAIL_CLOSED_REASONS.POLICY_REQUIRES_ADDITIONAL_CONTEXT,
			};
		case COMPASS_DECISIONS.REQUIRE_SIMULATION:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason:
					CONDITIONAL_FAIL_CLOSED_REASONS.POLICY_REQUIRES_SIMULATION,
			};
		case COMPASS_DECISIONS.REQUIRE_POLICY_UPDATE:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason:
					CONDITIONAL_FAIL_CLOSED_REASONS.POLICY_REQUIRES_POLICY_UPDATE,
			};
	}
}

function deriveConditionalPolicyContext(
	input: EvaluateConditionalGatewayInput,
): PolicyEvaluationContext {
	const context: PolicyEvaluationContext = {};

	assignFiniteNumber(context, "amount_usd", input.inputAmountUsdc);
	assignFiniteNumber(context, "target_price_usd", input.targetPriceUsd);
	assignFiniteNumber(context, "slippage_bps", input.maxSlippageBps);
	assignString(context, "oracle_feed_pubkey", input.oracleFeedPubkey);
	assignFiniteNumber(context, "oracle_price_usd", input.oraclePriceUsd);
	assignFiniteNumber(context, "oracle_age_seconds", input.oracleAgeSeconds);
	assignFiniteNumber(
		context,
		"max_oracle_age_seconds",
		input.maxOracleAgeSeconds,
	);
	assignFiniteNumber(
		context,
		"oracle_confidence_bps",
		input.oracleConfidenceBps,
	);
	assignFiniteNumber(context, "max_confidence_bps", input.maxConfidenceBps);
	assignString(context, "recipient_address", input.recipient);
	assignFiniteNumber(context, "expires_at_unix", input.expiresAtUnix);
	assignFiniteNumber(
		context,
		"current_unix_timestamp",
		input.currentUnixTimestamp ??
			unixTimestampFromIso(input.createdAt) ??
			Math.floor(Date.now() / 1000),
	);

	return context;
}

function assignFiniteNumber(
	context: PolicyEvaluationContext,
	key: keyof PolicyEvaluationContext,
	value: unknown,
): void {
	if (typeof value === "number" && Number.isFinite(value)) {
		(context as Record<string, unknown>)[key] = value;
	}
}

function assignString(
	context: PolicyEvaluationContext,
	key: keyof PolicyEvaluationContext,
	value: unknown,
): void {
	if (typeof value === "string" && value.length > 0) {
		(context as Record<string, unknown>)[key] = value;
	}
}

function unixTimestampFromIso(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : undefined;
}

function buildConditionalGatewayDecisionMetadata(input: {
	candidateId: string;
	candidate: unknown;
	policyContext: PolicyEvaluationContext;
	policyEvaluation: PolicyEvaluation;
	classificationReasonCodes: string[];
	evaluatedAt: string;
}): ConditionalGatewayDecisionMetadata {
	return {
		candidateId: input.candidateId,
		candidateFingerprint: fingerprintConditionalCandidateWithoutEvidence(
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

function fingerprintConditionalCandidateWithoutEvidence(
	candidate: unknown,
): string {
	if (isPlainRecord(candidate)) {
		const candidateWithoutEvidence = { ...candidate };
		delete candidateWithoutEvidence.evidence;
		return fingerprint(candidateWithoutEvidence);
	}

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
