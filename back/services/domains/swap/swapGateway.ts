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
	SWAP_FAIL_CLOSED_REASONS,
	type EvaluateSwapGatewayInput,
	type SwapGatewayDecisionMetadata,
	type SwapGatewayEvaluation,
	type SwapGatewayGate,
} from "./swapGatewayContracts";

const SWAP_ACTION_KIND = "swap";

export async function evaluateSwapGateway(
	input: EvaluateSwapGatewayInput,
): Promise<SwapGatewayEvaluation> {
	debug("gateway", "swap", "Evaluating swap gateway", {
		inputToken: input.inputToken,
		outputToken: input.outputToken,
		inputAmount: input.inputAmount,
	});
	const policy = input.policy ?? loadDefaultPolicy();
	const toolName = input.toolName ?? SWAP_ACTION_KIND;
	const classification = classifyToolCall({ toolName, mutates: true });
	const quote = await safeQuoteUsd(input);
	const policyContext = deriveSwapPolicyContext(input, quote);
	const candidate = createActionCandidate({
		id: input.id,
		chain: "solana",
		network: input.network,
		toolName,
		actionKind: SWAP_ACTION_KIND,
		actorWallet: input.actorWallet,
		createdAt: input.createdAt,
		params: {
			inputToken: input.inputToken,
			outputToken: input.outputToken,
			inputAmount: input.inputAmount,
			slippageBps: input.slippageBps,
			protocol: input.protocol,
			tokenMint: input.tokenMint,
		},
		evidence: {
			quoteSource: quote?.source,
			tokenKnown: input.tokenKnown,
		},
	});
	const policyEvaluation = evaluateAction({
		candidate,
		classification,
		context: policyContext,
		policy,
	});
	const gate = gateSwapPolicyDecision(policyEvaluation);
	const evaluatedAt = input.createdAt ?? new Date().toISOString();
	const metadata = buildSwapGatewayDecisionMetadata({
		candidateId: candidate.id,
		candidate,
		policyContext,
		policyEvaluation,
		classificationReasonCodes: classification.reasonCodes,
		evaluatedAt,
	});

	getPostHogClient().capture({
		distinctId: input.actorWallet ?? getInstallationDistinctId(),
		event: "swap_evaluated",
		properties: {
			tool_name: toolName,
			network: input.network,
			decision: policyEvaluation.decision,
			proposal_eligible: gate.proposalEligible,
			requires_approval_card: gate.requiresApprovalCard,
			input_token: input.inputToken,
			output_token: input.outputToken,
			input_amount: input.inputAmount,
			amount_usd: policyContext.amount_usd,
			slippage_bps: input.slippageBps,
			protocol: input.protocol,
			token_known: input.tokenKnown,
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

export function gateSwapPolicyDecision(
	policyEvaluation: PolicyEvaluation,
): SwapGatewayGate {
	switch (policyEvaluation.decision) {
		case COMPASS_DECISIONS.ALLOW:
		case COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL:
			return { proposalEligible: true, requiresApprovalCard: true };
		case COMPASS_DECISIONS.DENY:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason: SWAP_FAIL_CLOSED_REASONS.POLICY_DENIED,
			};
		case COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason:
					SWAP_FAIL_CLOSED_REASONS.POLICY_REQUIRES_ADDITIONAL_CONTEXT,
			};
		case COMPASS_DECISIONS.REQUIRE_SIMULATION:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason: SWAP_FAIL_CLOSED_REASONS.POLICY_REQUIRES_SIMULATION,
			};
		case COMPASS_DECISIONS.REQUIRE_POLICY_UPDATE:
			return {
				proposalEligible: false,
				requiresApprovalCard: false,
				failClosedReason:
					SWAP_FAIL_CLOSED_REASONS.POLICY_REQUIRES_POLICY_UPDATE,
			};
	}
}

function deriveSwapPolicyContext(
	input: EvaluateSwapGatewayInput,
	quote: Awaited<ReturnType<typeof safeQuoteUsd>>,
): PolicyEvaluationContext {
	const context: PolicyEvaluationContext = {};

	const amountUsd = quote?.amountUsd ?? usdAmountFromStableInput(input);
	if (typeof amountUsd === "number" && Number.isFinite(amountUsd)) {
		context.amount_usd = amountUsd;
	}

	if (typeof input.slippageBps === "number") {
		context.slippage_bps = input.slippageBps;
	}

	if (typeof input.protocol === "string" && input.protocol.length > 0) {
		context.protocol = input.protocol;
	}

	if (typeof input.tokenKnown === "boolean") {
		context.token_known = input.tokenKnown;
	}

	if (typeof input.tokenMint === "string" && input.tokenMint.length > 0) {
		context.token_mint = input.tokenMint;
	}

	return context;
}

async function safeQuoteUsd(input: EvaluateSwapGatewayInput) {
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

function usdAmountFromStableInput(
	input: EvaluateSwapGatewayInput,
): number | undefined {
	return input.inputToken.toUpperCase() === "USDC" ? input.inputAmount : undefined;
}

function buildSwapGatewayDecisionMetadata(input: {
	candidateId: string;
	candidate: unknown;
	policyContext: PolicyEvaluationContext;
	policyEvaluation: PolicyEvaluation;
	classificationReasonCodes: string[];
	evaluatedAt: string;
}): SwapGatewayDecisionMetadata {
	return {
		candidateId: input.candidateId,
		candidateFingerprint: fingerprintSwapCandidateWithoutEvidence(
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

function fingerprintSwapCandidateWithoutEvidence(candidate: unknown): string {
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
