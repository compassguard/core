import * as conditionalGateway from "../conditionalGateway";
import type { EvaluateConditionalGatewayInput } from "../conditionalGatewayContracts";
import {
	buildAuditEvent,
	classifyToolCall,
	createActionCandidate,
} from "../executionGateway";
import { COMPASS_DECISIONS } from "../executionGatewayContracts";
import * as priceQuote from "../priceQuote";
import type { UsdcSolQuoteQuery } from "../priceQuote";
import * as swapGateway from "../swapGateway";
import type { EvaluateSwapGatewayInput } from "../swapGatewayContracts";
import * as transferGateway from "../transferGateway";
import type { EvaluateTransferGatewayInput } from "../transferGatewayContracts";
import { recordMcpAuditEvent } from "./mcpAuditSink";
import {
	MCP_TOOL_NAMES,
	type CompassMcpToolCallInput,
	type CompassMcpToolRegistryEntry,
	type CompassMcpToolResult,
} from "./mcpToolContracts";
import { getMcpTool } from "./mcpToolRegistry";
import {
	buildAllowResult,
	buildDenyResult,
	buildRequireAdditionalContextResult,
	buildRequireApprovalResult,
} from "./mcpToolResults";

const DEFAULT_NETWORK = "devnet";
const MCP_AUDIT_ACTION_KIND_PREFIX = "mcp_tool_call";

export async function handleMcpToolCall(
	input: CompassMcpToolCallInput,
): Promise<CompassMcpToolResult> {
	const registryEntry = getMcpTool(input.toolName);
	const classification = classifyToolCall({
		toolName: registryEntry?.classificationToolName ?? input.toolName,
		mutates: registryEntry?.mutates ?? input.mutates,
	});

	if (!registryEntry) {
		const auditId = emitMcpAudit({
			publicToolName: input.toolName,
			actionKind: "unknown",
			classification,
			decision: classification.defaultDecision,
			result:
				classification.defaultDecision === COMPASS_DECISIONS.DENY
					? "denied"
					: "pending",
			metadata: { registeredTool: false },
		});

		if (classification.defaultDecision === COMPASS_DECISIONS.DENY) {
			return buildDenyResult({
				toolName: input.toolName,
				riskClass: classification.riskClass,
				reasonCodes: classification.reasonCodes,
				message: "Compass denied an unknown mutating MCP tool fail-closed.",
				auditId,
			});
		}

		return buildRequireAdditionalContextResult({
			toolName: input.toolName,
			riskClass: classification.riskClass,
			reasonCodes: classification.reasonCodes,
			message: "Compass requires additional context for this unknown MCP tool.",
			auditId,
		});
	}

	if (registryEntry.name === MCP_TOOL_NAMES.SIGN_AND_SEND_TRANSACTION) {
		return denyRegisteredTool(registryEntry, classification.reasonCodes);
	}

	if (classification.defaultDecision === COMPASS_DECISIONS.DENY) {
		return denyRegisteredTool(registryEntry, classification.reasonCodes);
	}

	switch (registryEntry.name) {
		case MCP_TOOL_NAMES.GET_USDC_SOL_QUOTE:
		case MCP_TOOL_NAMES.QUOTE_SWAP:
			return handleQuoteTool(
				registryEntry,
				classification.reasonCodes,
				input.arguments,
			);
		case MCP_TOOL_NAMES.SIMULATE_CONDITIONAL_BUY_ORACLE_CHECK:
			return handleConditionalOracleSimulationTool(
				registryEntry,
				classification.reasonCodes,
				input.arguments,
			);
		case MCP_TOOL_NAMES.GUARDED_TRANSFER_SOL:
			return handleTransferTool(registryEntry, input.arguments);
		case MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC:
			return handleSwapTool(registryEntry, input.arguments);
		case MCP_TOOL_NAMES.CREATE_CONDITIONAL_BUY_SOL:
			return handleConditionalTool(registryEntry, input.arguments);
	}
}

function denyRegisteredTool(
	registryEntry: CompassMcpToolRegistryEntry,
	reasonCodes: string[],
): CompassMcpToolResult {
	const classification = classifyToolCall({
		toolName: registryEntry.classificationToolName,
		mutates: registryEntry.mutates,
	});
	const auditId = emitMcpAudit({
		publicToolName: registryEntry.name,
		actionKind: registryEntry.actionKind,
		classification,
		decision: COMPASS_DECISIONS.DENY,
		result: "denied",
		metadata: { registeredTool: true },
	});

	return buildDenyResult({
		toolName: registryEntry.name,
		riskClass: registryEntry.metadata.riskClass,
		reasonCodes,
		message: "Compass blocks direct signing or sending in Wave 4.",
		auditId,
	});
}

async function handleQuoteTool(
	registryEntry: CompassMcpToolRegistryEntry,
	classificationReasonCodes: string[],
	args: Record<string, unknown> | undefined,
): Promise<CompassMcpToolResult> {
	const classification = classifyToolCall({
		toolName: registryEntry.classificationToolName,
		mutates: registryEntry.mutates,
	});
	const parsed = parseQuoteInput(args);

	if (parsed.ok === false) {
		const auditId = emitMcpAudit({
			publicToolName: registryEntry.name,
			actionKind: registryEntry.actionKind,
			classification,
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			result: "failed",
			metadata: { registeredTool: true, validationErrors: parsed.reasonCodes },
		});

		return buildRequireAdditionalContextResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes: parsed.reasonCodes,
			auditId,
		});
	}

	try {
		const quote = await priceQuote.getUsdcSolQuote(parsed.value);
		const auditId = emitMcpAudit({
			publicToolName: registryEntry.name,
			actionKind: registryEntry.actionKind,
			classification,
			decision: COMPASS_DECISIONS.ALLOW,
			result: "success",
			network: quote.network,
			metadata: {
				registeredTool: true,
				quoteSource: quote.quote_source,
				provider: quote.provider,
			},
			params: summarizeQuoteParams(quote),
		});

		return buildAllowResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes: classificationReasonCodes,
			data: quote,
			auditId,
		});
	} catch (error) {
		const reasonCodes = [quoteErrorReasonCode(error)];
		const decision = isQuoteInputError(error)
			? COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT
			: COMPASS_DECISIONS.DENY;
		const auditId = emitMcpAudit({
			publicToolName: registryEntry.name,
			actionKind: registryEntry.actionKind,
			classification,
			decision,
			result: decision === COMPASS_DECISIONS.DENY ? "denied" : "failed",
			metadata: {
				registeredTool: true,
				errorCode: reasonCodes[0],
			},
		});

		if (decision === COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT) {
			return buildRequireAdditionalContextResult({
				toolName: registryEntry.name,
				riskClass: registryEntry.metadata.riskClass,
				reasonCodes,
				auditId,
			});
		}

		return buildDenyResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			auditId,
		});
	}
}

function handleConditionalOracleSimulationTool(
	registryEntry: CompassMcpToolRegistryEntry,
	classificationReasonCodes: string[],
	args: Record<string, unknown> | undefined,
): CompassMcpToolResult {
	const classification = classifyToolCall({
		toolName: registryEntry.classificationToolName,
		mutates: registryEntry.mutates,
	});
	const parsed = parseConditionalOracleSimulationInput(args);

	if (parsed.ok === false) {
		const auditId = emitMcpAudit({
			publicToolName: registryEntry.name,
			actionKind: registryEntry.actionKind,
			classification,
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			result: "failed",
			metadata: { registeredTool: true, validationErrors: parsed.reasonCodes },
		});

		return buildRequireAdditionalContextResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes: parsed.reasonCodes,
			message:
				"Compass requires valid oracle price, age, and confidence evidence.",
			auditId,
		});
	}

	const data = {
		...parsed.value,
		withinMaxAge:
			parsed.value.oracleAgeSeconds <= parsed.value.maxOracleAgeSeconds,
		withinMaxConfidence:
			parsed.value.oracleConfidenceBps <= parsed.value.maxConfidenceBps,
	};
	const auditId = emitMcpAudit({
		publicToolName: registryEntry.name,
		actionKind: registryEntry.actionKind,
		classification,
		decision: COMPASS_DECISIONS.ALLOW,
		result: "success",
		network: parsed.value.network,
		metadata: {
			registeredTool: true,
			withinMaxAge: data.withinMaxAge,
			withinMaxConfidence: data.withinMaxConfidence,
		},
		params: {
			oracleFeedPubkey: parsed.value.oracleFeedPubkey,
			oracleAgeSeconds: parsed.value.oracleAgeSeconds,
			oracleConfidenceBps: parsed.value.oracleConfidenceBps,
		},
	});

	return buildAllowResult({
		toolName: registryEntry.name,
		riskClass: registryEntry.metadata.riskClass,
		reasonCodes: classificationReasonCodes,
		data,
		auditId,
	});
}

async function handleTransferTool(
	registryEntry: CompassMcpToolRegistryEntry,
	args: Record<string, unknown> | undefined,
): Promise<CompassMcpToolResult> {
	const classification = classifyToolCall({
		toolName: registryEntry.classificationToolName,
		mutates: registryEntry.mutates,
	});
	const parsed = parseTransferInput(args);

	if (parsed.ok === false) {
		const auditId = emitMcpAudit({
			publicToolName: registryEntry.name,
			actionKind: registryEntry.actionKind,
			classification,
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			result: "failed",
			metadata: {
				registeredTool: true,
				validationErrors: parsed.reasonCodes,
			},
		});

		return buildRequireAdditionalContextResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes: parsed.reasonCodes,
			message: "Compass requires valid transfer amount and recipient context.",
			auditId,
		});
	}

	const evaluation = await transferGateway.evaluateTransferGateway({
		...parsed.value,
		toolName: registryEntry.classificationToolName,
	});
	const decision = evaluation.policyEvaluation.decision;
	const reasonCodes = evaluation.policyEvaluation.reasonCodes;
	const auditId = emitMcpAudit({
		publicToolName: registryEntry.name,
		actionKind: registryEntry.actionKind,
		classification: evaluation.classification,
		decision,
		result: decision === COMPASS_DECISIONS.DENY ? "denied" : "pending",
		network: parsed.value.network,
		metadata: {
			registeredTool: true,
			policyId: evaluation.policyEvaluation.policyId,
			policyReasonCodes: reasonCodes,
			evaluatedRules: evaluation.policyEvaluation.evaluatedRules,
			proposalEligible: evaluation.proposalEligible,
			requiresApprovalCard: evaluation.requiresApprovalCard,
			failClosedReason: evaluation.failClosedReason,
			gatewayCandidateId: evaluation.metadata.candidateId,
			candidateFingerprint: evaluation.metadata.candidateFingerprint,
			contextFingerprint: evaluation.metadata.contextFingerprint,
		},
		params: {
			amountSol: parsed.value.amountSol,
			recipientAddress: parsed.value.recipientAddress,
			recipientKnown: parsed.value.recipientKnown,
		},
	});

	if (decision === COMPASS_DECISIONS.ALLOW) {
		return buildAllowResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			data: buildTransferResultData(evaluation),
			approval: {
				required: evaluation.requiresApprovalCard,
				metadata: evaluation.requiresApprovalCard
					? evaluation.metadata
					: undefined,
			},
			auditId,
		});
	}

	if (decision === COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL) {
		return buildRequireApprovalResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			data: buildTransferResultData(evaluation),
			approval: {
				required: true,
				metadata: evaluation.metadata,
			},
			auditId,
		});
	}

	if (decision === COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT) {
		return buildRequireAdditionalContextResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			data: buildTransferResultData(evaluation),
			auditId,
		});
	}

	return buildDenyResult({
		toolName: registryEntry.name,
		riskClass: registryEntry.metadata.riskClass,
		reasonCodes,
		data: buildTransferResultData(evaluation),
		auditId,
	});
}

async function handleSwapTool(
	registryEntry: CompassMcpToolRegistryEntry,
	args: Record<string, unknown> | undefined,
): Promise<CompassMcpToolResult> {
	const classification = classifyToolCall({
		toolName: registryEntry.classificationToolName,
		mutates: registryEntry.mutates,
	});
	const parsed = parseSwapInput(args);

	if (parsed.ok === false) {
		const auditId = emitMcpAudit({
			publicToolName: registryEntry.name,
			actionKind: registryEntry.actionKind,
			classification,
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			result: "failed",
			metadata: {
				registeredTool: true,
				validationErrors: parsed.reasonCodes,
			},
		});

		return buildRequireAdditionalContextResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes: parsed.reasonCodes,
			message:
				"Compass requires valid swap amount, slippage, protocol, and token context.",
			auditId,
		});
	}

	const evaluation = await swapGateway.evaluateSwapGateway({
		...parsed.value,
		toolName: registryEntry.classificationToolName,
	});
	const decision = evaluation.policyEvaluation.decision;
	const reasonCodes = evaluation.policyEvaluation.reasonCodes;
	const auditId = emitMcpAudit({
		publicToolName: registryEntry.name,
		actionKind: registryEntry.actionKind,
		classification: evaluation.classification,
		decision,
		result: decision === COMPASS_DECISIONS.DENY ? "denied" : "pending",
		network: parsed.value.network,
		metadata: {
			registeredTool: true,
			policyId: evaluation.policyEvaluation.policyId,
			policyReasonCodes: reasonCodes,
			evaluatedRules: evaluation.policyEvaluation.evaluatedRules,
			proposalEligible: evaluation.proposalEligible,
			requiresApprovalCard: evaluation.requiresApprovalCard,
			failClosedReason: evaluation.failClosedReason,
			gatewayCandidateId: evaluation.metadata.candidateId,
			candidateFingerprint: evaluation.metadata.candidateFingerprint,
			contextFingerprint: evaluation.metadata.contextFingerprint,
			protocol: parsed.value.protocol,
			slippageBps: parsed.value.slippageBps,
			tokenKnown: parsed.value.tokenKnown,
		},
		params: {
			inputToken: parsed.value.inputToken,
			outputToken: parsed.value.outputToken,
			inputAmount: parsed.value.inputAmount,
			slippageBps: parsed.value.slippageBps,
			protocol: parsed.value.protocol,
			tokenMint: parsed.value.tokenMint,
		},
	});

	if (decision === COMPASS_DECISIONS.ALLOW) {
		return buildAllowResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			data: buildSwapResultData(evaluation),
			approval: {
				required: evaluation.requiresApprovalCard,
				metadata: evaluation.requiresApprovalCard
					? evaluation.metadata
					: undefined,
			},
			auditId,
		});
	}

	if (decision === COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL) {
		return buildRequireApprovalResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			data: buildSwapResultData(evaluation),
			approval: { required: true, metadata: evaluation.metadata },
			auditId,
		});
	}

	if (decision === COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT) {
		return buildRequireAdditionalContextResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			data: buildSwapResultData(evaluation),
			auditId,
		});
	}

	return buildDenyResult({
		toolName: registryEntry.name,
		riskClass: registryEntry.metadata.riskClass,
		reasonCodes,
		data: buildSwapResultData(evaluation),
		auditId,
	});
}

async function handleConditionalTool(
	registryEntry: CompassMcpToolRegistryEntry,
	args: Record<string, unknown> | undefined,
): Promise<CompassMcpToolResult> {
	const classification = classifyToolCall({
		toolName: registryEntry.classificationToolName,
		mutates: registryEntry.mutates,
	});
	const parsed = parseConditionalInput(args);

	if (parsed.ok === false) {
		const auditId = emitMcpAudit({
			publicToolName: registryEntry.name,
			actionKind: registryEntry.actionKind,
			classification,
			decision: COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT,
			result: "failed",
			metadata: {
				registeredTool: true,
				validationErrors: parsed.reasonCodes,
			},
		});

		return buildRequireAdditionalContextResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes: parsed.reasonCodes,
			message:
				"Compass requires valid conditional amount, target, oracle, expiry, and slippage context.",
			auditId,
		});
	}

	const evaluation = await conditionalGateway.evaluateConditionalGateway({
		...parsed.value,
		toolName: registryEntry.classificationToolName,
	});
	const decision = evaluation.policyEvaluation.decision;
	const reasonCodes = evaluation.policyEvaluation.reasonCodes;
	const auditId = emitMcpAudit({
		publicToolName: registryEntry.name,
		actionKind: registryEntry.actionKind,
		classification: evaluation.classification,
		decision,
		result: decision === COMPASS_DECISIONS.DENY ? "denied" : "pending",
		network: parsed.value.network,
		metadata: {
			registeredTool: true,
			policyId: evaluation.policyEvaluation.policyId,
			policyReasonCodes: reasonCodes,
			evaluatedRules: evaluation.policyEvaluation.evaluatedRules,
			proposalEligible: evaluation.proposalEligible,
			requiresApprovalCard: evaluation.requiresApprovalCard,
			failClosedReason: evaluation.failClosedReason,
			gatewayCandidateId: evaluation.metadata.candidateId,
			candidateFingerprint: evaluation.metadata.candidateFingerprint,
			contextFingerprint: evaluation.metadata.contextFingerprint,
			conditionSummary: {
				targetPriceUsd: parsed.value.targetPriceUsd,
				expiresAtUnix: parsed.value.expiresAtUnix,
			},
			oracleSummary: {
				oracleFeedPubkey: parsed.value.oracleFeedPubkey,
				oracleAgeSeconds: parsed.value.oracleAgeSeconds,
				oracleConfidenceBps: parsed.value.oracleConfidenceBps,
			},
		},
		params: {
			inputAmountUsdc: parsed.value.inputAmountUsdc,
			targetPriceUsd: parsed.value.targetPriceUsd,
			maxSlippageBps: parsed.value.maxSlippageBps,
			oracleFeedPubkey: parsed.value.oracleFeedPubkey,
			recipient: parsed.value.recipient,
			expiresAtUnix: parsed.value.expiresAtUnix,
		},
	});

	if (decision === COMPASS_DECISIONS.ALLOW) {
		return buildAllowResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			data: buildConditionalResultData(evaluation),
			approval: {
				required: evaluation.requiresApprovalCard,
				metadata: evaluation.requiresApprovalCard
					? evaluation.metadata
					: undefined,
			},
			auditId,
		});
	}

	if (decision === COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL) {
		return buildRequireApprovalResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			data: buildConditionalResultData(evaluation),
			approval: { required: true, metadata: evaluation.metadata },
			auditId,
		});
	}

	if (decision === COMPASS_DECISIONS.REQUIRE_ADDITIONAL_CONTEXT) {
		return buildRequireAdditionalContextResult({
			toolName: registryEntry.name,
			riskClass: registryEntry.metadata.riskClass,
			reasonCodes,
			data: buildConditionalResultData(evaluation),
			auditId,
		});
	}

	return buildDenyResult({
		toolName: registryEntry.name,
		riskClass: registryEntry.metadata.riskClass,
		reasonCodes,
		data: buildConditionalResultData(evaluation),
		auditId,
	});
}

function parseQuoteInput(
	args: Record<string, unknown> | undefined,
):
	| { ok: true; value: UsdcSolQuoteQuery }
	| { ok: false; reasonCodes: string[] } {
	if (!args) {
		return { ok: false, reasonCodes: ["INVALID_QUOTE_INPUT"] };
	}

	if (
		(args.input_token !== "USDC" && args.input_token !== "SOL") ||
		(args.output_token !== "USDC" && args.output_token !== "SOL") ||
		typeof args.input_amount !== "number" ||
		!Number.isFinite(args.input_amount) ||
		args.input_amount <= 0
	) {
		return { ok: false, reasonCodes: ["INVALID_QUOTE_INPUT"] };
	}

	const query: UsdcSolQuoteQuery = {
		input_token: args.input_token,
		output_token: args.output_token,
		input_amount: args.input_amount,
		network: typeof args.network === "string" ? args.network : DEFAULT_NETWORK,
	};

	if (typeof args.slippage_bps === "number") {
		query.slippage_bps = args.slippage_bps;
	}

	return { ok: true, value: query };
}

function summarizeQuoteParams(
	quote: Awaited<ReturnType<typeof priceQuote.getUsdcSolQuote>>,
) {
	return {
		network: quote.network,
		inputToken: quote.input_token,
		outputToken: quote.output_token,
		inputAmount: quote.input_amount,
		slippageBps: quote.slippage_bps,
	};
}

function parseTransferInput(
	args: Record<string, unknown> | undefined,
):
	| { ok: true; value: EvaluateTransferGatewayInput }
	| { ok: false; reasonCodes: string[] } {
	if (!args) {
		return { ok: false, reasonCodes: ["INVALID_TRANSFER_INPUT"] };
	}

	const amountSol = args.amountSol;
	const recipientAddress = args.recipientAddress;

	if (
		typeof amountSol !== "number" ||
		!Number.isFinite(amountSol) ||
		amountSol <= 0 ||
		typeof recipientAddress !== "string" ||
		recipientAddress.trim().length === 0
	) {
		return { ok: false, reasonCodes: ["INVALID_TRANSFER_INPUT"] };
	}

	const network =
		typeof args.network === "string" ? args.network : DEFAULT_NETWORK;
	const input: EvaluateTransferGatewayInput = {
		network,
		amountSol,
		recipientAddress,
		quoteUsd: async () => {
			const quote = await priceQuote.getUsdcSolQuote({
				network,
				input_token: "SOL",
				output_token: "USDC",
				input_amount: amountSol,
			});

			return {
				amountUsd: quote.output_amount,
				source: quote.quote_source,
			};
		},
	};

	if (typeof args.actorWallet === "string") {
		input.actorWallet = args.actorWallet;
	}

	if (typeof args.recipientKnown === "boolean") {
		input.recipientKnown = args.recipientKnown;
	}

	if (isWalletSafetyEvidence(args.walletSafety)) {
		input.walletSafety = args.walletSafety;
	}

	return { ok: true, value: input };
}

function parseSwapInput(
	args: Record<string, unknown> | undefined,
):
	| { ok: true; value: EvaluateSwapGatewayInput }
	| { ok: false; reasonCodes: string[] } {
	if (!args) {
		return { ok: false, reasonCodes: ["INVALID_SWAP_INPUT"] };
	}

	const inputToken = args.input_token;
	const outputToken = args.output_token;
	const inputAmount = args.input_amount;
	const slippageBps = args.slippage_bps;
	const protocol = args.protocol;
	const tokenKnown = args.token_known;
	const tokenMint = args.token_mint;

	if (
		typeof inputToken !== "string" ||
		inputToken.trim().length === 0 ||
		typeof outputToken !== "string" ||
		outputToken.trim().length === 0 ||
		typeof inputAmount !== "number" ||
		!Number.isFinite(inputAmount) ||
		inputAmount <= 0 ||
		typeof slippageBps !== "number" ||
		!Number.isFinite(slippageBps) ||
		slippageBps < 0 ||
		typeof protocol !== "string" ||
		protocol.trim().length === 0 ||
		typeof tokenKnown !== "boolean" ||
		typeof tokenMint !== "string" ||
		tokenMint.trim().length === 0
	) {
		return { ok: false, reasonCodes: ["INVALID_SWAP_INPUT"] };
	}

	const network =
		typeof args.network === "string" ? args.network : DEFAULT_NETWORK;
	const normalizedInputToken = inputToken.toUpperCase();
	const normalizedOutputToken = outputToken.toUpperCase();

	if (
		!isSupportedSolUsdcSwapPair(normalizedInputToken, normalizedOutputToken)
	) {
		return { ok: false, reasonCodes: ["UNSUPPORTED_SWAP_PAIR"] };
	}

	const input: EvaluateSwapGatewayInput = {
		network,
		inputToken: normalizedInputToken,
		outputToken: normalizedOutputToken,
		inputAmount,
		slippageBps,
		protocol,
		tokenKnown,
		tokenMint,
		quoteUsd: async () =>
			quoteSwapAmountUsd({
				network,
				inputToken: normalizedInputToken,
				outputToken: normalizedOutputToken,
				inputAmount,
				slippageBps,
			}),
	};

	if (typeof args.actorWallet === "string") {
		input.actorWallet = args.actorWallet;
	}

	return { ok: true, value: input };
}

function isSupportedSolUsdcSwapPair(
	inputToken: string,
	outputToken: string,
): boolean {
	return (
		(inputToken === "SOL" && outputToken === "USDC") ||
		(inputToken === "USDC" && outputToken === "SOL")
	);
}

async function quoteSwapAmountUsd(input: {
	network: string;
	inputToken: string;
	outputToken: string;
	inputAmount: number;
	slippageBps: number;
}) {
	if (input.inputToken === "USDC" && input.outputToken === "SOL") {
		return { amountUsd: input.inputAmount, source: "stable_usdc_input" };
	}

	if (input.inputToken !== "SOL" || input.outputToken !== "USDC") {
		return undefined;
	}

	const quote = await priceQuote.getUsdcSolQuote({
		network: input.network,
		input_token: "SOL",
		output_token: "USDC",
		input_amount: input.inputAmount,
		slippage_bps: input.slippageBps,
	});

	return { amountUsd: quote.output_amount, source: quote.quote_source };
}

function parseConditionalOracleSimulationInput(
	args: Record<string, unknown> | undefined,
):
	| {
			ok: true;
			value: {
				network: string;
				oracleFeedPubkey: string;
				oraclePriceUsd: number;
				oracleAgeSeconds: number;
				maxOracleAgeSeconds: number;
				oracleConfidenceBps: number;
				maxConfidenceBps: number;
			};
	  }
	| { ok: false; reasonCodes: string[] } {
	if (!args) {
		return { ok: false, reasonCodes: ["INVALID_ORACLE_INPUT"] };
	}

	const oracleFeedPubkey = args.oracleFeedPubkey;
	const oraclePriceUsd = args.oraclePriceUsd;
	const oracleAgeSeconds = args.oracleAgeSeconds;
	const maxOracleAgeSeconds = args.maxOracleAgeSeconds;
	const oracleConfidenceBps = args.oracleConfidenceBps;
	const maxConfidenceBps = args.maxConfidenceBps;

	if (
		typeof oracleFeedPubkey !== "string" ||
		oracleFeedPubkey.trim().length === 0 ||
		!isPositiveNumber(oraclePriceUsd) ||
		!isNonNegativeNumber(oracleAgeSeconds) ||
		!isPositiveNumber(maxOracleAgeSeconds) ||
		!isNonNegativeNumber(oracleConfidenceBps) ||
		!isPositiveNumber(maxConfidenceBps)
	) {
		return { ok: false, reasonCodes: ["INVALID_ORACLE_INPUT"] };
	}

	return {
		ok: true,
		value: {
			network:
				typeof args.network === "string" ? args.network : DEFAULT_NETWORK,
			oracleFeedPubkey,
			oraclePriceUsd,
			oracleAgeSeconds,
			maxOracleAgeSeconds,
			oracleConfidenceBps,
			maxConfidenceBps,
		},
	};
}

function parseConditionalInput(
	args: Record<string, unknown> | undefined,
):
	| { ok: true; value: EvaluateConditionalGatewayInput }
	| { ok: false; reasonCodes: string[] } {
	if (!args) {
		return { ok: false, reasonCodes: ["INVALID_CONDITIONAL_INPUT"] };
	}

	const inputAmountUsdc = args.inputAmountUsdc;
	const targetPriceUsd = args.targetPriceUsd;
	const maxSlippageBps = args.maxSlippageBps;
	const oracleFeedPubkey = args.oracleFeedPubkey;
	const oraclePriceUsd = args.oraclePriceUsd;
	const oracleAgeSeconds = args.oracleAgeSeconds;
	const maxOracleAgeSeconds = args.maxOracleAgeSeconds;
	const oracleConfidenceBps = args.oracleConfidenceBps;
	const maxConfidenceBps = args.maxConfidenceBps;
	const recipient = args.recipient;
	const expiresAtUnix = args.expiresAtUnix;

	if (
		!isPositiveNumber(inputAmountUsdc) ||
		!isPositiveNumber(targetPriceUsd) ||
		!isNonNegativeNumber(maxSlippageBps) ||
		typeof oracleFeedPubkey !== "string" ||
		oracleFeedPubkey.trim().length === 0 ||
		!isPositiveNumber(oraclePriceUsd) ||
		!isNonNegativeNumber(oracleAgeSeconds) ||
		!isPositiveNumber(maxOracleAgeSeconds) ||
		!isNonNegativeNumber(oracleConfidenceBps) ||
		!isPositiveNumber(maxConfidenceBps) ||
		typeof recipient !== "string" ||
		recipient.trim().length === 0 ||
		!isPositiveNumber(expiresAtUnix)
	) {
		return { ok: false, reasonCodes: ["INVALID_CONDITIONAL_INPUT"] };
	}

	const input: EvaluateConditionalGatewayInput = {
		network: typeof args.network === "string" ? args.network : DEFAULT_NETWORK,
		inputToken: "USDC",
		inputAmountUsdc,
		targetPriceUsd,
		maxSlippageBps,
		oracleFeedPubkey,
		oraclePriceUsd,
		oracleAgeSeconds,
		maxOracleAgeSeconds,
		oracleConfidenceBps,
		maxConfidenceBps,
		recipient,
		expiresAtUnix,
	};

	if (typeof args.actorWallet === "string") {
		input.actorWallet = args.actorWallet;
	}

	if (isNonNegativeNumber(args.desiredSolLamports)) {
		input.desiredSolLamports = args.desiredSolLamports;
	}

	if (isPositiveNumber(args.currentUnixTimestamp)) {
		input.currentUnixTimestamp = args.currentUnixTimestamp;
	}

	return { ok: true, value: input };
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function buildTransferResultData(
	evaluation: Awaited<
		ReturnType<typeof transferGateway.evaluateTransferGateway>
	>,
): Record<string, unknown> {
	return {
		proposalEligible: evaluation.proposalEligible,
		requiresApprovalCard: evaluation.requiresApprovalCard,
		failClosedReason: evaluation.failClosedReason,
		policyId: evaluation.policyEvaluation.policyId,
	};
}

function buildSwapResultData(
	evaluation: Awaited<ReturnType<typeof swapGateway.evaluateSwapGateway>>,
): Record<string, unknown> {
	return {
		proposalEligible: evaluation.proposalEligible,
		requiresApprovalCard: evaluation.requiresApprovalCard,
		failClosedReason: evaluation.failClosedReason,
		policyId: evaluation.policyEvaluation.policyId,
	};
}

function buildConditionalResultData(
	evaluation: Awaited<
		ReturnType<typeof conditionalGateway.evaluateConditionalGateway>
	>,
): Record<string, unknown> {
	return {
		proposalEligible: evaluation.proposalEligible,
		requiresApprovalCard: evaluation.requiresApprovalCard,
		failClosedReason: evaluation.failClosedReason,
		policyId: evaluation.policyEvaluation.policyId,
	};
}

function emitMcpAudit(input: {
	publicToolName: string;
	actionKind: string;
	classification: ReturnType<typeof classifyToolCall>;
	decision: ReturnType<typeof classifyToolCall>["defaultDecision"];
	result: "pending" | "success" | "failed" | "denied";
	metadata?: Record<string, unknown>;
	params?: Record<string, unknown>;
	network?: string;
}): string {
	const candidate = createActionCandidate({
		chain: "solana",
		network: input.network ?? DEFAULT_NETWORK,
		toolName: input.publicToolName,
		actionKind: `${MCP_AUDIT_ACTION_KIND_PREFIX}.${input.actionKind}`,
		params: input.params,
	});
	const event = buildAuditEvent({
		candidate,
		classification: {
			...input.classification,
			toolName: input.publicToolName,
		},
		decision: input.decision,
		result: input.result,
		metadata: input.metadata,
	});

	return recordMcpAuditEvent(event);
}

function quoteErrorReasonCode(error: unknown): string {
	const code = getErrorCode(error);
	return code ? `QUOTE_${code.toUpperCase()}` : "QUOTE_FAILED";
}

function isQuoteInputError(error: unknown): boolean {
	const code = getErrorCode(error);
	return Boolean(
		code &&
			[
				"invalid_quote_payload",
				"unsupported_network",
				"invalid_pair",
				"invalid_amount",
				"invalid_network_config",
			].includes(code),
	);
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

function isWalletSafetyEvidence(
	value: unknown,
): value is EvaluateTransferGatewayInput["walletSafety"] {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
