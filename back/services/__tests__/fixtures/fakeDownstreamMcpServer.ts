/**
 * Fake downstream MCP server fixture for proxy dispatcher tests.
 *
 * This fixture provides a deterministic, injectable stand-in for a downstream
 * stdio MCP server. It does NOT start a real process; it simulates downstream
 * responses for tools/list and tools/call so proxy behaviour can be tested
 * in isolation.
 *
 * The fixture implements the DownstreamMcpClient interface from
 * mcpProxyContracts so it can be directly wired into createProxyDispatcher.
 */

import type {
	DownstreamMcpClient,
	DownstreamMcpTool,
	ProxiedMcpToolCall,
} from "../../mcp/proxy/mcpProxyContracts";
import { debug } from "@back/guardrail/debugLogger";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Default fake downstream tools
// ---------------------------------------------------------------------------

const DEFAULT_DOWNSTREAM_TOOLS: readonly DownstreamMcpTool[] = [
	{
		name: "read_file",
		description: "Read a file from the filesystem.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path to read." },
			},
			required: ["path"],
		},
		descriptor: {
			name: "read_file",
			description: "Read a file from the filesystem.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "File path to read." },
				},
				required: ["path"],
			},
		},
	},
	{
		name: "list_directory",
		description: "List entries in a directory.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory path to list." },
			},
			required: ["path"],
		},
		descriptor: {
			name: "list_directory",
			description: "List entries in a directory.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "Directory path to list." },
				},
				required: ["path"],
			},
		},
	},
	{
		name: "execute_command",
		description: "Execute a shell command.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Command to execute." },
				timeout: { type: "number", description: "Timeout in ms." },
			},
			required: ["command"],
		},
		descriptor: {
			name: "execute_command",
			description: "Execute a shell command.",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string", description: "Command to execute." },
					timeout: { type: "number", description: "Timeout in ms." },
				},
				required: ["command"],
			},
		},
	},
] as const;

// ---------------------------------------------------------------------------
// Fake downstream MCP server fixture
// ---------------------------------------------------------------------------

export type FakeDownstreamMcpServerConfig = {
	/** Override the default tool descriptors returned by tools/list. */
	tools?: DownstreamMcpTool[];
	/** If set, tools/list will reject with this error (simulates listing failure). */
	listError?: Error;
	/** If set, tools/call will reject with this error for ALL calls (simulates call failure). */
	callError?: Error;
};

/** Result returned by the fake downstream on a tools/call. */
export type FakeDownstreamCallResult = CallToolResult;

export type FakeDownstreamMcpServer = DownstreamMcpClient & {
	/** Simulated tools/call — records the call and returns the configured result. */
	recordedCalls: ProxiedMcpToolCall[];

	/** Override the result for a specific tool name on next tools/call. */
	setCallResult: (
		toolName: string,
		result: FakeDownstreamCallResult,
	) => void;

	/** Configure the server to fail on startup (marks server as unavailable). */
	setStartupError: (error: Error) => void;

	/** Configure the server to fail on tools/list. */
	setListError: (error: Error) => void;

	/** Configure the server to fail on tools/call for ALL tools. */
	setCallError: (error: Error) => void;

	/** Clear all recorded calls and per-tool call overrides. */
	reset: () => void;

	/** Requests forwarded through the safe non-tool path. */
	forwardedSafeRequests: Array<{
		method: string;
		params?: Record<string, unknown>;
	}>;

	/** Notifications forwarded through the safe non-tool path. */
	forwardedSafeNotifications: Array<{
		method: string;
		params?: Record<string, unknown>;
	}>;
};

/**
 * Creates a fake downstream MCP server for proxy tests.
 *
 * The fixture simulates a real downstream stdio MCP server without
 * starting any child process. It provides deterministic responses
 * for tools/list and tools/call, records forwarded calls for
 * assertions, and can be configured to simulate startup, listing,
 * and call failures.
 */
export function createFakeDownstreamMcpServer(
	config: FakeDownstreamMcpServerConfig = {},
): FakeDownstreamMcpServer {
	const tools = config.tools ?? [...DEFAULT_DOWNSTREAM_TOOLS];
	let startupError: Error | undefined;
	let listError: Error | undefined = config.listError;
	let callError: Error | undefined = config.callError;
	const recordedCalls: ProxiedMcpToolCall[] = [];
	const forwardedSafeRequests: Array<{
		method: string;
		params?: Record<string, unknown>;
	}> = [];
	const forwardedSafeNotifications: Array<{
		method: string;
		params?: Record<string, unknown>;
	}> = [];
	const callResultOverrides = new Map<string, FakeDownstreamCallResult>();

	/** Default call result: a successful response with echo data. */
	const defaultCallResult: FakeDownstreamCallResult = {
		content: [{ type: "text", text: JSON.stringify({ echoed: true }) }],
		structuredContent: { echoed: true },
		isError: false,
	};

	return {
		recordedCalls,
		forwardedSafeRequests,
		forwardedSafeNotifications,

		get isAvailable(): boolean {
			return startupError === undefined;
		},

		async listTools(): Promise<DownstreamMcpTool[]> {
			if (startupError) {
				throw startupError;
			}
			if (listError) {
				throw listError;
			}
			return [...tools];
		},

		async callTool(
			args: ProxiedMcpToolCall,
		): Promise<unknown> {
			if (startupError) {
				throw startupError;
			}
			if (callError) {
				throw callError;
			}
			recordedCalls.push({ toolName: args.toolName, arguments: args.arguments });
			const override = callResultOverrides.get(args.toolName);
			if (override) {
				return { ...override };
			}
			return { ...defaultCallResult };
		},

		async forwardSafeRequest(args): Promise<unknown> {
			if (startupError) {
				throw startupError;
			}
			forwardedSafeRequests.push(args);
			return { forwarded: true, method: args.method };
		},

		async forwardSafeNotification(args): Promise<void> {
			if (startupError) {
				throw startupError;
			}
			forwardedSafeNotifications.push(args);
		},

		setCallResult(
			toolName: string,
			result: FakeDownstreamCallResult,
		): void {
			callResultOverrides.set(toolName, result);
		},

		setStartupError(error: Error): void {
			startupError = error;
		},

		setListError(error: Error): void {
			listError = error;
		},

		setCallError(error: Error): void {
			callError = error;
		},

		reset(): void {
			recordedCalls.length = 0;
			forwardedSafeRequests.length = 0;
			forwardedSafeNotifications.length = 0;
			callResultOverrides.clear();
			startupError = undefined;
			listError = undefined;
			callError = undefined;
		},
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	startFakeDownstreamMcpServer().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		debug("connection", "handleFailure", "Fake downstream MCP server failed", { message });
		process.exit(1);
	});
}

async function startFakeDownstreamMcpServer(): Promise<void> {
	const server = new Server(
		{ name: "fake-downstream-mcp", version: "0.0.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: DEFAULT_DOWNSTREAM_TOOLS.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema as {
				type: "object";
				properties?: Record<string, object>;
				required?: string[];
			},
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => ({
		content: [
			{
				type: "text",
				text: JSON.stringify({
					ok: true,
					toolName: request.params.name,
					arguments: request.params.arguments ?? {},
				}),
			},
		],
		structuredContent: {
			ok: true,
			toolName: request.params.name,
			arguments: request.params.arguments ?? {},
		},
		isError: false,
	}));
	await server.connect(new StdioServerTransport());
}

// ---------------------------------------------------------------------------
// Native-Compass tool name constants for absence assertions
// ---------------------------------------------------------------------------

/**
 * Names of native Compass MCP tools that MUST NOT appear in the Wave 11
 * proxy surface. Used by regression tests to verify these tools are absent
 * from the proxy tools/list response.
 */
export const NATIVE_COMPASS_TOOL_NAMES = [
	"compass_transfer",
	"compass_swap",
	"get_usdc_sol_quote",
	"quote_swap",
	"simulate_conditional_buy_oracle_check",
	"guarded_transfer_sol",
	"guarded_swap_sol_usdc",
	"execute_approved_action",
	"sign_and_send_transaction",
	"create_conditional_buy_sol",
] as const;

/**
 * Additional hidden internal primitive tool names that MUST NOT appear
 * in the proxy surface.
 */
export const HIDDEN_INTERNAL_PRIMITIVE_NAMES = [
	"internal_transfer",
	"internal_swap",
	"internal_sign",
] as const;

// ---------------------------------------------------------------------------
// Helper: create a fake downstream that denies everything
// ---------------------------------------------------------------------------

/**
 * Creates a fake downstream where every tools/call returns a denial.
 * Useful for testing that the proxy does NOT forward calls when the
 * downstream would deny — the proxy must deny BEFORE forwarding.
 */
export function createDenyAllFakeDownstream(
	denyReason: string = "Downstream denied the call.",
): FakeDownstreamMcpServer {
	const server = createFakeDownstreamMcpServer();
	for (const tool of DEFAULT_DOWNSTREAM_TOOLS) {
		server.setCallResult(tool.name, {
			content: [{ type: "text", text: denyReason }],
			structuredContent: { ok: false, reason: denyReason },
			isError: true,
		});
	}
	return server;
}

// ---------------------------------------------------------------------------
// Helper: create a fake downstream that simulates original MCP config
// ---------------------------------------------------------------------------

/**
 * Represents a local MCP config entry that the installer might encounter.
 * Used by wrapping tests to verify config transformation without secrets.
 */
export type FakeLocalMcpConfig = {
	name: string;
	command: string;
	args: readonly string[];
	env?: Record<string, string>;
	cwd?: string;
};

/**
 * Creates a realistic local MCP config with both safe and secret env values.
 * The secret values use a well-known prefix pattern so tests can verify
 * they are NOT leaked into generated output.
 */
export function createFakeLocalMcpConfigWithSecrets(): {
	config: FakeLocalMcpConfig;
	secrets: Record<string, string>;
} {
	const secrets: Record<string, string> = {
		OPENAI_API_KEY: "fake-openai-key-placeholder",
		DATABASE_URL: "example-database-url-placeholder",
	};

	const config: FakeLocalMcpConfig = {
		name: "fake-downstream-server",
		command: "npx",
		args: ["-y", "fake-mcp-server@1.0.0"],
		env: {
			PATH: "/usr/local/bin:/usr/bin",
			NODE_ENV: "development",
			...secrets,
		},
		cwd: "/home/user/project",
	};

	return { config, secrets };
}
