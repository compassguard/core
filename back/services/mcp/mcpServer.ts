/**
 * Wave 11 proxy-only MCP stdio server.
 *
 * The client-facing stdio MCP server delegates active behavior to one
 * downstream stdio MCP server. Downstream tools/list is the source of truth;
 * downstream tools/call is intercepted through policy and audit before
 * forwarding. No native Compass MCP tools or static registry are exposed.
 */

import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolRequest,
	type CallToolResult,
	type ListToolsResult,
	type Result,
} from "@modelcontextprotocol/sdk/types.js";

import { createDownstreamStdioMcpClient } from "./downstreamMcpStdioClient";
import { loadRepoEnv } from "./loadRepoEnv";
import type {
	DownstreamMcpClient,
	ProxyCallToolResult,
	ProxyListToolsResult,
} from "./mcpProxyContracts";
import { createProxyDispatcher } from "./mcpProxyDispatcher";
import { isSafeNonToolMethod } from "./mcpProxyContracts";
import type { ProxyMcpServerHandlerDependencies } from "./mcpProxyServerContracts";
import { parseDownstreamMcpRuntimeConfig } from "./mcpRuntimeConfig";

const COMPASS_MCP_SERVER_INFO = {
	name: "compass-mcp-guard",
	version: "0.0.0",
} as const;

export function createProxyMcpServerHandlers(
	dependencies: ProxyMcpServerHandlerDependencies = {},
) {
	const proxyListTools = dependencies.proxyListTools;
	const proxyCallTool = dependencies.proxyCallTool;

	return {
		async listTools(): Promise<ListToolsResult> {
			if (!proxyListTools) {
				return { tools: [] };
			}
			const result = await proxyListTools();
			return mapProxyListToolsResult(result);
		},

		async callTool(request: Pick<CallToolRequest, "params">): Promise<CallToolResult> {
			if (!proxyCallTool) {
				return buildProxyMcpToolError(
					request.params.name,
					"Proxy downstream not configured.",
				);
			}
			const result = await proxyCallTool({
				toolName: request.params.name,
				arguments: request.params.arguments as Record<string, unknown> | undefined,
			});
			return mapProxyCallToolResult(request.params.name, result);
		},
	};
}

export function createProxyMcpServer(downstream: DownstreamMcpClient): Server {
	const dispatcher = createProxyDispatcher({ downstream });
	const server = new Server(COMPASS_MCP_SERVER_INFO, {
		capabilities: { tools: {} },
		instructions:
			"Compass MCP Guard proxies a downstream MCP server with guardrails. " +
			"Tool calls pass through Compass policy and audit before forwarding.",
	});

	const handlers = createProxyMcpServerHandlers({
		proxyListTools: () => dispatcher.listTools(),
		proxyCallTool: (args) => dispatcher.callTool(args),
	});

	server.setRequestHandler(ListToolsRequestSchema, async () => handlers.listTools());
	server.setRequestHandler(CallToolRequestSchema, async (request) =>
		handlers.callTool(request),
	);
	server.fallbackRequestHandler = async (request): Promise<Result> => {
		if (!isSafeNonToolMethod(request.method) || !downstream.forwardSafeRequest) {
			throw new Error(`Compass MCP proxy rejected unsafe method: ${request.method}`);
		}
		if (isNotificationMethod(request.method)) {
			throw new Error(
				`Compass MCP proxy rejected notification sent as request: ${request.method}`,
			);
		}
		const result = await downstream.forwardSafeRequest({
			method: request.method,
			params: request.params as Record<string, unknown> | undefined,
		});
		return isResultObject(result) ? result : {};
	};
	server.fallbackNotificationHandler = async (notification): Promise<void> => {
		if (!isSafeNonToolMethod(notification.method)) {
			return;
		}
		await downstream.forwardSafeNotification?.({
			method: notification.method,
			params: notification.params as Record<string, unknown> | undefined,
		});
	};

	return server;
}

function isNotificationMethod(method: string): boolean {
	return method.startsWith("notifications/");
}

function mapProxyListToolsResult(result: ProxyListToolsResult): ListToolsResult {
	return {
		tools: result.tools.map((tool) => {
			const descriptor = isResultObject(tool.descriptor) ? tool.descriptor : {};
			return {
				...descriptor,
				name: tool.name,
				description: tool.description ?? "",
				inputSchema: (tool.inputSchema ?? {
					type: "object",
					properties: {},
				}) as ListToolsResult["tools"][number]["inputSchema"],
			};
		}),
	};
}

function mapProxyCallToolResult(
	toolName: string,
	result: ProxyCallToolResult,
): CallToolResult {
	if (result.outcome === "allow") {
		return result.data ?? {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						ok: false,
						decision: "deny",
						toolName,
						reason: "Downstream tools/call returned no result.",
					}),
				},
			],
			structuredContent: {
				ok: false,
				decision: "deny",
				toolName,
				reason: "Downstream tools/call returned no result.",
			},
			isError: true,
		};
	}

	return buildProxyMcpToolError(toolName, result.reason, {
		decision: result.outcome,
		suggestedAction: result.suggestedAction,
		auditId: result.auditId,
	});
}

function buildProxyMcpToolError(
	toolName: string,
	reason: string,
	metadata: {
		decision?: ProxyCallToolResult["outcome"];
		suggestedAction?: string;
		auditId?: string;
	} = {},
): CallToolResult {
	const structuredContent = {
		ok: false,
		decision: metadata.decision ?? "deny",
		toolName,
		reason,
		suggestedAction:
			metadata.suggestedAction ??
			"Check the downstream MCP server configuration and restart.",
		...(metadata.auditId ? { auditId: metadata.auditId } : {}),
	};
	return {
		content: [{ type: "text", text: JSON.stringify(structuredContent) }],
		structuredContent,
		isError: true,
	};
}

export async function startCompassMcpStdioServer(): Promise<void> {
	const config = parseDownstreamMcpRuntimeConfig();
	const downstream = createDownstreamStdioMcpClient(config);
	try {
		await downstream.start?.();
		const server = createProxyMcpServer(downstream);
		const transport = new StdioServerTransport();
		await server.connect(transport);
	} catch (error) {
		await downstream.close?.().catch(() => undefined);
		throw error;
	}
}

if (isDirectExecution()) {
	loadRepoEnv();
	startCompassMcpStdioServer().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Compass MCP stdio server failed to start: ${message}`);
		process.exit(1);
	});
}

function isDirectExecution(): boolean {
	return Boolean(
		process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
	);
}

function isResultObject(value: unknown): value is Result {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { resetProxyAuditEvents } from "./mcpProxyAudit";
