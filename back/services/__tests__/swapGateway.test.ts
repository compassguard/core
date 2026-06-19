import { describe, expect, it } from "vitest";

import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import { loadDefaultPolicy } from "@hosted/policy/loadPolicy";
import { POLICY_REASON_CODES } from "@shared/policyContracts";

const policy = loadDefaultPolicy();
const actorWallet = "11111111111111111111111111111111";

async function loadSwapGateway() {
	try {
		return await import("../domains/swap/swapGateway");
	} catch (error) {
		throw new Error(
			`Wave 5a swapGateway implementation is missing or not loadable: ${String(error)}`,
		);
	}
}

async function loadSwapGatewayContracts() {
	try {
		return await import("../domains/swap/swapGatewayContracts");
	} catch (error) {
		throw new Error(
			`Wave 5a swapGatewayContracts implementation is missing or not loadable: ${String(error)}`,
		);
	}
}

function baseSwapInput(overrides: Record<string, unknown> = {}) {
	return {
		id: "swap-candidate-1",
		network: "devnet",
		toolName: "swap",
		actorWallet,
		inputToken: "SOL",
		outputToken: "USDC",
		inputAmount: 0.1,
		slippageBps: 100,
		protocol: "Orca",
		tokenKnown: true,
		tokenMint: "usdc-mint",
		createdAt: "2026-06-08T00:00:00.000Z",
		quoteUsd: async () => ({ amountUsd: 15, source: "unit-test-sol-usd" }),
		policy,
		...overrides,
	};
}

describe("Wave 5a swap gateway", () => {
	it("exposes separated contracts/constants from behavior", async () => {
		const contracts = await loadSwapGatewayContracts();
		const gateway = await loadSwapGateway();

		expect(contracts.SWAP_FAIL_CLOSED_REASONS).toMatchObject({
			POLICY_DENIED: "policy_denied",
			POLICY_REQUIRES_ADDITIONAL_CONTEXT: "policy_requires_additional_context",
		});
		expect(gateway.evaluateSwapGateway).toEqual(expect.any(Function));
	});

	it("allows known SOL/USDC swaps within amount, slippage, and protocol policy", async () => {
		const { evaluateSwapGateway } = await loadSwapGateway();

		const result = await evaluateSwapGateway(baseSwapInput());

		expect(result.classification).toMatchObject({
			toolName: "swap",
			riskClass: "SENSITIVE_EXECUTION",
			defaultDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
		});
		expect(result.candidate).toMatchObject({
			id: "swap-candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "swap",
			actionKind: "swap",
			actorWallet,
			paramsSummary: {
				inputToken: "SOL",
				outputToken: "USDC",
				inputAmount: 0.1,
				slippageBps: 100,
				protocol: "Orca",
				tokenMint: "usdc-mint",
			},
		});
		expect(result.policyContext).toMatchObject({
			amount_usd: 15,
			slippage_bps: 100,
			protocol: "Orca",
			token_known: true,
			token_mint: "usdc-mint",
		});
		expect(result.policyEvaluation).toMatchObject({
			decision: COMPASS_DECISIONS.ALLOW,
			policyId: "default-conservative",
		});
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.SWAP_WITHIN_POLICY,
		);
		expect(result.proposalEligible).toBe(true);
		expect(result.requiresApprovalCard).toBe(true);
		expect(result.metadata.candidateFingerprint).toEqual(expect.any(String));
		expect(result.metadata.contextFingerprint).toEqual(expect.any(String));
	});

	it("requires human approval for high slippage", async () => {
		const { evaluateSwapGateway } = await loadSwapGateway();

		const result = await evaluateSwapGateway(
			baseSwapInput({ slippageBps: 500 }),
		);

		expect(result.policyEvaluation.decision).toBe(
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
		);
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.SWAP_SLIPPAGE_EXCEEDS_LIMIT,
		);
		expect(result.proposalEligible).toBe(true);
		expect(result.requiresApprovalCard).toBe(true);
	});

	it("requires human approval for unknown output tokens", async () => {
		const { evaluateSwapGateway } = await loadSwapGateway();

		const result = await evaluateSwapGateway(
			baseSwapInput({ outputToken: "BONK", tokenKnown: false, tokenMint: "bonk-mint" }),
		);

		expect(result.policyEvaluation.decision).toBe(
			COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
		);
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.SWAP_UNKNOWN_TOKEN,
		);
	});

	it("fails closed with REQUIRE_ADDITIONAL_CONTEXT when required swap evidence is missing", async () => {
		const { evaluateSwapGateway } = await loadSwapGateway();

		const result = await evaluateSwapGateway(
			baseSwapInput({ slippageBps: undefined, protocol: undefined }),
		);

		expect(result.policyEvaluation.decision).toBe(
			COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
		);
		expect(result.policyEvaluation.reasonCodes).toContain(
			POLICY_REASON_CODES.SWAP_MISSING_CONTEXT,
		);
		expect(result.proposalEligible).toBe(false);
		expect(result.requiresApprovalCard).toBe(false);
		expect(result.failClosedReason).toBe("policy_requires_additional_context");
	});

});
