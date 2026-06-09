import { TOOL_RISK_CLASSES } from "../executionGatewayContracts";
import {
	MCP_TOOL_EXECUTION_KINDS,
	MCP_TOOL_NAMES,
	type CompassMcpToolListItem,
	type CompassMcpToolName,
	type CompassMcpToolRegistryEntry,
} from "./mcpToolContracts";

const USDC_SOL_QUOTE_SCHEMA = {
	type: "object",
	properties: {
		network: { type: "string", enum: ["devnet", "testnet", "mainnet-beta"] },
		input_token: { type: "string", enum: ["USDC", "SOL"] },
		output_token: { type: "string", enum: ["USDC", "SOL"] },
		input_amount: { type: "number", exclusiveMinimum: 0 },
		slippage_bps: { type: "number", minimum: 0 },
	},
	required: ["input_token", "output_token", "input_amount"],
	additionalProperties: false,
} as const;

const CONDITIONAL_ORACLE_CHECK_SCHEMA = {
	type: "object",
	properties: {
		network: { type: "string", enum: ["devnet", "testnet", "mainnet-beta"] },
		oracleFeedPubkey: { type: "string" },
		oraclePriceUsd: { type: "number", exclusiveMinimum: 0 },
		oracleAgeSeconds: { type: "number", minimum: 0 },
		maxOracleAgeSeconds: { type: "number", exclusiveMinimum: 0 },
		oracleConfidenceBps: { type: "number", minimum: 0 },
		maxConfidenceBps: { type: "number", exclusiveMinimum: 0 },
	},
	required: [
		"oracleFeedPubkey",
		"oraclePriceUsd",
		"oracleAgeSeconds",
		"maxOracleAgeSeconds",
		"oracleConfidenceBps",
		"maxConfidenceBps",
	],
	additionalProperties: false,
} as const;

const GUARDED_TRANSFER_SOL_SCHEMA = {
	type: "object",
	properties: {
		network: { type: "string", enum: ["devnet", "testnet", "mainnet-beta"] },
		actorWallet: { type: "string" },
		amountSol: { type: "number", exclusiveMinimum: 0 },
		recipientAddress: { type: "string" },
		recipientKnown: { type: "boolean" },
		walletSafety: { type: "object" },
	},
	required: ["amountSol", "recipientAddress"],
	additionalProperties: false,
} as const;

const GUARDED_SWAP_SOL_USDC_SCHEMA = {
	type: "object",
	properties: {
		network: { type: "string", enum: ["devnet", "testnet", "mainnet-beta"] },
		actorWallet: { type: "string" },
		input_token: { type: "string", enum: ["SOL", "USDC"] },
		output_token: { type: "string", enum: ["SOL", "USDC"] },
		input_amount: { type: "number", exclusiveMinimum: 0 },
		slippage_bps: { type: "number", minimum: 0 },
		protocol: { type: "string" },
		token_known: { type: "boolean" },
		token_mint: { type: "string" },
	},
	required: [
		"input_token",
		"output_token",
		"input_amount",
		"slippage_bps",
		"protocol",
		"token_known",
		"token_mint",
	],
	additionalProperties: false,
} as const;

const CREATE_CONDITIONAL_BUY_SOL_SCHEMA = {
	type: "object",
	properties: {
		network: { type: "string", enum: ["devnet", "testnet", "mainnet-beta"] },
		actorWallet: { type: "string" },
		inputAmountUsdc: { type: "number", exclusiveMinimum: 0 },
		targetPriceUsd: { type: "number", exclusiveMinimum: 0 },
		desiredSolLamports: { type: "number", minimum: 0 },
		maxSlippageBps: { type: "number", minimum: 0 },
		oracleFeedPubkey: { type: "string" },
		oraclePriceUsd: { type: "number", exclusiveMinimum: 0 },
		oracleAgeSeconds: { type: "number", minimum: 0 },
		maxOracleAgeSeconds: { type: "number", exclusiveMinimum: 0 },
		oracleConfidenceBps: { type: "number", minimum: 0 },
		maxConfidenceBps: { type: "number", exclusiveMinimum: 0 },
		recipient: { type: "string" },
		expiresAtUnix: { type: "number", exclusiveMinimum: 0 },
		currentUnixTimestamp: { type: "number", exclusiveMinimum: 0 },
	},
	required: [
		"inputAmountUsdc",
		"targetPriceUsd",
		"maxSlippageBps",
		"oracleFeedPubkey",
		"oraclePriceUsd",
		"oracleAgeSeconds",
		"maxOracleAgeSeconds",
		"oracleConfidenceBps",
		"maxConfidenceBps",
		"recipient",
		"expiresAtUnix",
	],
	additionalProperties: false,
} as const;

const SIGN_AND_SEND_TRANSACTION_SCHEMA = {
	type: "object",
	properties: {},
	additionalProperties: true,
} as const;

const MCP_TOOL_REGISTRY: readonly CompassMcpToolRegistryEntry[] = [
	{
		name: MCP_TOOL_NAMES.GET_USDC_SOL_QUOTE,
		description:
			"Get a USDC/SOL quote through Compass as read-only preparation data.",
		inputSchema: USDC_SOL_QUOTE_SCHEMA,
		metadata: {
			riskClass: TOOL_RISK_CLASSES.READ_ONLY,
			executionKind: MCP_TOOL_EXECUTION_KINDS.READ_PREPARATION,
			readOnly: true,
		},
		classificationToolName: MCP_TOOL_NAMES.GET_USDC_SOL_QUOTE,
		actionKind: "quote",
		mutates: false,
	},
	{
		name: MCP_TOOL_NAMES.QUOTE_SWAP,
		description:
			"Get a swap quote through Compass as preparation/simulation data.",
		inputSchema: USDC_SOL_QUOTE_SCHEMA,
		metadata: {
			riskClass: TOOL_RISK_CLASSES.PREPARATION_SIMULATION,
			executionKind: MCP_TOOL_EXECUTION_KINDS.READ_PREPARATION,
			readOnly: true,
		},
		classificationToolName: MCP_TOOL_NAMES.QUOTE_SWAP,
		actionKind: "quote_swap",
		mutates: false,
	},
	{
		name: MCP_TOOL_NAMES.SIMULATE_CONDITIONAL_BUY_ORACLE_CHECK,
		description:
			"Check conditional-buy oracle evidence through Compass without creating an order.",
		inputSchema: CONDITIONAL_ORACLE_CHECK_SCHEMA,
		metadata: {
			riskClass: TOOL_RISK_CLASSES.PREPARATION_SIMULATION,
			executionKind: MCP_TOOL_EXECUTION_KINDS.READ_PREPARATION,
			readOnly: true,
		},
		classificationToolName:
			MCP_TOOL_NAMES.SIMULATE_CONDITIONAL_BUY_ORACLE_CHECK,
		actionKind: "conditional_oracle_check",
		mutates: false,
	},
	{
		name: MCP_TOOL_NAMES.GUARDED_TRANSFER_SOL,
		description:
			"Prepare a guarded SOL transfer through Compass policy, transfer guard, and audit.",
		inputSchema: GUARDED_TRANSFER_SOL_SCHEMA,
		metadata: {
			riskClass: TOOL_RISK_CLASSES.SENSITIVE_EXECUTION,
			executionKind: MCP_TOOL_EXECUTION_KINDS.SENSITIVE_EXECUTION,
			readOnly: false,
		},
		classificationToolName: "transfer",
		actionKind: "transfer",
		mutates: true,
	},
	{
		name: MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC,
		description:
			"Prepare a guarded swap through Compass policy, swap guard, and audit.",
		inputSchema: GUARDED_SWAP_SOL_USDC_SCHEMA,
		metadata: {
			riskClass: TOOL_RISK_CLASSES.SENSITIVE_EXECUTION,
			executionKind: MCP_TOOL_EXECUTION_KINDS.SENSITIVE_EXECUTION,
			readOnly: false,
		},
		classificationToolName: "swap",
		actionKind: "swap",
		mutates: true,
	},
	{
		name: MCP_TOOL_NAMES.CREATE_CONDITIONAL_BUY_SOL,
		description:
			"Prepare a guarded conditional SOL buy order through Compass policy and audit.",
		inputSchema: CREATE_CONDITIONAL_BUY_SOL_SCHEMA,
		metadata: {
			riskClass: TOOL_RISK_CLASSES.SENSITIVE_EXECUTION,
			executionKind: MCP_TOOL_EXECUTION_KINDS.SENSITIVE_EXECUTION,
			readOnly: false,
		},
		classificationToolName: "conditional_buy_sol",
		actionKind: "conditional_buy",
		mutates: true,
	},
	{
		name: MCP_TOOL_NAMES.SIGN_AND_SEND_TRANSACTION,
		description: "Direct signing and sending is blocked by Compass in Wave 4.",
		inputSchema: SIGN_AND_SEND_TRANSACTION_SCHEMA,
		metadata: {
			riskClass: TOOL_RISK_CLASSES.SIGNING,
			executionKind: MCP_TOOL_EXECUTION_KINDS.SIGNING_DENY_ONLY,
			readOnly: false,
		},
		classificationToolName: MCP_TOOL_NAMES.SIGN_AND_SEND_TRANSACTION,
		actionKind: "sign_and_send",
		mutates: true,
	},
];

export function listMcpTools(): CompassMcpToolListItem[] {
	return MCP_TOOL_REGISTRY.map(
		({ name, description, inputSchema, metadata }) => ({
			name,
			description,
			inputSchema,
			metadata,
		}),
	);
}

export function getMcpTool(
	toolName: string,
): CompassMcpToolRegistryEntry | undefined {
	return MCP_TOOL_REGISTRY.find((tool) => tool.name === toolName);
}

export function isCompassMcpToolName(
	toolName: string,
): toolName is CompassMcpToolName {
	return MCP_TOOL_REGISTRY.some((tool) => tool.name === toolName);
}
