/**
 * Proxy request dispatcher for Wave 11 MCP proxy.
 *
 * Dispatches MCP requests to proxy behavior: initialize, safe methods,
 * tools/list, and intercepted tools/call. Downstream `tools/list` is the
 * source of truth for public tool descriptors. `tools/call` is intercepted
 * by the policy interceptor and, when needed, evaluated by the hosted guard
 * before local execution. All other requests either pass through the
 * safe-methods allowlist or fail closed.
 *
 * No native Compass MCP tool names, schemas, or static registry are used.
 */

import { getPostHogClient, getInstallationDistinctId } from "@back/posthog/posthogClient";
import type {
	ProxyCallToolResult,
	ProxyDecision,
	ProxyDispatcherConfig,
	ProxiedMcpToolCall,
	ProxyListToolsResult,
} from "./mcpProxyContracts";
import { isSafeNonToolMethod } from "./mcpProxyContracts";
import {
	classifyProxyToolCall,
	evaluateProxyToolCallPolicy,
} from "./mcpProxyPolicyInterceptor";
import { buildEvaluateActionRequest } from "./mcpEvaluationRequest";
import {
	LOCAL_FINDING_SEVERITIES,
	type EvaluateActionResponse,
	type LocalFinding,
} from "@shared/evaluationContracts";

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
	const {
		downstream = createUnavailableDownstreamClient(),
		hostedClient,
		executeTool,
		policyDecision: policyOverride,
		installationId,
		sessionId,
	} = config;

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
			return callToolWithHybridGuard({
				args,
				hostedClient,
				executeTool,
				policyOverride,
				installationId,
				sessionId,
			});
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

async function callToolWithHybridGuard(input: {
	args: ProxiedMcpToolCall;
	hostedClient: ProxyDispatcherConfig["hostedClient"];
	executeTool: ProxyDispatcherConfig["executeTool"];
	policyOverride: ProxyDispatcherConfig["policyDecision"];
	installationId?: string;
	sessionId?: string;
}): Promise<ProxyCallToolResult> {
	const { args, hostedClient, executeTool, policyOverride, installationId, sessionId } = input;
	const localDecision = evaluateProxyToolCallPolicy(
		args.toolName,
		args.arguments,
		policyOverride ? { policyDecision: policyOverride } : undefined,
	);

	if (localDecision.outcome === "deny") {
		return mapDecisionResult(args.toolName, localDecision);
	}

	if (localDecision.outcome === "allow") {
		return executeAllowedToolCall({
			args,
			executeTool,
			decision: localDecision,
		});
	}

	if (!hostedClient) {
		return mapDecisionResult(args.toolName, {
			outcome: "deny",
			reason: "Hosted evaluation client is not configured; denying call fail-closed.",
			suggestedAction:
				"Set COMPASS_HOSTED_API_URL and COMPASS_HOSTED_API_KEY before enabling the hybrid guard.",
		});
	}

	getPostHogClient().capture({
		distinctId: installationId ?? getInstallationDistinctId(),
		event: "hybrid_guard_evaluation_requested",
		properties: {
			tool_name: args.toolName,
			local_outcome: localDecision.outcome,
			session_id: sessionId,
		},
	});

	const hostedResponse = await hostedClient.evaluateAction(
		buildEvaluateActionRequest({
			...args,
			localFindings: buildLocalFindings(args.toolName, localDecision),
			userId: installationId,
			sessionId,
		}),
	);

	getPostHogClient().capture({
		distinctId: installationId ?? getInstallationDistinctId(),
		event: "tool_call_evaluated",
		properties: {
			tool_name: args.toolName,
			outcome: hostedResponse.decision,
			risk_level: hostedResponse.riskLevel,
			reasons: hostedResponse.reasons,
			flow: "hybrid",
			session_id: sessionId,
		},
	});

	if (hostedResponse.decision !== "allow") {
		const hostedDecision = mapHostedDecision(hostedResponse);
		return {
			...mapDecisionResult(args.toolName, hostedDecision),
			auditRef: hostedResponse.auditRef,
			policyDecision: hostedDecision,
		};
	}

	return executeAllowedToolCall({
		args,
		executeTool,
		decision: {
			outcome: "allow",
			hostedDecision: hostedResponse.decision,
			reason: buildHostedReason(hostedResponse),
			suggestedAction: hostedResponse.suggestedAction,
		},
		auditRef: hostedResponse.auditRef,
	});
}

async function executeAllowedToolCall(input: {
	args: ProxiedMcpToolCall;
	executeTool: ProxyDispatcherConfig["executeTool"];
	decision: ProxyDecision;
	auditRef?: string;
}): Promise<ProxyCallToolResult> {
	const { args, executeTool, decision, auditRef } = input;

	if (!executeTool) {
		return mapDecisionResult(args.toolName, {
			outcome: "deny",
			reason: "No execution dependency is configured for allowed tool calls.",
			suggestedAction:
				"Inject a local execution dependency before enabling Compass hybrid guard.",
		});
	}

	try {
		const result = await executeTool(args);
		return {
			outcome: "allow",
			reason: `Tool "${args.toolName}" allowed for execution.`,
			data: result,
			policyDecision: decision,
			auditRef,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			outcome: "deny",
			reason: `Tool execution failed: ${errorMessage}. Denying fail-closed.`,
			suggestedAction: "Check the execution dependency and retry.",
			policyDecision: {
				outcome: "deny",
				hostedDecision: decision.hostedDecision,
				reason: `Tool execution failed: ${errorMessage}. Denying fail-closed.`,
				suggestedAction: "Check the execution dependency and retry.",
			},
			auditRef,
		};
	}
}

function mapHostedDecision(response: EvaluateActionResponse): ProxyDecision {
	return {
		outcome: response.decision === "confirm" ? "require_approval" : "deny",
		hostedDecision: response.decision,
		reason: buildHostedReason(response),
		suggestedAction: response.suggestedAction,
	};
}

function mapDecisionResult(
	toolName: string,
	decision: ProxyDecision,
): ProxyCallToolResult {
	const decisionPrefix =
		decision.outcome === "deny" ? "deny" : decision.outcome === "allow" ? "allow" : "require_approval";
	const reason = `${decisionPrefix}: ${decision.reason}`;

	return {
		outcome: decision.outcome,
		reason,
		suggestedAction: decision.suggestedAction,
		policyDecision: decision,
	};
}

function buildLocalFindings(
	toolName: string,
	decision: ProxyDecision,
): LocalFinding[] {
	return [
		{
			code: classifyProxyToolCall(toolName).toUpperCase(),
			severity:
				decision.outcome === "deny"
					? LOCAL_FINDING_SEVERITIES.BLOCK
					: LOCAL_FINDING_SEVERITIES.WARN,
			message: decision.reason,
		},
	];
}

function buildHostedReason(response: EvaluateActionResponse): string {
	return response.reasons.length > 0
		? response.reasons.join(", ")
		: "Hosted evaluation returned no reasons.";
}

function createUnavailableDownstreamClient(): ProxyDispatcherConfig["downstream"] {
	return {
		isAvailable: false,
		async listTools() {
			throw new Error("Downstream MCP server is unavailable.");
		},
		async callTool() {
			throw new Error("Downstream MCP server is unavailable.");
		},
	};
}

function isNotificationMethod(method: string): boolean {
	return method.startsWith("notifications/");
}

// Re-export audit helpers for test access and cleanup
export { resetProxyAuditEvents, listProxyAuditEvents } from "./mcpProxyAudit";
export type { DownstreamMcpTool } from "./mcpProxyContracts";
