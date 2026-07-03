import { describe, expect, it } from "vitest";

import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import { loadDefaultPolicy } from "@hosted/policy/loadPolicy";
import type { EvaluateConditionalGatewayInput } from "../domains/conditional-parking-lot/conditionalGatewayContracts";
import { POLICY_REASON_CODES } from "@shared/policyContracts";

const policy = loadDefaultPolicy();
const actorWallet = "11111111111111111111111111111111";
const createdAt = "2026-06-09T00:00:00.000Z";
const currentUnixTimestamp = 1_780_966_400;

async function loadConditionalGateway() {
	try {
		return await import("../domains/conditional-parking-lot/conditionalGateway");
	} catch (error) {
		throw new Error(
			`Wave 5b conditionalGateway implementation is missing or not loadable: ${String(error)}`,
		);
	}
}

async function loadConditionalGatewayContracts() {
	try {
		return await import("../domains/conditional-parking-lot/conditionalGatewayContracts");
	} catch (error) {
		throw new Error(
			`Wave 5b conditionalGatewayContracts implementation is missing or not loadable: ${String(error)}`,
		);
	}
}

function baseConditionalInput(
	overrides: Partial<EvaluateConditionalGatewayInput> = {},
): EvaluateConditionalGatewayInput {
	return {
		id: "conditional-candidate-1",
		network: "devnet",
		toolName: "conditional_buy_sol",
		actorWallet,
		inputToken: "USDC",
		inputAmountUsdc: 50,
		targetPriceUsd: 130,
		maxSlippageBps: 100,
		oracleFeedPubkey: "pyth-sol-usd-devnet",
		oraclePriceUsd: 135,
		oracleAgeSeconds: 15,
		maxOracleAgeSeconds: 60,
		oracleConfidenceBps: 25,
		maxConfidenceBps: 100,
		recipient: actorWallet,
		expiresAtUnix: currentUnixTimestamp + 3600,
		currentUnixTimestamp,
		createdAt,
		policy,
		...overrides,
	};
}

describe("Wave 5b conditional gateway", () => {
	it("exposes separated contracts/constants from behavior", async () => {
		const contracts = await loadConditionalGatewayContracts();
		const gateway = await loadConditionalGateway();

		expect(contracts.CONDITIONAL_FAIL_CLOSED_REASONS).toMatchObject({
			POLICY_DENIED: "policy_denied",
			POLICY_REQUIRES_ADDITIONAL_CONTEXT:
				"policy_requires_additional_context",
		});
		expect(gateway.evaluateConditionalGateway).toEqual(expect.any(Function));
	});

	it("requires human approval by default for valid conditional SOL buy creation", async () => {
		const { evaluateConditionalGateway } = await loadConditionalGateway();

		const result = await evaluateConditionalGateway(baseConditionalInput());

		expect(result.classification).toMatchObject({
			toolName: "conditional_buy_sol",
			riskClass: "SENSITIVE_EXECUTION",
			defaultDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
		});
		expect(result.candidate).toMatchObject({
			id: "conditional-candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "conditional_buy_sol",
			actionKind: "conditional_buy",
			actorWallet,
			paramsSummary: {
				inputToken: "USDC",
				inputAmountUsdc: 50,
				targetPriceUsd: 130,
				maxSlippageBps: 100,
				oracleFeedPubkey: "pyth-sol-usd-devnet",
				recipient: actorWallet,
				expiresAtUnix: currentUnixTimestamp + 3600,
			},
		});
		expect(result.policyContext).toMatchObject({
			amount_usd: 50,
			target_price_usd: 130,
			slippage_bps: 100,
			oracle_feed_pubkey: "pyth-sol-usd-devnet",
			oracle_price_usd: 135,
			oracle_age_seconds: 15,
			max_oracle_age_seconds: 60,
			oracle_confidence_bps: 25,
			max_confidence_bps: 100,
			recipient_address: actorWallet,
			expires_at_unix: currentUnixTimestamp + 3600,
			current_unix_timestamp: currentUnixTimestamp,
		});
		expect(result.policyEvaluation).toMatchObject({
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			policyId: "default-conservative",
		});
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.CONDITIONAL_DEFAULT_REQUIRES_APPROVAL,
		);
		expect(result.proposalEligible).toBe(true);
		expect(result.requiresApprovalCard).toBe(true);
		expect(result.metadata.candidateFingerprint).toEqual(expect.any(String));
		expect(result.metadata.contextFingerprint).toEqual(expect.any(String));
	});

	it("fails closed when oracle, target, amount, expiry, or slippage evidence is missing", async () => {
		const { evaluateConditionalGateway } = await loadConditionalGateway();

		const result = await evaluateConditionalGateway(
			baseConditionalInput({
				inputAmountUsdc: undefined,
				targetPriceUsd: undefined,
				maxSlippageBps: undefined,
				oracleFeedPubkey: undefined,
				expiresAtUnix: undefined,
			}),
		);

		expect(result.policyEvaluation.decision).toBe(
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
		);
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.CONDITIONAL_MISSING_CONTEXT,
		);
		expect(result.proposalEligible).toBe(false);
		expect(result.requiresApprovalCard).toBe(false);
		expect(result.failClosedReason).toBe("policy_requires_additional_context");
	});

	it("denies expired conditional orders fail-closed", async () => {
		const { evaluateConditionalGateway } = await loadConditionalGateway();

		const result = await evaluateConditionalGateway(
			baseConditionalInput({ expiresAtUnix: currentUnixTimestamp - 1 }),
		);

		expect(result.policyEvaluation.decision).toBe(COMPASS_DECISIONS.DENY);
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.CONDITIONAL_EXPIRED,
		);
		expect(result.proposalEligible).toBe(false);
		expect(result.requiresApprovalCard).toBe(false);
		expect(result.failClosedReason).toBe("policy_denied");
	});

	it("requires additional context for stale oracle or unsafe confidence evidence", async () => {
		const { evaluateConditionalGateway } = await loadConditionalGateway();

		const result = await evaluateConditionalGateway(
			baseConditionalInput({ oracleAgeSeconds: 61, oracleConfidenceBps: 101 }),
		);

		expect(result.policyEvaluation.decision).toBe(
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
		);
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.CONDITIONAL_ORACLE_UNSAFE,
		);
		expect(result.proposalEligible).toBe(false);
	});

});
