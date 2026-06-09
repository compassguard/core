import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { COMPASS_DECISIONS, TOOL_RISK_CLASSES } from "../executionGatewayContracts";
import type { CompassMcpToolResult } from "../mcp/mcpToolContracts";
import { listMcpTools } from "../mcp/mcpToolRegistry";

async function loadMcpServer() {
	try {
		return await import("../mcp/mcpServer");
	} catch (error) {
		throw new Error(
			`Wave 4 MCP server entrypoint is missing or not loadable: ${String(error)}`,
		);
	}
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

function sampleCompassResult(
	overrides: Partial<CompassMcpToolResult> = {},
): CompassMcpToolResult {
	return {
		ok: true,
		decision: COMPASS_DECISIONS.ALLOW,
		toolName: "get_usdc_sol_quote",
		riskClass: TOOL_RISK_CLASSES.READ_ONLY,
		reasonCodes: ["KNOWN_READ_ONLY_TOOL"],
		message: "Compass allowed this MCP tool call.",
		data: { output_amount: 0.5 },
		auditId: "audit-1",
		...overrides,
	};
}

describe("Wave 4 local MCP server entrypoint", () => {
	it("tools/list handler returns registry definitions with safe schemas", async () => {
		const { createCompassMcpServerHandlers } = await loadMcpServer();
		const handlers = createCompassMcpServerHandlers();

		const response = await handlers.listTools();
		const registryTools = listMcpTools();

		expect(response.tools.map((tool) => tool.name)).toEqual(
			registryTools.map((tool) => tool.name),
		);
		expect(response.tools[0]).toMatchObject({
			name: registryTools[0].name,
			description: registryTools[0].description,
			inputSchema: registryTools[0].inputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false,
			},
			_meta: {
				riskClass: registryTools[0].metadata.riskClass,
				executionKind: registryTools[0].metadata.executionKind,
				readOnly: true,
			},
		});
		expect(response.tools.map((tool) => tool.name)).toEqual([
			"get_usdc_sol_quote",
			"quote_swap",
			"simulate_conditional_buy_oracle_check",
			"guarded_transfer_sol",
			"guarded_swap_sol_usdc",
			"create_conditional_buy_sol",
			"sign_and_send_transaction",
		]);
		expect(JSON.stringify(response)).not.toMatch(
			/private.*key|mnemonic|seed|rawTransaction|legacy_chat_transfer/i,
		);
	});

	it("tools/call handler delegates to the pure router and returns text plus structured content", async () => {
		const { createCompassMcpServerHandlers } = await loadMcpServer();
		const callTool = vi.fn().mockResolvedValueOnce(sampleCompassResult());
		const handlers = createCompassMcpServerHandlers({ callTool });

		const response = await handlers.callTool({
			params: {
				name: "get_usdc_sol_quote",
				arguments: {
					input_token: "USDC",
					output_token: "SOL",
					input_amount: 10,
				},
			},
		});

		expect(callTool).toHaveBeenCalledWith({
			toolName: "get_usdc_sol_quote",
			arguments: {
				input_token: "USDC",
				output_token: "SOL",
				input_amount: 10,
			},
		});
		expect(response).toMatchObject({
			isError: false,
			structuredContent: {
				ok: true,
				decision: COMPASS_DECISIONS.ALLOW,
				toolName: "get_usdc_sol_quote",
			},
			content: [
				{
					type: "text",
					text: expect.stringContaining("get_usdc_sol_quote"),
				},
			],
		});
		const [content] = response.content;
		expect(content.type).toBe("text");
		if (content.type !== "text") {
			throw new Error("Expected text MCP content");
		}
		expect(JSON.parse(content.text)).toEqual(response.structuredContent);
	});

	it("maps Compass denial results without treating policy denial as transport failure", async () => {
		const { mapCompassToolResultToMcpCallResult } = await loadMcpServer();

		const response = mapCompassToolResultToMcpCallResult(
			sampleCompassResult({
				ok: false,
				decision: COMPASS_DECISIONS.DENY,
				toolName: "sign_and_send_transaction",
				riskClass: TOOL_RISK_CLASSES.SIGNING,
				reasonCodes: ["DIRECT_SIGN_AND_SEND_BLOCKED"],
				message: "Compass blocks direct signing or sending in Wave 4.",
				data: undefined,
			}),
		);

		expect(response.isError).toBe(false);
		expect(response.structuredContent).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.DENY,
			reasonCodes: ["DIRECT_SIGN_AND_SEND_BLOCKED"],
		});
	});

	it("returns safe structured transport errors without leaking raw args", async () => {
		const { createCompassMcpServerHandlers } = await loadMcpServer();
		const callTool = vi
			.fn()
			.mockRejectedValueOnce(new Error("provider failed for rawTransaction=secret-raw-tx"));
		const handlers = createCompassMcpServerHandlers({ callTool });

		const response = await handlers.callTool({
			params: {
				name: "get_usdc_sol_quote",
				arguments: { rawTransaction: "secret-raw-tx" },
			},
		});

		expect(response.isError).toBe(true);
		expect(response.structuredContent).toMatchObject({
			ok: false,
			decision: COMPASS_DECISIONS.DENY,
			toolName: "get_usdc_sol_quote",
			reasonCodes: ["MCP_TOOL_CALL_FAILED"],
		});
		expect(JSON.stringify(response)).not.toContain("secret-raw-tx");
		expect(JSON.stringify(response)).not.toContain("provider failed");
	});

	it("MCP modules do not import from legacy after adding the server entrypoint", () => {
		const files = listTsFiles(join(process.cwd(), "back/services/mcp"));
		const legacyImportPattern = /from\s+["'][^"']*legacy|import\s*\([^)]*legacy/;

		for (const file of files) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(legacyImportPattern);
		}
	});
});
