import { describe, expect, it } from "vitest";

import { classifyToolCall, createActionCandidate } from "@back/guardrail/execution/executionGateway";
import { loadDefaultPolicy } from "@hosted/policy/loadPolicy";
import { evaluateAction } from "@hosted/policy/policyEngine";
import type { PolicyEvaluationContext } from "@shared/policyContracts";

const policy = loadDefaultPolicy();

function evaluateTool(
	toolName: string,
	actionKind: string,
	context: PolicyEvaluationContext = {},
	mutates?: boolean,
) {
	const candidate = createActionCandidate({
		id: `${toolName}-${actionKind}`,
		chain: "solana",
		network: "devnet",
		toolName,
		actionKind,
		createdAt: "2026-06-05T00:00:00.000Z",
		params: {},
	});
	const classification = classifyToolCall({ toolName, mutates });

	return evaluateAction({ candidate, classification, context, policy });
}

function expectDecision(
	result: ReturnType<typeof evaluateTool>,
	decision: string,
	reasonCode: string,
	rule: string,
) {
	expect(result).toMatchObject({
		decision,
		policyId: "default-conservative",
	});
	expect(result.reasonCodes).toContain(reasonCode);
	expect(result.evaluatedRules).toContain(rule);
	expect(result.reasonCodes.length).toBeGreaterThan(0);
	expect(result.evaluatedRules.length).toBeGreaterThan(0);
}

describe("policy engine", () => {
	it("allows read-only tools by policy", () => {
		const result = evaluateTool("get_wallet_holdings", "read_balance");

		expectDecision(result, "ALLOW", "READ_ONLY_BY_POLICY", "read_only.default");
	});

	it("allows transfers within the autonomous limit to known recipients", () => {
		const result = evaluateTool("transfer_sol", "transfer", {
			amount_usd: 10,
			recipient_address: "known_safe_address",
			recipient_known: true,
		});

		expectDecision(
			result,
			"ALLOW",
			"TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT",
			"transfers.max_usd_without_approval",
		);
	});

	it("requires approval for transfers to unknown recipients", () => {
		const result = evaluateTool("transfer_sol", "transfer", {
			amount_usd: 5,
			recipient_address: "unknown_address",
			recipient_known: false,
		});

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"TRANSFER_UNKNOWN_RECIPIENT",
			"transfers.require_approval_for_unknown_recipient",
		);
	});

	it("requires approval for transfers above the autonomous limit", () => {
		const result = evaluateTool("transfer_sol", "transfer", {
			amount_usd: 10.01,
			recipient_address: "known_safe_address",
			recipient_known: true,
		});

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"TRANSFER_EXCEEDS_LIMIT",
			"transfers.max_usd_without_approval",
		);
	});

	it("denies transfers to blocked recipients", () => {
		const result = evaluateTool("transfer_sol", "transfer", {
			amount_usd: 1,
			recipient_address: "known_bad_address",
			recipient_known: true,
		});

		expectDecision(
			result,
			"DENY",
			"TRANSFER_BLOCKED_RECIPIENT",
			"transfers.blocked_recipients",
		);
	});

	it("fails closed when transfer amount evidence is missing", () => {
		const result = evaluateTool("transfer_sol", "transfer", {
			recipient_address: "known_safe_address",
			recipient_known: true,
		});

		expectDecision(
			result,
			"REQUIRE_ADDITIONAL_CONTEXT",
			"TRANSFER_MISSING_AMOUNT",
			"transfers.max_usd_without_approval",
		);
	});

	it.each([
		["missing recipient address", { amount_usd: 1, recipient_known: true }],
		[
			"missing recipient known evidence",
			{ amount_usd: 1, recipient_address: "known_safe_address" },
		],
	] as const)("fails closed when transfer has %s", (_name, context) => {
		const result = evaluateTool("transfer_sol", "transfer", context);

		expectDecision(
			result,
			"REQUIRE_ADDITIONAL_CONTEXT",
			"TRANSFER_MISSING_RECIPIENT",
			"transfers.recipient_evidence",
		);
	});

	it.each([
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["negative", -1],
	] as const)("fails closed when transfer amount is %s", (_name, amountUsd) => {
		const result = evaluateTool("transfer_sol", "transfer", {
			amount_usd: amountUsd,
			recipient_address: "known_safe_address",
			recipient_known: true,
		});

		expectDecision(
			result,
			"REQUIRE_ADDITIONAL_CONTEXT",
			"TRANSFER_INVALID_AMOUNT",
			"transfers.max_usd_without_approval",
		);
	});

	it("allows safe allowlisted swaps within limits", () => {
		const result = evaluateTool("orca_swap", "swap", {
			amount_usd: 25,
			protocol: "Orca",
			slippage_bps: 300,
			token_known: true,
		});

		expectDecision(
			result,
			"ALLOW",
			"SWAP_WITHIN_POLICY",
			"swaps.allowed_protocols",
		);
	});

	it("requires approval for high slippage swaps", () => {
		const result = evaluateTool("orca_swap", "swap", {
			amount_usd: 5,
			protocol: "Orca",
			slippage_bps: 301,
			token_known: true,
		});

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"SWAP_SLIPPAGE_EXCEEDS_LIMIT",
			"swaps.max_slippage_bps",
		);
	});

	it("requires approval for unknown swap tokens", () => {
		const result = evaluateTool("orca_swap", "swap", {
			amount_usd: 5,
			protocol: "Orca",
			slippage_bps: 100,
			token_known: false,
		});

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"SWAP_UNKNOWN_TOKEN",
			"swaps.require_approval_for_unknown_token",
		);
	});

	it("requires approval for unallowlisted swap protocols", () => {
		const result = evaluateTool("orca_swap", "swap", {
			amount_usd: 5,
			protocol: "UnknownDex",
			slippage_bps: 100,
			token_known: true,
		});

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"SWAP_UNALLOWED_PROTOCOL",
			"swaps.allowed_protocols",
		);
	});

	it("requires approval for swaps above the autonomous limit", () => {
		const result = evaluateTool("orca_swap", "swap", {
			amount_usd: 25.01,
			protocol: "Orca",
			slippage_bps: 100,
			token_known: true,
		});

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"SWAP_EXCEEDS_LIMIT",
			"swaps.max_usd_without_approval",
		);
	});

	it("requires approval by default for valid conditional SOL buy creation", () => {
		const now = 1_780_966_400;
		const result = evaluateTool("conditional_buy_sol", "conditional_buy", {
			amount_usd: 50,
			target_price_usd: 130,
			slippage_bps: 100,
			oracle_feed_pubkey: "pyth-sol-usd-devnet",
			oracle_price_usd: 135,
			oracle_age_seconds: 15,
			max_oracle_age_seconds: 60,
			oracle_confidence_bps: 25,
			max_confidence_bps: 100,
			recipient_address: "known_safe_address",
			expires_at_unix: now + 3600,
			current_unix_timestamp: now,
		});

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"CONDITIONAL_DEFAULT_REQUIRES_APPROVAL",
			"conditional_buys.default",
		);
	});

	it("fails closed when conditional SOL buy context is incomplete", () => {
		const result = evaluateTool("conditional_buy_sol", "conditional_buy", {
			amount_usd: 50,
			target_price_usd: 130,
		});

		expectDecision(
			result,
			"REQUIRE_ADDITIONAL_CONTEXT",
			"CONDITIONAL_MISSING_CONTEXT",
			"conditional_buys.required_context",
		);
	});

	it("denies expired conditional SOL buy orders", () => {
		const now = 1_780_966_400;
		const result = evaluateTool("conditional_buy_sol", "conditional_buy", {
			amount_usd: 50,
			target_price_usd: 130,
			slippage_bps: 100,
			oracle_feed_pubkey: "pyth-sol-usd-devnet",
			oracle_price_usd: 135,
			oracle_age_seconds: 15,
			max_oracle_age_seconds: 60,
			oracle_confidence_bps: 25,
			max_confidence_bps: 100,
			recipient_address: "known_safe_address",
			expires_at_unix: now - 1,
			current_unix_timestamp: now,
		});

		expectDecision(
			result,
			"DENY",
			"CONDITIONAL_EXPIRED",
			"conditional_buys.expires_at_unix",
		);
	});

	it("fails closed when swap context is incomplete", () => {
		const result = evaluateTool("orca_swap", "swap", {
			amount_usd: 5,
			token_known: true,
		});

		expectDecision(
			result,
			"REQUIRE_ADDITIONAL_CONTEXT",
			"SWAP_MISSING_CONTEXT",
			"swaps.required_context",
		);
	});

	it.each([
		[
			"NaN amount",
			{ amount_usd: Number.NaN, protocol: "Orca", slippage_bps: 100 },
		],
		[
			"infinite amount",
			{
				amount_usd: Number.POSITIVE_INFINITY,
				protocol: "Orca",
				slippage_bps: 100,
			},
		],
		[
			"negative amount",
			{ amount_usd: -1, protocol: "Orca", slippage_bps: 100 },
		],
		[
			"NaN slippage",
			{ amount_usd: 1, protocol: "Orca", slippage_bps: Number.NaN },
		],
		[
			"infinite slippage",
			{
				amount_usd: 1,
				protocol: "Orca",
				slippage_bps: Number.POSITIVE_INFINITY,
			},
		],
		[
			"negative slippage",
			{ amount_usd: 1, protocol: "Orca", slippage_bps: -1 },
		],
	] as const)("fails closed when swap has %s", (_name, context) => {
		const result = evaluateTool("orca_swap", "swap", {
			...context,
			token_known: true,
		});

		expectDecision(
			result,
			"REQUIRE_ADDITIONAL_CONTEXT",
			"SWAP_INVALID_CONTEXT",
			"swaps.required_context",
		);
	});

	it("requires approval for sign_message", () => {
		const result = evaluateTool("sign_message", "sign_message");

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"SIGN_MESSAGE_REQUIRES_APPROVAL",
			"signing.sign_message",
		);
	});

	it("requires simulation for sign_transaction", () => {
		const result = evaluateTool("sign_transaction", "sign_transaction");

		expectDecision(
			result,
			"REQUIRE_SIMULATION",
			"SIGN_TRANSACTION_REQUIRES_SIMULATION",
			"signing.sign_transaction",
		);
	});

	it("denies direct sign_and_send_transaction without Compass-built evidence", () => {
		const result = evaluateTool(
			"sign_and_send_transaction",
			"sign_and_send_transaction",
			{ compass_built: false },
		);

		expectDecision(
			result,
			"DENY",
			"DIRECT_SIGN_AND_SEND_BLOCKED",
			"signing.sign_and_send_transaction",
		);
	});

	it("requires approval for Compass-built sign_and_send_transaction", () => {
		const result = evaluateTool(
			"sign_and_send_transaction",
			"sign_and_send_transaction",
			{ compass_built: true },
		);

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"SIGN_AND_SEND_COMPASS_BUILT_REQUIRES_APPROVAL",
			"signing.sign_and_send_transaction",
		);
	});

	it.each([
		["unlimited_delegate", "BLOCKED_UNLIMITED_DELEGATE"],
		["authority_change", "BLOCKED_AUTHORITY_CHANGE"],
		["suspicious_recipient", "BLOCKED_SUSPICIOUS_RECIPIENT"],
	] as const)("denies blocked flag %s", (flagName, reasonCode) => {
		const result = evaluateTool("transfer_sol", "transfer", {
			amount_usd: 1,
			recipient_address: "known_safe_address",
			recipient_known: true,
			flags: { [flagName]: true },
		});

		expectDecision(result, "DENY", reasonCode, `blocked.${flagName}`);
	});

	it("requires approval for unknown program flags", () => {
		const result = evaluateTool("transfer_sol", "transfer", {
			amount_usd: 1,
			recipient_address: "known_safe_address",
			recipient_known: true,
			flags: { unknown_program: true },
		});

		expectDecision(
			result,
			"REQUIRE_HUMAN_APPROVAL",
			"BLOCKED_UNKNOWN_PROGRAM",
			"blocked.unknown_program",
		);
	});

	it("inherits DENY for unknown mutating tools from Wave 1", () => {
		const result = evaluateTool(
			"mystery_transfer",
			"transfer",
			{ amount_usd: 1, recipient_known: true },
			true,
		);

		expectDecision(
			result,
			"DENY",
			"UNKNOWN_MUTATING_TOOL_DENIED",
			"classification.default_decision",
		);
	});

	it("requires additional context for unknown non-mutating tools", () => {
		const result = evaluateTool("mystery_read", "unknown");

		expectDecision(
			result,
			"REQUIRE_ADDITIONAL_CONTEXT",
			"UNKNOWN_TOOL_NEEDS_CONTEXT",
			"classification.default_decision",
		);
	});

	it.each([
		"transfer",
		"swap",
	] as const)("does not upgrade unknown non-mutating %s action candidates", (actionKind) => {
		const result = evaluateTool(`mystery_${actionKind}`, actionKind, {
			amount_usd: 1,
			recipient_address: "known_safe_address",
			recipient_known: true,
			protocol: "Orca",
			slippage_bps: 100,
			token_known: true,
		});

		expectDecision(
			result,
			"REQUIRE_ADDITIONAL_CONTEXT",
			"UNKNOWN_TOOL_NEEDS_CONTEXT",
			"classification.default_decision",
		);
	});
});
