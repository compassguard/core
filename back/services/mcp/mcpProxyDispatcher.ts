/**
 * Proxy request dispatcher for Wave 11 MCP proxy.
 *
 * Dispatches MCP requests to proxy behavior: initialize, safe methods,
 * tools/list, and intercepted tools/call. Downstream `tools/list` is the
 * source of truth for public tool descriptors. `tools/call` is intercepted
 * by the policy interceptor before forwarding. All other requests either
 * pass through the safe-methods allowlist or fail closed.
 *
 * No native Compass MCP tool names, schemas, or static registry are used.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
	ProxyCallToolResult,
	ProxyDecision,
	ProxyDispatcherConfig,
	ProxyListToolsResult,
} from "./mcpProxyContracts";
import { isSafeNonToolMethod } from "./mcpProxyContracts";
import { evaluateProxyToolCallPolicy } from "./mcpProxyPolicyInterceptor";
import {
	markProxyAuditFailure,
	recordProxyAuditDenial,
	recordProxyAuditForwarding,
	recordProxyAuditIntent,
	redactSecretArguments,
} from "./mcpProxyAudit";

// ---------------------------------------------------------------------------
// Proxy dispatcher
// ---------------------------------------------------------------------------

/**
 * Create a proxy dispatcher that routes MCP requests through the proxy
 * boundary with policy interception and audit.
 *
 * The dispatcher depends on a downstream MCP client (injected via config).
 * Tests inject the fake fixture; production injects the real stdio client.
 */
export function createProxyDispatcher(
	config: ProxyDispatcherConfig,
): {
	listTools: () => Promise<ProxyListToolsResult>;
	callTool: (args: {
		toolName: string;
		arguments?: Record<string, unknown>;
	}) => Promise<ProxyCallToolResult>;
	forwardSafeRequest: (args: {
		method: string;
		params?: Record<string, unknown>;
	}) => Promise<unknown>;
} {
	const { downstream, policyDecision: policyOverride, auditFailure } = config;

	// If audit failure mode is requested (for testing), mark it now.
	if (auditFailure) {
		markProxyAuditFailure();
	}

	return {
		async listTools(): Promise<ProxyListToolsResult> {
			if (!downstream.isAvailable) {
				return {
					tools: [],
					errorReason:
						"Downstream MCP server is unavailable. " +
						"Proxy cannot discover tools from an unavailable downstream server.",
				};
			}

			try {
				const tools = await downstream.listTools();
				return { tools };
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				return {
					tools: [],
					errorReason:
						"Downstream tools/list discovery failed: " + errorMessage,
				};
			}
		},

		async callTool(args: {
			toolName: string;
			arguments?: Record<string, unknown>;
		}): Promise<ProxyCallToolResult> {
			// 1. Fail-closed: downstream unavailable
			if (!downstream.isAvailable) {
				const decision: ProxyDecision = {
					outcome: "deny",
					reason: "Downstream MCP server is unavailable; denying call fail-closed.",
					suggestedAction:
						"Restart the downstream server or check its configuration.",
				};
				recordProxyAuditDenial({
					toolName: args.toolName,
					policyDecision: decision,
					denialReason: decision.reason,
				});
				return {
					outcome: "deny",
					reason: decision.reason,
					suggestedAction: decision.suggestedAction,
					policyDecision: decision,
				};
			}

			// 2. Evaluate policy
			const evaluatedDecision = evaluateProxyToolCallPolicy(
				args.toolName,
				args.arguments,
				policyOverride ? { policyDecision: policyOverride } : undefined,
			);

			// 3. If policy does not allow, do NOT forward — return policy outcome
			if (evaluatedDecision.outcome !== "allow") {
				const decisionPrefix =
					evaluatedDecision.outcome === "deny" ? "denied" : "require_approval";
				const denialReason = `${decisionPrefix}: ${evaluatedDecision.reason}`;
				recordProxyAuditDenial({
					toolName: args.toolName,
					policyDecision: evaluatedDecision,
					denialReason,
				});
				return {
					outcome: evaluatedDecision.outcome,
					reason: denialReason,
					suggestedAction: evaluatedDecision.suggestedAction,
					policyDecision: evaluatedDecision,
				};
			}

			// 4. Policy allows — record audit intent before forwarding
			let auditId: string;
			try {
				auditId = recordProxyAuditIntent({
					toolName: args.toolName,
					policyDecision: evaluatedDecision,
				});
			} catch {
				// Audit write failure: fail closed, deny before forwarding
				const decision: ProxyDecision = {
					outcome: "deny",
					reason:
						"Proxy audit intent recording failed; denying call fail-closed to prevent unaudited forwarding.",
					suggestedAction:
						"Check proxy audit system health and retry.",
				};
				recordProxyAuditDenial({
					toolName: args.toolName,
					policyDecision: evaluatedDecision,
					denialReason: decision.reason,
				});
				return {
					outcome: "deny",
					reason: decision.reason,
					suggestedAction: decision.suggestedAction,
					policyDecision: decision,
				};
			}

			// 5. Forward allowed call to downstream
			try {
				const redactedArgs = redactSecretArguments(args.arguments);
				void redactedArgs; // Available for future audit enrichment

				const downstreamResult = await downstream.callTool({
					toolName: args.toolName,
					arguments: args.arguments,
				});

				// 6. Record forwarding outcome
				recordProxyAuditForwarding({
					toolName: args.toolName,
					policyDecision: evaluatedDecision,
					forwardingOutcome: "success",
					existingAuditId: auditId,
				});

				return {
					outcome: "allow",
					reason: `Tool "${args.toolName}" allowed and forwarded to downstream.`,
					data: downstreamResult as CallToolResult,
					policyDecision: evaluatedDecision,
					auditId,
				};
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);

				// Downstream call failure: deny fail-closed
				recordProxyAuditForwarding({
					toolName: args.toolName,
					policyDecision: evaluatedDecision,
					forwardingOutcome: "failure",
					existingAuditId: auditId,
				});

				const decision: ProxyDecision = {
					outcome: "deny",
					reason: `Downstream tools/call failed: ${errorMessage}. Denying fail-closed.`,
					suggestedAction:
						"Check downstream server health and retry.",
				};

				return {
					outcome: "deny",
					reason: decision.reason,
					suggestedAction: decision.suggestedAction,
					policyDecision: decision,
					auditId,
				};
			}
		},

		async forwardSafeRequest(args: {
			method: string;
			params?: Record<string, unknown>;
		}): Promise<unknown> {
			if (
				!isSafeNonToolMethod(args.method) ||
				args.method === "tools/call" ||
				isNotificationMethod(args.method)
			) {
				throw new Error(`Unsafe MCP method denied fail-closed: ${args.method}`);
			}
			if (!downstream.isAvailable || !downstream.forwardSafeRequest) {
				throw new Error(
					"Downstream MCP server is unavailable or cannot forward safe requests.",
				);
			}
			return downstream.forwardSafeRequest(args);
		},
	};
}

function isNotificationMethod(method: string): boolean {
	return method.startsWith("notifications/");
}

// Re-export audit helpers for test access and cleanup
export { resetProxyAuditEvents, listProxyAuditEvents } from "./mcpProxyAudit";
export type { DownstreamMcpTool } from "./mcpProxyContracts";
