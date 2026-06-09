import type { ConditionalGatewayDecisionMetadata } from "../conditionalGatewayContracts";
import type {
	CompassDecision,
	ToolRiskClass,
} from "../executionGatewayContracts";
import type { SwapGatewayDecisionMetadata } from "../swapGatewayContracts";
import type { TransferGatewayDecisionMetadata } from "../transferGatewayContracts";

export const MCP_TOOL_NAMES = {
	GET_USDC_SOL_QUOTE: "get_usdc_sol_quote",
	QUOTE_SWAP: "quote_swap",
	SIMULATE_CONDITIONAL_BUY_ORACLE_CHECK:
		"simulate_conditional_buy_oracle_check",
	GUARDED_TRANSFER_SOL: "guarded_transfer_sol",
	GUARDED_SWAP_SOL_USDC: "guarded_swap_sol_usdc",
	CREATE_CONDITIONAL_BUY_SOL: "create_conditional_buy_sol",
	SIGN_AND_SEND_TRANSACTION: "sign_and_send_transaction",
} as const;

export type CompassMcpToolName =
	(typeof MCP_TOOL_NAMES)[keyof typeof MCP_TOOL_NAMES];

export const MCP_TOOL_EXECUTION_KINDS = {
	READ_PREPARATION: "read_preparation",
	SENSITIVE_EXECUTION: "sensitive_execution",
	SIGNING_DENY_ONLY: "signing_deny_only",
} as const;

export type CompassMcpToolExecutionKind =
	(typeof MCP_TOOL_EXECUTION_KINDS)[keyof typeof MCP_TOOL_EXECUTION_KINDS];

export type CompassMcpJsonSchema = {
	type: "object";
	properties: Readonly<Record<string, object>>;
	required?: readonly string[];
	additionalProperties?: boolean;
};

export type CompassMcpToolListItem = {
	name: CompassMcpToolName;
	description: string;
	inputSchema: CompassMcpJsonSchema;
	metadata: {
		riskClass: ToolRiskClass;
		executionKind: CompassMcpToolExecutionKind;
		readOnly: boolean;
	};
};

export type CompassMcpToolRegistryEntry = CompassMcpToolListItem & {
	classificationToolName: string;
	actionKind: string;
	mutates: boolean;
};

export type CompassMcpToolCallInput = {
	toolName: string;
	arguments?: Record<string, unknown>;
	mutates?: boolean;
};

export type CompassMcpApproval = {
	required: boolean;
	metadata?:
		| TransferGatewayDecisionMetadata
		| SwapGatewayDecisionMetadata
		| ConditionalGatewayDecisionMetadata;
};

export type CompassMcpToolResult = {
	ok: boolean;
	decision: CompassDecision;
	toolName: string;
	riskClass: ToolRiskClass;
	reasonCodes: string[];
	message: string;
	data?: unknown;
	approval?: CompassMcpApproval;
	auditId?: string;
};
