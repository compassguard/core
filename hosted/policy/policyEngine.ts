import {
	COMPASS_DECISIONS,
	TOOL_RISK_CLASSES,
} from "@shared/executionGatewayContracts";
import { debug } from "@back/guardrail/debugLogger";
import {
	decisionFromOutcome as decision,
	isNonNegativeFiniteNumber,
	policyResult as result,
} from "@back/guardrail/policy/policyEvaluationResult";
import {
	POLICY_OUTCOMES,
	POLICY_REASON_CODES,
	type EvaluateActionInput,
	type PolicyEvaluation,
} from "@shared/policyContracts";

const SIGN_MESSAGE_TOOL = "sign_message";
const SIGN_TRANSACTION_TOOL = "sign_transaction";
const SIGN_AND_SEND_TRANSACTION_TOOL = "sign_and_send_transaction";

function isPositiveFiniteNumber(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

export function evaluateAction(input: EvaluateActionInput): PolicyEvaluation {
	const { candidate, classification, policy } = input;
	debug("policy", "evaluateAction", "Evaluating action", {
		toolName: candidate.toolName,
		riskClass: classification.riskClass,
	});

	const signingDecision = evaluateSigning(input);
	if (signingDecision) {
		return signingDecision;
	}

	if (classification.defaultDecision === COMPASS_DECISIONS.DENY) {
		return preserveDeniedClassification(input);
	}

	const blockedDecision = evaluateBlockedFlags(input);
	if (blockedDecision) {
		return blockedDecision;
	}

	if (classification.riskClass === TOOL_RISK_CLASSES.READ_ONLY) {
		return decision(
			input,
			policy.read_only.default,
			[POLICY_REASON_CODES.READ_ONLY_BY_POLICY],
			["read_only.default"],
		);
	}

	if (classification.riskClass === TOOL_RISK_CLASSES.BLOCKED_UNKNOWN) {
		return decision(
			input,
			POLICY_OUTCOMES.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.UNKNOWN_TOOL_NEEDS_CONTEXT],
			["classification.default_decision"],
		);
	}

	if (candidate.actionKind === "transfer") {
		debug("policy", "evaluateAction", "Evaluating transfer policy", {
			actionKind: candidate.actionKind,
		});
		return evaluateTransfer(input);
	}

	if (candidate.actionKind === "swap") {
		debug("policy", "evaluateAction", "Evaluating swap policy", {
			actionKind: candidate.actionKind,
		});
		return evaluateSwap(input);
	}

	if (candidate.actionKind === "conditional_buy") {
		debug("policy", "evaluateAction", "Evaluating conditional buy policy", {
			actionKind: candidate.actionKind,
		});
		return evaluateConditionalBuy(input);
	}

	debug("policy", "evaluateAction", "Falling back to default policy decision", {
		actionKind: candidate.actionKind,
	});
	return decision(
		input,
		policy.default,
		[POLICY_REASON_CODES.POLICY_DEFAULT],
		["policy.default"],
	);
}

function evaluateBlockedFlags(
	input: EvaluateActionInput,
): PolicyEvaluation | undefined {
	const { context, policy } = input;
	const flags = context.flags;

	if (flags?.unlimited_delegate) {
		return decision(
			input,
			policy.blocked.unlimited_delegate,
			[POLICY_REASON_CODES.BLOCKED_UNLIMITED_DELEGATE],
			["blocked.unlimited_delegate"],
		);
	}

	if (flags?.authority_change) {
		return decision(
			input,
			policy.blocked.authority_change,
			[POLICY_REASON_CODES.BLOCKED_AUTHORITY_CHANGE],
			["blocked.authority_change"],
		);
	}

	if (flags?.suspicious_recipient) {
		return decision(
			input,
			policy.blocked.suspicious_recipient,
			[POLICY_REASON_CODES.BLOCKED_SUSPICIOUS_RECIPIENT],
			["blocked.suspicious_recipient"],
		);
	}

	if (flags?.unknown_program) {
		return decision(
			input,
			policy.blocked.unknown_program,
			[POLICY_REASON_CODES.BLOCKED_UNKNOWN_PROGRAM],
			["blocked.unknown_program"],
		);
	}

	return undefined;
}

function evaluateSigning(
	input: EvaluateActionInput,
): PolicyEvaluation | undefined {
	const { candidate, context, policy } = input;

	if (candidate.toolName === SIGN_AND_SEND_TRANSACTION_TOOL) {
		if (context.compass_built !== true) {
			return result(
				input,
				COMPASS_DECISIONS.DENY,
				[POLICY_REASON_CODES.DIRECT_SIGN_AND_SEND_BLOCKED],
				["signing.sign_and_send_transaction"],
			);
		}

		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			[POLICY_REASON_CODES.SIGN_AND_SEND_COMPASS_BUILT_REQUIRES_APPROVAL],
			["signing.sign_and_send_transaction"],
		);
	}

	if (candidate.toolName === SIGN_TRANSACTION_TOOL) {
		return decision(
			input,
			policy.signing.sign_transaction,
			[POLICY_REASON_CODES.SIGN_TRANSACTION_REQUIRES_SIMULATION],
			["signing.sign_transaction"],
		);
	}

	if (candidate.toolName === SIGN_MESSAGE_TOOL) {
		return decision(
			input,
			policy.signing.sign_message,
			[POLICY_REASON_CODES.SIGN_MESSAGE_REQUIRES_APPROVAL],
			["signing.sign_message"],
		);
	}

	return undefined;
}

function preserveDeniedClassification(
	input: EvaluateActionInput,
): PolicyEvaluation {
	const { classification } = input;
	const reasonCodes = classification.reasonCodes.includes(
		"UNKNOWN_MUTATING_TOOL",
	)
		? [POLICY_REASON_CODES.UNKNOWN_MUTATING_TOOL_DENIED]
		: [
				POLICY_REASON_CODES.CLASSIFICATION_DECISION_PRESERVED,
				...classification.reasonCodes,
			];

	return result(input, COMPASS_DECISIONS.DENY, reasonCodes, [
		"classification.default_decision",
	]);
}

function evaluateTransfer(input: EvaluateActionInput): PolicyEvaluation {
	const { context, policy } = input;
	const transferPolicy = policy.transfers;

	if (
		context.recipient_address &&
		transferPolicy.blocked_recipients.includes(context.recipient_address)
	) {
		return result(
			input,
			COMPASS_DECISIONS.DENY,
			[POLICY_REASON_CODES.TRANSFER_BLOCKED_RECIPIENT],
			["transfers.blocked_recipients"],
		);
	}

	if (typeof context.amount_usd !== "number") {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.TRANSFER_MISSING_AMOUNT],
			["transfers.max_usd_without_approval"],
		);
	}

	if (!isNonNegativeFiniteNumber(context.amount_usd)) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.TRANSFER_INVALID_AMOUNT],
			["transfers.max_usd_without_approval"],
		);
	}

	if (
		typeof context.recipient_address !== "string" ||
		context.recipient_address.length === 0 ||
		typeof context.recipient_known !== "boolean"
	) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.TRANSFER_MISSING_RECIPIENT],
			["transfers.recipient_evidence"],
		);
	}

	if (context.amount_usd > transferPolicy.max_usd_without_approval) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			[POLICY_REASON_CODES.TRANSFER_EXCEEDS_LIMIT],
			["transfers.max_usd_without_approval"],
		);
	}

	if (
		transferPolicy.require_approval_for_unknown_recipient &&
		context.recipient_known === false
	) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			[POLICY_REASON_CODES.TRANSFER_UNKNOWN_RECIPIENT],
			["transfers.require_approval_for_unknown_recipient"],
		);
	}

	return result(
		input,
		COMPASS_DECISIONS.ALLOW,
		[POLICY_REASON_CODES.TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT],
		[
			"transfers.max_usd_without_approval",
			"transfers.require_approval_for_unknown_recipient",
		],
	);
}

function evaluateSwap(input: EvaluateActionInput): PolicyEvaluation {
	const { context, policy } = input;
	const swapPolicy = policy.swaps;

	if (
		typeof context.amount_usd !== "number" ||
		typeof context.token_known !== "boolean" ||
		typeof context.protocol !== "string" ||
		typeof context.slippage_bps !== "number"
	) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.SWAP_MISSING_CONTEXT],
			["swaps.required_context"],
		);
	}

	if (
		!isNonNegativeFiniteNumber(context.amount_usd) ||
		!isPositiveFiniteNumber(context.slippage_bps)
	) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.SWAP_INVALID_CONTEXT],
			["swaps.required_context"],
		);
	}

	if (!swapPolicy.allowed_protocols.includes(context.protocol)) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			[POLICY_REASON_CODES.SWAP_UNALLOWED_PROTOCOL],
			["swaps.allowed_protocols"],
		);
	}

	if (context.amount_usd > swapPolicy.max_usd_without_approval) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			[POLICY_REASON_CODES.SWAP_EXCEEDS_LIMIT],
			["swaps.max_usd_without_approval"],
		);
	}

	if (context.slippage_bps > swapPolicy.max_slippage_bps) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			[POLICY_REASON_CODES.SWAP_SLIPPAGE_EXCEEDS_LIMIT],
			["swaps.max_slippage_bps"],
		);
	}

	if (swapPolicy.require_approval_for_unknown_token && !context.token_known) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			[POLICY_REASON_CODES.SWAP_UNKNOWN_TOKEN],
			["swaps.require_approval_for_unknown_token"],
		);
	}

	return result(
		input,
		COMPASS_DECISIONS.ALLOW,
		[POLICY_REASON_CODES.SWAP_WITHIN_POLICY],
		[
			"swaps.max_usd_without_approval",
			"swaps.max_slippage_bps",
			"swaps.require_approval_for_unknown_token",
			"swaps.allowed_protocols",
		],
	);
}

function evaluateConditionalBuy(input: EvaluateActionInput): PolicyEvaluation {
	const { context, policy } = input;
	const conditionalPolicy = policy.conditional_buys;

	if (
		typeof context.target_price_usd !== "number" ||
		typeof context.oracle_age_seconds !== "number" ||
		typeof context.oracle_confidence_bps !== "number" ||
		typeof context.expires_at_unix !== "number" ||
		typeof context.current_unix_timestamp !== "number" ||
		typeof context.slippage_bps !== "number"
	) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.CONDITIONAL_MISSING_CONTEXT],
			["conditional_buys.required_context"],
		);
	}

	if (
		!isPositiveFiniteNumber(context.target_price_usd) ||
		!isNonNegativeFiniteNumber(context.oracle_age_seconds) ||
		!isNonNegativeFiniteNumber(context.oracle_confidence_bps) ||
		!isNonNegativeFiniteNumber(context.slippage_bps)
	) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.CONDITIONAL_INVALID_CONTEXT],
			["conditional_buys.required_context"],
		);
	}

	if (context.current_unix_timestamp > context.expires_at_unix) {
		return result(
			input,
			COMPASS_DECISIONS.DENY,
			[POLICY_REASON_CODES.CONDITIONAL_EXPIRED],
			["conditional_buys.expires_at_unix"],
		);
	}

	if (context.oracle_age_seconds > conditionalPolicy.max_oracle_age_seconds) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.CONDITIONAL_ORACLE_UNSAFE],
			["conditional_buys.max_oracle_age_seconds"],
		);
	}

	if (context.oracle_confidence_bps > conditionalPolicy.max_confidence_bps) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			[POLICY_REASON_CODES.CONDITIONAL_ORACLE_UNSAFE],
			["conditional_buys.max_confidence_bps"],
		);
	}

	if (context.slippage_bps > conditionalPolicy.max_slippage_bps) {
		return result(
			input,
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			[POLICY_REASON_CODES.CONDITIONAL_SLIPPAGE_EXCEEDS_LIMIT],
			["conditional_buys.max_slippage_bps"],
		);
	}

	return decision(
		input,
		conditionalPolicy.default,
		[POLICY_REASON_CODES.CONDITIONAL_DEFAULT_REQUIRES_APPROVAL],
		["conditional_buys.default"],
	);
}
