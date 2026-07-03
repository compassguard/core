/**
 * Wave 11 proxy-only MCP server contracts.
 *
 * These contracts describe the proxy protocol envelopes that the client-facing
 * MCP server uses when operating as a proxy to a downstream stdio MCP server.
 * They do NOT describe native Compass tool results.
 *
 * The proxy server delegates all active behavior (tools/list and tools/call)
 * to mcpProxyDispatcher. No native Compass MCP tool names, schemas, or
 * static registry are involved.
 */

import type {
	CallToolRequest,
	CallToolResult,
	ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import type {
	ProxyCallToolResult,
	ProxyListToolsResult,
} from "../proxy/mcpProxyContracts";

// ---------------------------------------------------------------------------
// Proxy server handler types
// ---------------------------------------------------------------------------

/** Dependencies for creating proxy MCP server handlers (for testing). */
export type ProxyMcpServerHandlerDependencies = {
	/** Override for the proxy list-tools handler (for testing). */
	proxyListTools?: () => Promise<ProxyListToolsResult>;
	/** Override for the proxy call-tool handler (for testing). */
	proxyCallTool?: (args: {
		toolName: string;
		arguments?: Record<string, unknown>;
	}) => Promise<ProxyCallToolResult>;
};

/** Proxy MCP server handler functions. */
export type ProxyMcpServerHandlers = {
	listTools: () => Promise<ListToolsResult>;
	callTool: (request: Pick<CallToolRequest, "params">) => Promise<CallToolResult>;
};
