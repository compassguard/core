/**
 * Wave 11 proxy-only MCP stdio server.
 *
 * The client-facing stdio MCP server delegates active behavior to one
 * downstream stdio MCP server. Downstream tools/list is the source of truth;
 * downstream tools/call is intercepted through policy and audit before
 * forwarding. No native Compass MCP tools or static registry are exposed.
 */

import { pathToFileURL } from "node:url";
import { hostname } from "node:os";
import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getPostHogClient, getInstallationDistinctId } from "@back/posthog/posthogClient";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	ResultSchema,
	type ClientNotification,
	type CallToolRequest,
	type CallToolResult,
	type ListToolsResult,
	type Result,
} from "@modelcontextprotocol/sdk/types.js";

import { debug } from "@back/guardrail/debugLogger";
import { readHostedBackendEnvConfig } from "../../envConfig";
import { loadRepoEnv } from "../config/loadRepoEnv";
import type {
	DownstreamMcpClient,
	ProxyCallToolResult,
	ProxyListToolsResult,
} from "../proxy/mcpProxyContracts";
import { createProxyDispatcher } from "../proxy/mcpProxyDispatcher";
import { isSafeNonToolMethod } from "../proxy/mcpProxyContracts";
import type { ProxyMcpServerHandlerDependencies } from "./mcpProxyServerContracts";
import { parseDownstreamMcpRuntimeConfig } from "../config/mcpRuntimeConfig";
import { createMcpHostedClient } from "../proxy/mcpHostedClient";
import { randomUUID } from "node:crypto";

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

export function createProxyMcpServer(config: {
	downstream?: DownstreamMcpClient;
	hostedClient?: Parameters<typeof createProxyDispatcher>[0]["hostedClient"];
	hybridGuardEnabled?: boolean;
	executeTool?: Parameters<typeof createProxyDispatcher>[0]["executeTool"];
	installationId?: string;
	sessionId?: string;
} = {}): Server {
	const downstream = config.downstream;
	const dispatcher = createProxyDispatcher({
		downstream,
		hostedClient: config.hostedClient,
		hybridGuardEnabled: config.hybridGuardEnabled,
		executeTool: config.executeTool,
		installationId: config.installationId,
		sessionId: config.sessionId,
	});
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
		if (!isSafeNonToolMethod(request.method) || !downstream?.forwardSafeRequest) {
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
		await downstream?.forwardSafeNotification?.({
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
		auditRef: result.auditRef ?? result.auditId,
	});
}

function buildProxyMcpToolError(
	toolName: string,
	reason: string,
	metadata: {
		decision?: ProxyCallToolResult["outcome"];
		suggestedAction?: string;
		auditRef?: string;
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
		...(metadata.auditRef ? { auditRef: metadata.auditRef } : {}),
	};
	return {
		content: [{ type: "text", text: JSON.stringify(structuredContent) }],
		structuredContent,
		isError: true,
	};
}

// ponytail: stable local installation ID derived from hostname + cwd
function resolveLocalInstallationId(): string {
	const raw = `${hostname()}:${process.cwd()}`;
	return `local_${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

export async function startCompassMcpStdioServer(): Promise<void> {
	const config = parseDownstreamMcpRuntimeConfig();
	const downstream = createRuntimeDownstreamClient(config);
	const hostedConfig = readHostedBackendEnvConfig();
	const installationId =
		hostedConfig.installationId ?? resolveLocalInstallationId();
	const hostedClient =
		hostedConfig.apiUrl && hostedConfig.apiKey
			? createMcpHostedClient({
					url: hostedConfig.apiUrl,
					apiKey: hostedConfig.apiKey,
					timeoutMs: hostedConfig.timeoutMs,
			  })
			: undefined;
		const sessionId = `session_${randomUUID()}`;
	try {
		await downstream.start?.();
		const server = createProxyMcpServer({
			downstream,
			hostedClient,
			hybridGuardEnabled: hostedConfig.hybridGuardEnabled,
			executeTool: async (args) =>
				(await downstream.callTool(args)) as CallToolResult,
			installationId,
			sessionId,
		});
		const transport = new StdioServerTransport();
		await server.connect(transport);

		getPostHogClient().capture({
			distinctId: installationId,
			event: "mcp_session_started",
			properties: {
				session_id: sessionId,
				hybrid_guard_enabled: hostedConfig.hybridGuardEnabled,
				hosted_backend_configured: Boolean(hostedConfig.apiUrl),
			},
		});
	} catch (error) {
		getPostHogClient().captureException(error, getInstallationDistinctId(), {
			event_context: "mcp_server_start_failed",
		});
		await downstream.close?.().catch(() => undefined);
		throw error;
	}
}

if (isDirectExecution()) {
	loadRepoEnv();
	startCompassMcpStdioServer().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		debug("gateway", "startServer", "Compass MCP stdio server failed to start", { message });
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

function createRuntimeDownstreamClient(
	config: { command: string; args: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>>; name: string },
): DownstreamMcpClient {
	let sdkClient: Client | undefined;
	let transport: StdioClientTransport | undefined;
	let startup: Promise<void> | undefined;
	let available = false;

	return {
		get isAvailable(): boolean {
			return available;
		},

		async start(): Promise<void> {
			await ensureStarted();
		},

		async listTools(): Promise<ProxyListToolsResult["tools"]> {
			const client = await ensureStarted();
			const result = await client.listTools();
			return result.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				descriptor: tool,
			}));
		},

		async callTool(args) {
			const client = await ensureStarted();
			return client.callTool({
				name: args.toolName,
				arguments: args.arguments,
			});
		},

		async forwardSafeRequest(args): Promise<unknown> {
			if (!isSafeNonToolMethod(args.method) || args.method === "tools/call") {
				throw new Error(`Refusing to forward unsafe MCP method: ${args.method}`);
			}
			if (isNotificationMethod(args.method)) {
				throw new Error(
					`Refusing to forward MCP notification as a request: ${args.method}`,
				);
			}
			const client = await ensureStarted();
			if (args.method === "ping") {
				return client.ping();
			}
			return client.request(
				{ method: args.method, params: args.params },
				ResultSchema,
			);
		},

		async forwardSafeNotification(args): Promise<void> {
			if (!isSafeNonToolMethod(args.method) || !isNotificationMethod(args.method)) {
				throw new Error(`Refusing to forward unsafe MCP notification: ${args.method}`);
			}
			const client = await ensureStarted();
			await client.notification({
				method: args.method,
				...(args.params ? { params: args.params } : {}),
			} as ClientNotification);
		},

		async close(): Promise<void> {
			available = false;
			await sdkClient?.close();
			sdkClient = undefined;
			transport = undefined;
			startup = undefined;
		},
	};

	async function ensureStarted(): Promise<Client> {
		if (available && sdkClient) {
			return sdkClient;
		}
		startup ??= startClient();
		await startup;
		if (!sdkClient || !available) {
			throw new Error("Downstream MCP client failed to initialize.");
		}
		return sdkClient;
	}

	async function startClient(): Promise<void> {
		const env = config.env ? { ...process.env, ...config.env } : undefined;
		transport = new StdioClientTransport({
			command: config.command,
			args: [...config.args],
			...(config.cwd ? { cwd: config.cwd } : {}),
			...(env ? { env } : {}),
			stderr: "pipe",
		});
		sdkClient = new Client({
			name: "compass-mcp-guard-proxy",
			version: "0.0.0",
		});
		try {
			await sdkClient.connect(transport);
			available = true;
		} catch (error) {
			available = false;
			await transport.close().catch(() => undefined);
			throw error;
		}
	}
}

export { resetProxyAuditEvents } from "../proxy/mcpProxyAudit";
