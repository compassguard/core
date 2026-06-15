import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, vi } from "vitest";

import type { DownstreamMcpTool } from "../mcp/mcpProxyContracts";
import { createDownstreamStdioMcpClient } from "../mcp/downstreamMcpStdioClient";
import { createProxyDispatcher } from "../mcp/mcpProxyDispatcher";
import { parseDownstreamMcpRuntimeConfig } from "../mcp/mcpRuntimeConfig";
import {
	HIDDEN_INTERNAL_PRIMITIVE_NAMES,
	NATIVE_COMPASS_TOOL_NAMES,
} from "./fixtures/fakeDownstreamMcpServer";

async function loadMcpServer() {
	try {
		return await import("../mcp/mcpServer");
	} catch (error) {
		throw new Error(
			`Wave 11 MCP proxy server entrypoint is missing or not loadable: ${String(error)}`,
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

const downstreamTools: DownstreamMcpTool[] = [
	{
		name: "read_file",
		description: "Read a file from the downstream MCP server.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
		descriptor: {},
	},
	{
		name: "list_directory",
		description: "List a directory from the downstream MCP server.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
		},
		descriptor: {},
	},
];

describe("Wave 11 proxy-only MCP server entrypoint", () => {
	it("tools/list handler delegates to the proxy list handler", async () => {
		const { createProxyMcpServerHandlers } = await loadMcpServer();
		const proxyListTools = vi.fn().mockResolvedValueOnce({
			tools: downstreamTools,
		});
		const handlers = createProxyMcpServerHandlers({ proxyListTools });

		const response = await handlers.listTools();

		expect(proxyListTools).toHaveBeenCalledTimes(1);
		expect(response.tools.map((tool) => tool.name)).toEqual([
			"read_file",
			"list_directory",
		]);
		expect(response.tools[0]).toMatchObject({
			name: "read_file",
			description: "Read a file from the downstream MCP server.",
			inputSchema: downstreamTools[0].inputSchema,
		});
	});

	it("tools/list handler preserves extra downstream descriptor metadata", async () => {
		const { createProxyMcpServerHandlers } = await loadMcpServer();
		const proxyListTools = vi.fn().mockResolvedValueOnce({
			tools: [
				{
					name: "read_file",
					description: "Read a file from the downstream MCP server.",
					inputSchema: downstreamTools[0].inputSchema,
					descriptor: {
						name: "read_file",
						description: "Read a file from the downstream MCP server.",
						inputSchema: downstreamTools[0].inputSchema,
						annotations: { readOnlyHint: true },
					},
				},
			],
		});
		const handlers = createProxyMcpServerHandlers({ proxyListTools });

		const response = await handlers.listTools();

		expect(response.tools[0]).toMatchObject({
			annotations: { readOnlyHint: true },
		});
	});

	it("does not expose native Compass or hidden helper tools from a static list", async () => {
		const { createProxyMcpServerHandlers } = await loadMcpServer();
		const handlers = createProxyMcpServerHandlers({
			proxyListTools: vi.fn().mockResolvedValueOnce({ tools: downstreamTools }),
		});

		const response = await handlers.listTools();
		const toolNames = response.tools.map((tool) => tool.name);

		for (const nativeName of NATIVE_COMPASS_TOOL_NAMES) {
			expect(toolNames).not.toContain(nativeName);
		}
		for (const internalName of HIDDEN_INTERNAL_PRIMITIVE_NAMES) {
			expect(toolNames).not.toContain(internalName);
		}
	});

	it("tools/call handler delegates to the proxy call handler", async () => {
		const { createProxyMcpServerHandlers } = await loadMcpServer();
		const downstreamResult = {
			content: [{ type: "text" as const, text: "ok" }],
			structuredContent: { ok: true, value: 42 },
			isError: false,
		};
		const proxyCallTool = vi.fn().mockResolvedValueOnce({
			outcome: "allow",
			reason: "Allowed by proxy policy.",
			data: downstreamResult,
			auditId: "proxy-audit-1",
		});
		const handlers = createProxyMcpServerHandlers({ proxyCallTool });

		const response = await handlers.callTool({
			params: {
				name: "read_file",
				arguments: { path: "/tmp/example.txt" },
			},
		});

		expect(proxyCallTool).toHaveBeenCalledWith({
			toolName: "read_file",
			arguments: { path: "/tmp/example.txt" },
		});
		expect(response).toEqual(downstreamResult);
	});

	it("tools/call handler preserves downstream isError true semantics", async () => {
		const { createProxyMcpServerHandlers } = await loadMcpServer();
		const downstreamError = {
			content: [{ type: "text" as const, text: "File not found" }],
			structuredContent: { code: "ENOENT" },
			isError: true,
		};
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: vi.fn().mockResolvedValueOnce({
				outcome: "allow",
				reason: "Allowed by proxy policy.",
				data: downstreamError,
				auditId: "proxy-audit-1",
			}),
		});

		const response = await handlers.callTool({
			params: { name: "read_file", arguments: { path: "/missing.txt" } },
		});

		expect(response).toEqual(downstreamError);
	});

	it("tools/call handler preserves downstream non-text content", async () => {
		const { createProxyMcpServerHandlers } = await loadMcpServer();
		const downstreamResult = {
			content: [
				{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
			],
			structuredContent: { kind: "screenshot" },
			isError: false,
		};
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: vi.fn().mockResolvedValueOnce({
				outcome: "allow",
				reason: "Allowed by proxy policy.",
				data: downstreamResult,
			}),
		});

		const response = await handlers.callTool({
			params: { name: "capture_screen", arguments: {} },
		});

		expect(response).toEqual(downstreamResult);
	});

	it("tools/call handler returns approval-required envelope without forwarding unknown tools", async () => {
		const { createProxyMcpServerHandlers } = await loadMcpServer();
		const handlers = createProxyMcpServerHandlers({
			proxyCallTool: vi.fn().mockResolvedValueOnce({
				outcome: "require_approval",
				reason:
					'require_approval: Tool "mystery_tool" could not be classified; explicit approval is required before forwarding.',
				suggestedAction:
					"Ask for explicit human approval or add an explicit policy rule for this tool before retrying.",
			}),
		});

		const response = await handlers.callTool({
			params: { name: "mystery_tool", arguments: {} },
		});

		expect(response).toMatchObject({
			isError: true,
			structuredContent: {
				ok: false,
				decision: "require_approval",
				toolName: "mystery_tool",
				suggestedAction:
					"Ask for explicit human approval or add an explicit policy rule for this tool before retrying.",
			},
		});
	});

	it("denies fail-closed when the proxy call handler is absent", async () => {
		const { createProxyMcpServerHandlers } = await loadMcpServer();
		const handlers = createProxyMcpServerHandlers();

		const response = await handlers.callTool({
			params: {
				name: "read_file",
				arguments: { path: "/tmp/example.txt" },
			},
		});

		expect(response).toMatchObject({
			isError: true,
			structuredContent: {
				ok: false,
				decision: "deny",
				toolName: "read_file",
				reason: "Proxy downstream not configured.",
				suggestedAction:
					"Check the downstream MCP server configuration and restart.",
			},
		});
	});

	it("returns an empty tools/list when downstream discovery is unconfigured", async () => {
		const { createProxyMcpServerHandlers } = await loadMcpServer();
		const handlers = createProxyMcpServerHandlers();

		await expect(handlers.listTools()).resolves.toEqual({ tools: [] });
	});

	it("mcpServer entrypoint does not import native MCP tool modules", () => {
		const source = readFileSync(
			join(process.cwd(), "back/services/mcp/mcpServer.ts"),
			"utf8",
		);

		expect(source).not.toMatch(/\.\/mcpToolRegistry/);
		expect(source).not.toMatch(/\.\/mcpToolCallRouter/);
		expect(source).not.toMatch(/\.\/mcpToolContracts/);
		expect(source).not.toMatch(/\.\/mcpServerContracts/);
	});

	it("MCP modules do not import from legacy after adding the server entrypoint", () => {
		const files = listTsFiles(join(process.cwd(), "back/services/mcp"));
		const legacyImportPattern = /from\s+["'][^"']*legacy|import\s*\([^)]*legacy/;

		for (const file of files) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(legacyImportPattern);
		}
	});

	it("parses downstream config from CLI flags and resolves env references without reading secret files", async () => {
		const config = parseDownstreamMcpRuntimeConfig({
			argv: [
				"--downstream-name",
				"fixture",
				"--downstream-command",
				"node",
				"--downstream-args-json",
				JSON.stringify(["server.js"]),
				"--downstream-env-keys",
				"FAKE_SECRET",
			],
			env: { FAKE_SECRET: "secret-value", NODE_ENV: "test" },
		});

		expect(config).toEqual({
			name: "fixture",
			command: "node",
			args: ["server.js"],
			env: { FAKE_SECRET: "secret-value" },
		});
	});

	it("fails closed with a clear error when downstream config is missing", async () => {
		expect(() =>
			parseDownstreamMcpRuntimeConfig({ argv: [], env: { NODE_ENV: "test" } }),
		).toThrow(/not configured.*downstream stdio MCP server/i);
	});

	it("starts a real downstream stdio MCP server, lists tools, and forwards calls through policy", async () => {
		const fixturePath = join(
			process.cwd(),
			"back/services/__tests__/fixtures/fakeDownstreamMcpServer.ts",
		);
		const downstream = createDownstreamStdioMcpClient({
			name: "fake-downstream",
			command: "npx",
			args: ["tsx", fixturePath],
		});

		try {
			await downstream.start?.();
			const dispatcher = createProxyDispatcher({ downstream });

			const listResult = await dispatcher.listTools();
			expect(listResult.tools.map((tool) => tool.name)).toEqual([
				"read_file",
				"list_directory",
				"execute_command",
			]);

			const callResult = await dispatcher.callTool({
				toolName: "read_file",
				arguments: { path: "/tmp/example.txt" },
			});
			expect(callResult.outcome).toBe("allow");
			expect(callResult.data).toMatchObject({
				structuredContent: {
					ok: true,
					toolName: "read_file",
					arguments: { path: "/tmp/example.txt" },
				},
			});
		} finally {
			await downstream.close?.();
		}
	}, 20_000);

	it("does not forward MCP notifications through the request API", async () => {
		const fixturePath = join(
			process.cwd(),
			"back/services/__tests__/fixtures/fakeDownstreamMcpServer.ts",
		);
		const downstream = createDownstreamStdioMcpClient({
			name: "fake-downstream",
			command: "npx",
			args: ["tsx", fixturePath],
		});

		try {
			await downstream.start?.();
			await expect(
				downstream.forwardSafeRequest?.({ method: "notifications/initialized" }),
			).rejects.toThrow(/notification as a request/i);
		} finally {
			await downstream.close?.();
		}
	}, 20_000);

	it("works as a real stdio MCP server for SDK clients", async () => {
		const fixturePath = join(
			process.cwd(),
			"back/services/__tests__/fixtures/fakeDownstreamMcpServer.ts",
		);
		const mcpServerPath = join(process.cwd(), "back/services/mcp/mcpServer.ts");
		const serverSnippet =
			`import { startCompassMcpStdioServer } from ${JSON.stringify(mcpServerPath)};` +
			"startCompassMcpStdioServer().catch((error) => {" +
			"console.error(error instanceof Error ? error.stack ?? error.message : String(error));" +
			"process.exit(1);" +
			"});";
		const transport = new StdioClientTransport({
			command: "npx",
			args: [
				"tsx",
				"-e",
				serverSnippet,
				"--",
				"--downstream-name",
				"fixture",
				"--downstream-command",
				"npx",
				"--downstream-args-json",
				JSON.stringify(["tsx", fixturePath]),
			],
			stderr: "pipe",
		});
		const client = new Client({ name: "compass-e2e-test", version: "0.0.0" });

		try {
			await client.connect(transport);
			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toEqual([
				"read_file",
				"list_directory",
				"execute_command",
			]);

			const result = await client.callTool({
				name: "read_file",
				arguments: { path: "/tmp/example.txt" },
			});
			expect(result).toMatchObject({
				structuredContent: {
					ok: true,
					toolName: "read_file",
					arguments: { path: "/tmp/example.txt" },
				},
				isError: false,
			});
		} finally {
			await client.close();
		}
	}, 30_000);
});
