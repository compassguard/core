/**
 * Wave 11 proxy-only MCP contracts.
 *
 * These types define the proxy boundary between Compass and a single
 * downstream stdio MCP server. They do NOT import native MCP tool names,
 * native schemas, or native result types — Wave 11 has no native Compass
 * MCP tool surface.
 *
 * Downstream tools/list is the source of truth for public tool descriptors.
 * tools/call is intercepted before forwarding. Fail closed on uncertainty.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
	EvaluateActionAgentContext,
	HostedDecision,
	LocalFinding,
} from "@shared/evaluationContracts";
import type { HostedClient } from "./mcpHostedClientContracts";

// ---------------------------------------------------------------------------
// Downstream stdio server configuration
// ---------------------------------------------------------------------------

/** Configuration for one downstream stdio MCP server per proxy process. */
export type DownstreamMcpStdioConfig = {
	/** Server name for identification and logging. */
	name: string;
	/** Command to start the downstream MCP server (e.g., "npx"). */
	command: string;
	/** Arguments for the downstream command. */
	args: readonly string[];
	/** Environment variables to pass to the downstream server. */
	env?: Readonly<Record<string, string>>;
	/** Working directory for the downstream server process. */
	cwd?: string;
};

/** Runtime downstream config wrapper used by the Compass proxy process. */
export type DownstreamMcpRuntimeConfig = DownstreamMcpStdioConfig & {
	/** Environment variable names to copy from the proxy process at startup. */
	envReferences?: readonly string[];
};

// ---------------------------------------------------------------------------
// Downstream tool descriptors
// ---------------------------------------------------------------------------

/** A tool descriptor discovered from the downstream server's tools/list. */
export type DownstreamMcpTool = {
	/** Tool name from the downstream server (preserved, not renamed). */
	name: string;
	/** Tool description from the downstream server. */
	description?: string;
	/** Tool input schema from the downstream server. */
	inputSchema?: Record<string, unknown>;
	/** Full tool descriptor as returned by the downstream server. */
	descriptor: unknown;
};

// ---------------------------------------------------------------------------
// Proxied tool call requests and results
// ---------------------------------------------------------------------------

/** A tool call request forwarded through the proxy. */
export type ProxiedMcpToolCall = {
	/** Original downstream tool name (not a Compass name). */
	toolName: string;
	/** Arguments for the downstream tool call. */
	arguments?: Record<string, unknown>;
};

export type HostedEvaluationRequestInput = ProxiedMcpToolCall & {
	agentContext?: EvaluateActionAgentContext;
	localFindings?: LocalFinding[];
};

/** Proxy decision before forwarding a tools/call request. */
export type ProxyDecision = {
	/** Whether the call is allowed, denied, or requires explicit approval. */
	outcome: "allow" | "deny" | "require_approval";
	/** Hosted allow/deny/confirm decision when the hosted backend was consulted. */
	hostedDecision?: HostedDecision;
	/** Human-readable reason for the decision. */
	reason: string;
	/** Suggested next action for the operator or client. */
	suggestedAction?: string;
	/** Router metadata (present when LLM router was consulted). */
	routerMetadata?: ProxyRouterMetadata;
};

// ---------------------------------------------------------------------------
// Router decision types
// ---------------------------------------------------------------------------

/** Classification from the LLM Router (added to proxy decisions). */
export type ProxyRouterClassification = "transfer" | "swap" | "skip" | "unknown";

/** Router metadata attached to proxy decisions. */
export type ProxyRouterMetadata = {
	/** Whether the LLM router was consulted. */
	consulted: boolean;
	/** Router classification result (only present if consulted). */
	classification?: ProxyRouterClassification;
	/** Router reasoning (only present if consulted). */
	reasoning?: string;
	/** Router latency in ms (only present if consulted). */
	latencyMs?: number;
};

// ---------------------------------------------------------------------------
// Proxy result envelopes
// ---------------------------------------------------------------------------

/** Result of listing downstream tools through the proxy. */
export type ProxyListToolsResult = {
	/** Tool descriptors from the downstream server. */
	tools: DownstreamMcpTool[];
	/** If discovery failed, a non-empty reason describing the failure. */
	errorReason?: string;
};

/** Result of forwarding a tools/call request through the proxy. */
export type ProxyCallToolResult = {
	/** "allow" if forwarded, otherwise the non-forwarded policy outcome. */
	outcome: "allow" | "deny" | "require_approval";
	/** Human-readable reason for the outcome. */
	reason: string;
	/** Suggested next action (always present for denials). */
	suggestedAction?: string;
	/** Downstream call result data (present only on allow). */
	data?: CallToolResult;
	/** Policy decision details (always present). */
	policyDecision?: ProxyDecision;
	/** Hosted audit reference for durable traceability. */
	auditRef?: string;
	/** Audit record ID for traceability. */
	auditId?: string;
};

// ---------------------------------------------------------------------------
// Proxy dispatcher config
// ---------------------------------------------------------------------------

/** Configuration for creating a proxy dispatcher instance. */
export type ProxyDispatcherConfig = {
	/** Downstream MCP server instance (fake for tests, real otherwise). */
	downstream?: DownstreamMcpClient;
	/** Hosted evaluation client used when hybrid guard is enabled. */
	hostedClient?: HostedClient;
	/** Local execution dependency for allowed tool calls. */
	executeTool?: (args: ProxiedMcpToolCall) => Promise<CallToolResult>;
	/** Feature flag that enables hosted guard evaluation. */
	hybridGuardEnabled?: boolean;
	/** Optional policy decision override for testing. */
	policyDecision?: ProxyDecision;
	/** Stable installation ID from local MCP config (used as userId for audit). */
	installationId?: string;
	/** Unique session ID generated per MCP session (used for audit grouping). */
	sessionId?: string;
};

/**
 * Minimal downstream MCP client interface that the proxy dispatcher depends on.
 * The real implementation will start a downstream stdio process; tests use
 * the fake fixture that implements this interface.
 */
export type DownstreamMcpClient = {
	/** Whether the downstream server is currently available. */
	readonly isAvailable: boolean;
	/** Start and initialize the downstream server, if the client is lazy. */
	start?: () => Promise<void>;
	/** List tools from the downstream server. */
	listTools(): Promise<DownstreamMcpTool[]>;
	/** Call a tool on the downstream server. */
	callTool(args: ProxiedMcpToolCall): Promise<unknown>;
	/** Forward a safe non-tool request unchanged. */
	forwardSafeRequest?: (args: {
		method: string;
		params?: Record<string, unknown>;
	}) => Promise<unknown>;
	/** Forward a safe non-tool notification unchanged. */
	forwardSafeNotification?: (args: {
		method: string;
		params?: Record<string, unknown>;
	}) => Promise<void>;
	/** Close the downstream connection and child process. */
	close?: () => Promise<void>;
	/** Whether this is a fake/test client (for type narrowing in tests). */
	readonly isTestClient?: boolean;
};

// ---------------------------------------------------------------------------
// Safe non-tool MCP method classification
// ---------------------------------------------------------------------------

/**
 * MCP methods that are safe to forward without tools/call interception.
 *
 * tools/call is explicitly EXCLUDED — it must always pass through the
 * policy interceptor before forwarding. Unknown methods fail closed.
 */
export const PROXY_SAFE_METHODS: readonly string[] = [
	"initialize",
	"ping",
	"notifications/initialized",
	"notifications/cancelled",
	"notifications/message",
	"notifications/progress",
	"notifications/tools/list_changed",
] as const;

/**
 * Check whether a non-tool MCP method is safe to forward unchanged.
 *
 * Returns true only for methods in the explicit safe allowlist.
 * tools/call is never classified as safe — it must go through interception.
 * Unknown methods fail closed (return false).
 */
export function isSafeNonToolMethod(method: string): boolean {
	return PROXY_SAFE_METHODS.includes(method as (typeof PROXY_SAFE_METHODS)[number]);
}

// ---------------------------------------------------------------------------
// Config wrapping contracts
// ---------------------------------------------------------------------------

/** Result of wrapping a local MCP config for Compass proxy. */
export type ProxyConfigWrapResult = {
	/** Compass proxy command that the client will call. */
	proxyCommand: string;
	/** Preserved downstream command for startup. */
	downstreamCommand: string;
	/** Preserved downstream args for startup. */
	downstreamArgs: readonly string[];
	/** Preserved downstream working directory. */
	downstreamCwd?: string;
	/** Environment variable key names that are referenced (not raw values). */
	envReferences: readonly string[];
	/** Whether this is a single-downstream config (Wave 11 only supports one). */
	isSingleDownstream: boolean;
	/** Full wrapped config for internal use (secrets redacted from serialization). */
	wrappedConfig: Record<string, unknown>;
};
