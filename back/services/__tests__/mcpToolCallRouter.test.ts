import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConditionalGatewayEvaluation } from "../conditionalGatewayContracts";
import { COMPASS_DECISIONS } from "../executionGatewayContracts";
import type { SwapGatewayEvaluation } from "../swapGatewayContracts";
import type { TransferGatewayEvaluation } from "../transferGatewayContracts";

async function loadMcpToolCallRouter() {
	try {
		return await import("../mcp/mcpToolCallRouter");
	} catch (error) {
		throw new Error(
			`Wave 4 MCP tool call router implementation is missing or not loadable: ${String(error)}`,
		);
	}
}

async function loadMcpToolContracts() {
	try {
		return await import("../mcp/mcpToolContracts");
	} catch (error) {
		throw new Error(
			`Wave 4 MCP tool contracts implementation is missing or not loadable: ${String(error)}`,
		);
	}
}

function mockConditionalEvaluation(
	overrides: Partial<ConditionalGatewayEvaluation> = {},
): ConditionalGatewayEvaluation {
	return {
		classification: {
			toolName: "conditional_buy_sol",
			riskClass: "SENSITIVE_EXECUTION",
			defaultDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			auditRequired: true,
			reasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
		},
		candidate: {
			id: "conditional-candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "conditional_buy_sol",
			actionKind: "conditional_buy",
			actorWallet: "actor-wallet",
			createdAt: "2026-06-09T00:00:00.000Z",
			paramsSummary: {
				inputToken: "USDC",
				inputAmountUsdc: 50,
				targetPriceUsd: 130,
				maxSlippageBps: 100,
				oracleFeedPubkey: "pyth-sol-usd-devnet",
				recipient: "actor-wallet",
				expiresAtUnix: 1780970000,
			},
		},
		policyContext: {
			amount_usd: 50,
			target_price_usd: 130,
			slippage_bps: 100,
			oracle_feed_pubkey: "pyth-sol-usd-devnet",
			oracle_price_usd: 135,
			oracle_age_seconds: 15,
			max_oracle_age_seconds: 60,
			oracle_confidence_bps: 25,
			max_confidence_bps: 100,
			recipient_address: "actor-wallet",
			expires_at_unix: 1780970000,
			current_unix_timestamp: 1780966400,
		},
		policyEvaluation: {
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			policyId: "default-conservative",
			reasonCodes: ["CONDITIONAL_DEFAULT_REQUIRES_APPROVAL"],
			evaluatedRules: ["conditional_buys.default"],
		},
		metadata: {
			candidateId: "conditional-candidate-1",
			candidateFingerprint: "conditional-candidate-fingerprint",
			policyId: "default-conservative",
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			reasonCodes: ["CONDITIONAL_DEFAULT_REQUIRES_APPROVAL"],
			evaluatedRules: ["conditional_buys.default"],
			classificationReasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
			contextFingerprint: "conditional-context-fingerprint",
			evaluatedAt: "2026-06-09T00:00:00.000Z",
		},
		proposalEligible: true,
		requiresApprovalCard: true,
		...overrides,
	};
}

function mockSwapEvaluation(
	overrides: Partial<SwapGatewayEvaluation> = {},
): SwapGatewayEvaluation {
	return {
		classification: {
			toolName: "swap",
			riskClass: "SENSITIVE_EXECUTION",
			defaultDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			auditRequired: true,
			reasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
		},
		candidate: {
			id: "swap-candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "swap",
			actionKind: "swap",
			actorWallet: "actor-wallet",
			createdAt: "2026-06-08T00:00:00.000Z",
			paramsSummary: {
				inputToken: "SOL",
				outputToken: "USDC",
				inputAmount: 1,
				slippageBps: 500,
				protocol: "Orca",
				tokenMint: "usdc-mint",
			},
		},
		policyContext: {
			amount_usd: 140,
			slippage_bps: 500,
			protocol: "Orca",
			token_known: true,
			token_mint: "usdc-mint",
		},
		policyEvaluation: {
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			policyId: "default-conservative",
			reasonCodes: ["SWAP_SLIPPAGE_EXCEEDS_LIMIT"],
			evaluatedRules: ["swaps.max_slippage_bps"],
		},
		metadata: {
			candidateId: "swap-candidate-1",
			candidateFingerprint: "swap-candidate-fingerprint",
			policyId: "default-conservative",
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			reasonCodes: ["SWAP_SLIPPAGE_EXCEEDS_LIMIT"],
			evaluatedRules: ["swaps.max_slippage_bps"],
			classificationReasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
			contextFingerprint: "swap-context-fingerprint",
			evaluatedAt: "2026-06-08T00:00:00.000Z",
		},
		proposalEligible: true,
		requiresApprovalCard: true,
		...overrides,
	};
}

function mockTransferEvaluation(
	overrides: Partial<TransferGatewayEvaluation> = {},
): TransferGatewayEvaluation {
	return {
		classification: {
			toolName: "transfer",
			riskClass: "SENSITIVE_EXECUTION",
			defaultDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			auditRequired: true,
			reasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
		},
		candidate: {
			id: "transfer-candidate-1",
			chain: "solana",
			network: "devnet",
			toolName: "transfer",
			actionKind: "transfer",
			actorWallet: "actor-wallet",
			createdAt: "2026-06-07T00:00:00.000Z",
			paramsSummary: {
				amountSol: 1,
				token: "SOL",
				recipient: "unknown-recipient",
			},
		},
		policyContext: {
			amount_usd: 150,
			recipient_address: "unknown-recipient",
			recipient_known: false,
		},
		policyEvaluation: {
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			policyId: "default-conservative",
			reasonCodes: ["TRANSFER_UNKNOWN_RECIPIENT"],
			evaluatedRules: ["transfers.require_approval_for_unknown_recipient"],
		},
		metadata: {
			candidateId: "transfer-candidate-1",
			candidateFingerprint: "candidate-fingerprint",
			policyId: "default-conservative",
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			reasonCodes: ["TRANSFER_UNKNOWN_RECIPIENT"],
			evaluatedRules: ["transfers.require_approval_for_unknown_recipient"],
			classificationReasonCodes: ["KNOWN_SENSITIVE_EXECUTION_TOOL"],
			contextFingerprint: "context-fingerprint",
			evaluatedAt: "2026-06-07T00:00:00.000Z",
		},
		proposalEligible: true,
		requiresApprovalCard: true,
		...overrides,
	};
}

function listTsFiles(path: string): string[] {
	return readdirSync(path).flatMap((entry) => {
		const entryPath = join(path, entry);
		if (statSync(entryPath).isDirectory()) {
			return listTsFiles(entryPath);
		}
		return entryPath.endsWith(".ts") ? [entryPath] : [];
	});
}

describe("Wave 4 MCP tool call router", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns ALLOW quote results with audit id", async () => {
		const priceQuote = await import("../priceQuote");
		vi.spyOn(priceQuote, "getUsdcSolQuote").mockResolvedValueOnce({
			network: "devnet",
			provider: "orca_whirlpools_devnet",
			input_token: "USDC",
			output_token: "SOL",
			input_amount: 10,
			output_amount: 0.5,
			input_mint: "usdc-mint",
			output_mint: "sol-mint",
			slippage_bps: 100,
			route_context: "unit-test-route",
			quote_source: "fallback_sol_usd",
			updated_at: "2026-06-07T00:00:00.000Z",
		});
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.GET_USDC_SOL_QUOTE,
			arguments: {
				network: "devnet",
				input_token: "USDC",
				output_token: "SOL",
				input_amount: 10,
				slippage_bps: 100,
			},
		});

		expect(result).toMatchObject({
			ok: true,
			decision: COMPASS_DECISIONS.ALLOW,
			toolName: MCP_TOOL_NAMES.GET_USDC_SOL_QUOTE,
			riskClass: "READ_ONLY",
		});
		expect(result.auditId).toEqual(expect.any(String));
		expect(result.data).toMatchObject({ output_amount: 0.5 });
		expect(priceQuote.getUsdcSolQuote).toHaveBeenCalledWith(
			expect.objectContaining({
				network: "devnet",
				input_token: "USDC",
				output_token: "SOL",
				input_amount: 10,
				slippage_bps: 100,
			}),
		);
	});

	it("returns ALLOW swap quote results with audit id", async () => {
		const priceQuote = await import("../priceQuote");
		vi.spyOn(priceQuote, "getUsdcSolQuote").mockResolvedValueOnce({
			network: "devnet",
			provider: "orca_whirlpools_devnet",
			input_token: "SOL",
			output_token: "USDC",
			input_amount: 1,
			output_amount: 140,
			input_mint: "sol-mint",
			output_mint: "usdc-mint",
			slippage_bps: 100,
			route_context: "unit-test-route",
			quote_source: "fallback_sol_usd",
			updated_at: "2026-06-08T00:00:00.000Z",
		});
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.QUOTE_SWAP,
			arguments: {
				network: "devnet",
				input_token: "SOL",
				output_token: "USDC",
				input_amount: 1,
				slippage_bps: 100,
			},
		});

		expect(result).toMatchObject({
			ok: true,
			decision: COMPASS_DECISIONS.ALLOW,
			toolName: MCP_TOOL_NAMES.QUOTE_SWAP,
			riskClass: "PREPARATION_SIMULATION",
		});
		expect(result.auditId).toEqual(expect.any(String));
		expect(result.data).toMatchObject({ output_amount: 140 });
		expect(priceQuote.getUsdcSolQuote).toHaveBeenCalledWith(
			expect.objectContaining({
				network: "devnet",
				input_token: "SOL",
				output_token: "USDC",
				input_amount: 1,
				slippage_bps: 100,
			}),
		);
	});

	it("returns REQUIRE_HUMAN_APPROVAL guarded swap results with approval metadata", async () => {
		const priceQuote = await import("../priceQuote");
		vi.spyOn(priceQuote, "getUsdcSolQuote").mockResolvedValueOnce({
			network: "devnet",
			provider: "orca_whirlpools_devnet",
			input_token: "SOL",
			output_token: "USDC",
			input_amount: 1,
			output_amount: 140,
			input_mint: "sol-mint",
			output_mint: "usdc-mint",
			slippage_bps: 500,
			route_context: "unit-test-route",
			quote_source: "fallback_sol_usd",
			updated_at: "2026-06-08T00:00:00.000Z",
		});
		const swapGateway = await import("../swapGateway");
		const evaluateSpy = vi
			.spyOn(swapGateway, "evaluateSwapGateway")
			.mockResolvedValueOnce(mockSwapEvaluation());
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC,
			arguments: {
				network: "devnet",
				actorWallet: "actor-wallet",
				input_token: "SOL",
				output_token: "USDC",
				input_amount: 1,
				slippage_bps: 500,
				protocol: "Orca",
				token_known: true,
				token_mint: "usdc-mint",
			},
		});

		expect(evaluateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "swap",
				inputToken: "SOL",
				outputToken: "USDC",
				inputAmount: 1,
				slippageBps: 500,
				protocol: "Orca",
				tokenKnown: true,
				tokenMint: "usdc-mint",
				quoteUsd: expect.any(Function),
			}),
		);
		const swapGatewayInput = evaluateSpy.mock.calls[0]?.[0];
		expect(await swapGatewayInput?.quoteUsd?.()).toEqual({
			amountUsd: 140,
			source: "fallback_sol_usd",
		});
		expect(result).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			toolName: MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC,
			riskClass: "SENSITIVE_EXECUTION",
			reasonCodes: ["SWAP_SLIPPAGE_EXCEEDS_LIMIT"],
			approval: {
				required: true,
				metadata: {
					candidateId: "swap-candidate-1",
					policyId: "default-conservative",
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("rawTransaction");
		expect(result.auditId).toEqual(expect.any(String));
	});

	it("returns REQUIRE_ADDITIONAL_CONTEXT for invalid guarded swap input", async () => {
		const swapGateway = await import("../swapGateway");
		const evaluateSpy = vi.spyOn(swapGateway, "evaluateSwapGateway");
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC,
			arguments: {
				network: "devnet",
				input_token: "SOL",
				output_token: "USDC",
				input_amount: 1,
			},
		});

		expect(evaluateSpy).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			toolName: MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC,
			riskClass: "SENSITIVE_EXECUTION",
		});
		expect(result.reasonCodes).toContain("INVALID_SWAP_INPUT");
		expect(result.auditId).toEqual(expect.any(String));
	});

	it("returns REQUIRE_ADDITIONAL_CONTEXT for unsupported guarded swap pairs", async () => {
		const swapGateway = await import("../swapGateway");
		const evaluateSpy = vi.spyOn(swapGateway, "evaluateSwapGateway");
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC,
			arguments: {
				network: "devnet",
				input_token: "USDC",
				output_token: "BONK",
				input_amount: 1,
				slippage_bps: 100,
				protocol: "Orca",
				token_known: true,
				token_mint: "bonk-mint",
			},
		});

		expect(evaluateSpy).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			toolName: MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC,
			riskClass: "SENSITIVE_EXECUTION",
		});
		expect(result.reasonCodes).toContain("UNSUPPORTED_SWAP_PAIR");
		expect(result.auditId).toEqual(expect.any(String));
	});

	it("returns ALLOW conditional oracle simulation results with audit id", async () => {
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.SIMULATE_CONDITIONAL_BUY_ORACLE_CHECK,
			arguments: {
				network: "devnet",
				oracleFeedPubkey: "pyth-sol-usd-devnet",
				oraclePriceUsd: 135,
				oracleAgeSeconds: 15,
				maxOracleAgeSeconds: 60,
				oracleConfidenceBps: 25,
				maxConfidenceBps: 100,
			},
		});

		expect(result).toMatchObject({
			ok: true,
			decision: COMPASS_DECISIONS.ALLOW,
			toolName: MCP_TOOL_NAMES.SIMULATE_CONDITIONAL_BUY_ORACLE_CHECK,
			riskClass: "PREPARATION_SIMULATION",
			data: {
				oracleFeedPubkey: "pyth-sol-usd-devnet",
				oraclePriceUsd: 135,
				withinMaxAge: true,
				withinMaxConfidence: true,
			},
		});
		expect(result.auditId).toEqual(expect.any(String));
	});

	it("returns REQUIRE_HUMAN_APPROVAL conditional order results with approval metadata", async () => {
		const conditionalGateway = await import("../conditionalGateway");
		const evaluateSpy = vi
			.spyOn(conditionalGateway, "evaluateConditionalGateway")
			.mockResolvedValueOnce(mockConditionalEvaluation());
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.CREATE_CONDITIONAL_BUY_SOL,
			arguments: {
				network: "devnet",
				actorWallet: "actor-wallet",
				inputAmountUsdc: 50,
				targetPriceUsd: 130,
				maxSlippageBps: 100,
				oracleFeedPubkey: "pyth-sol-usd-devnet",
				oraclePriceUsd: 135,
				oracleAgeSeconds: 15,
				maxOracleAgeSeconds: 60,
				oracleConfidenceBps: 25,
				maxConfidenceBps: 100,
				recipient: "actor-wallet",
				expiresAtUnix: 1_780_970_000,
				currentUnixTimestamp: 1_780_966_400,
			},
		});

		expect(evaluateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "conditional_buy_sol",
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
				recipient: "actor-wallet",
				expiresAtUnix: 1_780_970_000,
				currentUnixTimestamp: 1_780_966_400,
			}),
		);
		expect(result).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			toolName: MCP_TOOL_NAMES.CREATE_CONDITIONAL_BUY_SOL,
			riskClass: "SENSITIVE_EXECUTION",
			reasonCodes: ["CONDITIONAL_DEFAULT_REQUIRES_APPROVAL"],
			approval: {
				required: true,
				metadata: {
					candidateId: "conditional-candidate-1",
					policyId: "default-conservative",
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("rawTransaction");
		expect(result.auditId).toEqual(expect.any(String));
	});

	it("returns REQUIRE_ADDITIONAL_CONTEXT for invalid conditional order input", async () => {
		const conditionalGateway = await import("../conditionalGateway");
		const evaluateSpy = vi.spyOn(
			conditionalGateway,
			"evaluateConditionalGateway",
		);
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.CREATE_CONDITIONAL_BUY_SOL,
			arguments: {
				network: "devnet",
				inputAmountUsdc: 50,
				targetPriceUsd: 130,
			},
		});

		expect(evaluateSpy).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			toolName: MCP_TOOL_NAMES.CREATE_CONDITIONAL_BUY_SOL,
			riskClass: "SENSITIVE_EXECUTION",
		});
		expect(result.reasonCodes).toContain("INVALID_CONDITIONAL_INPUT");
		expect(result.auditId).toEqual(expect.any(String));
	});

	it("returns REQUIRE_HUMAN_APPROVAL transfer results with approval metadata", async () => {
		const priceQuote = await import("../priceQuote");
		vi.spyOn(priceQuote, "getUsdcSolQuote").mockResolvedValueOnce({
			network: "devnet",
			provider: "orca_whirlpools_devnet",
			input_token: "SOL",
			output_token: "USDC",
			input_amount: 1,
			output_amount: 140,
			input_mint: "sol-mint",
			output_mint: "usdc-mint",
			slippage_bps: 100,
			route_context: "unit-test-route",
			quote_source: "fallback_sol_usd",
			updated_at: "2026-06-07T00:00:00.000Z",
		});
		const transferGateway = await import("../transferGateway");
		const evaluateSpy = vi
			.spyOn(transferGateway, "evaluateTransferGateway")
			.mockResolvedValueOnce(mockTransferEvaluation());
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.GUARDED_TRANSFER_SOL,
			arguments: {
				network: "devnet",
				actorWallet: "actor-wallet",
				amountSol: 1,
				recipientAddress: "unknown-recipient",
				recipientKnown: false,
			},
		});

		expect(evaluateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "transfer",
				amountSol: 1,
				recipientAddress: "unknown-recipient",
				recipientKnown: false,
				quoteUsd: expect.any(Function),
			}),
		);
		const transferGatewayInput = evaluateSpy.mock.calls[0]?.[0];
		expect(await transferGatewayInput?.quoteUsd?.()).toEqual({
			amountUsd: 140,
			source: "fallback_sol_usd",
		});
		expect(priceQuote.getUsdcSolQuote).toHaveBeenCalledWith({
			network: "devnet",
			input_token: "SOL",
			output_token: "USDC",
			input_amount: 1,
		});
		expect(result).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			toolName: MCP_TOOL_NAMES.GUARDED_TRANSFER_SOL,
			riskClass: "SENSITIVE_EXECUTION",
			reasonCodes: ["TRANSFER_UNKNOWN_RECIPIENT"],
			approval: {
				required: true,
				metadata: {
					candidateId: "transfer-candidate-1",
					policyId: "default-conservative",
				},
			},
		});
		expect(result.auditId).toEqual(expect.any(String));
	});

	it("denies direct sign-and-send calls fail closed", async () => {
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.SIGN_AND_SEND_TRANSACTION,
			arguments: {
				compass_built: true,
				rawTransaction: "must-not-leak",
			},
		});

		expect(result).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.DENY,
			toolName: MCP_TOOL_NAMES.SIGN_AND_SEND_TRANSACTION,
			riskClass: "SIGNING",
		});
		expect(result.reasonCodes).toContain("DIRECT_SIGN_AND_SEND_BLOCKED");
		expect(JSON.stringify(result)).not.toContain("must-not-leak");
		expect(result.auditId).toEqual(expect.any(String));

		const { listMcpAuditEvents } = await import("../mcp/mcpAuditSink");
		expect(JSON.stringify(listMcpAuditEvents().at(-1))).not.toContain(
			"must-not-leak",
		);
	});

	it("denies unknown mutating tools fail closed", async () => {
		const { handleMcpToolCall } = await loadMcpToolCallRouter();

		const result = await handleMcpToolCall({
			toolName: "send_raw_transaction",
			mutates: true,
			arguments: { rawTransaction: "must-not-leak" },
		});

		expect(result).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.DENY,
			toolName: "send_raw_transaction",
			riskClass: "BLOCKED_UNKNOWN",
		});
		expect(result.reasonCodes).toContain("UNKNOWN_MUTATING_TOOL");
		expect(JSON.stringify(result)).not.toContain("must-not-leak");
		expect(result.auditId).toEqual(expect.any(String));

		const { listMcpAuditEvents } = await import("../mcp/mcpAuditSink");
		expect(JSON.stringify(listMcpAuditEvents().at(-1))).not.toContain(
			"must-not-leak",
		);
	});

	it("returns REQUIRE_ADDITIONAL_CONTEXT for invalid transfer input", async () => {
		const transferGateway = await import("../transferGateway");
		const evaluateSpy = vi.spyOn(transferGateway, "evaluateTransferGateway");
		const { handleMcpToolCall } = await loadMcpToolCallRouter();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const result = await handleMcpToolCall({
			toolName: MCP_TOOL_NAMES.GUARDED_TRANSFER_SOL,
			arguments: {
				network: "devnet",
				amountSol: 0,
			},
		});

		expect(evaluateSpy).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			toolName: MCP_TOOL_NAMES.GUARDED_TRANSFER_SOL,
			riskClass: "SENSITIVE_EXECUTION",
		});
		expect(result.reasonCodes).toContain("INVALID_TRANSFER_INPUT");
		expect(result.auditId).toEqual(expect.any(String));
	});

	it("MCP modules do not import from legacy", () => {
		const files = listTsFiles(join(process.cwd(), "back/services/mcp"));
		const legacyImportPattern =
			/from\s+["'][^"']*legacy|import\s*\([^)]*legacy/;

		for (const file of files) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(legacyImportPattern);
		}
	});
});
