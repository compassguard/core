import { describe, expect, it } from "vitest";

async function loadMcpToolRegistry() {
	try {
		return await import("../mcp/mcpToolRegistry");
	} catch (error) {
		throw new Error(
			`Wave 4 MCP tool registry implementation is missing or not loadable: ${String(error)}`,
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

describe("Wave 4 MCP tool registry", () => {
	it("lists Compass-controlled transfer, swap, conditional, quote, and deny-only signing tools", async () => {
		const { listMcpTools } = await loadMcpToolRegistry();
		const { MCP_TOOL_NAMES } = await loadMcpToolContracts();

		const tools = listMcpTools();

		expect(tools.map((tool) => tool.name)).toEqual([
			MCP_TOOL_NAMES.GET_USDC_SOL_QUOTE,
			MCP_TOOL_NAMES.QUOTE_SWAP,
			MCP_TOOL_NAMES.SIMULATE_CONDITIONAL_BUY_ORACLE_CHECK,
			MCP_TOOL_NAMES.GUARDED_TRANSFER_SOL,
			MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC,
			MCP_TOOL_NAMES.CREATE_CONDITIONAL_BUY_SOL,
			MCP_TOOL_NAMES.SIGN_AND_SEND_TRANSACTION,
		]);
		expect(tools).toHaveLength(7);
		expect(
			tools.find((tool) => tool.name === MCP_TOOL_NAMES.QUOTE_SWAP),
		).toMatchObject({
			metadata: {
				riskClass: "PREPARATION_SIMULATION",
				readOnly: true,
			},
		});
		expect(
			tools.find(
				(tool) =>
					tool.name === MCP_TOOL_NAMES.SIMULATE_CONDITIONAL_BUY_ORACLE_CHECK,
			),
		).toMatchObject({
			metadata: {
				riskClass: "PREPARATION_SIMULATION",
				readOnly: true,
			},
		});
		expect(
			tools.find((tool) => tool.name === MCP_TOOL_NAMES.GUARDED_SWAP_SOL_USDC),
		).toMatchObject({
			metadata: {
				riskClass: "SENSITIVE_EXECUTION",
				readOnly: false,
			},
		});
		expect(
			tools.find(
				(tool) => tool.name === MCP_TOOL_NAMES.CREATE_CONDITIONAL_BUY_SOL,
			),
		).toMatchObject({
			metadata: {
				riskClass: "SENSITIVE_EXECUTION",
				readOnly: false,
			},
		});
	});

	it("does not expose raw signer or private-key tools", async () => {
		const { listMcpTools } = await loadMcpToolRegistry();

		const toolNames = listMcpTools().map((tool) => tool.name);

		expect(toolNames).not.toContain("sign_transaction");
		expect(toolNames).not.toContain("send_raw_transaction");
		expect(toolNames).not.toContain("export_private_key");
		expect(toolNames).not.toContain("legacy_chat_transfer");
	});
});
