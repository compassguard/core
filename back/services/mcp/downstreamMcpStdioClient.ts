/**
 * Downstream stdio MCP client lifecycle.
 *
 * Manages a single downstream stdio MCP server process: starting it,
 * requesting capabilities, discovering tools, forwarding tool calls,
 * and shutting it down cleanly.
 *
 * Wave 11 constraint: exactly one downstream stdio MCP server per proxy process.
 * Fail closed on startup, discovery, or call uncertainty.
 */

import type {
	DownstreamMcpClient,
	DownstreamMcpStdioConfig,
	DownstreamMcpTool,
} from "./mcpProxyContracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResultSchema, type ClientNotification } from "@modelcontextprotocol/sdk/types.js";
import { isSafeNonToolMethod } from "./mcpProxyContracts";

/**
 * Create a downstream stdio MCP client that manages a child process.
 *
 * This is the real implementation; tests use the fake fixture instead.
 * The client starts the downstream command, performs MCP protocol
 * initialization, discovers tools, and forwards calls.
 *
 * The real stdio transport integration will be wired after the proxy
 * dispatcher and policy interceptor are in place. For now, this
 * provides the lifecycle structure and fail-closed state management.
 */
export function createDownstreamStdioMcpClient(
	config: DownstreamMcpStdioConfig,
): DownstreamMcpClient {
	let sdkClient: Client | undefined;
	let transport: StdioClientTransport | undefined;
	let startup: Promise<void> | undefined;
	let available = false;

	const client: DownstreamMcpClient = {
		get isAvailable(): boolean {
			return available;
		},

		async start(): Promise<void> {
			await ensureStarted();
		},

		async listTools(): Promise<DownstreamMcpTool[]> {
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

	return client;

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
		const env = config.env
			? { ...process.env, ...config.env }
			: undefined;
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

function isNotificationMethod(method: string): boolean {
	return method.startsWith("notifications/");
}
