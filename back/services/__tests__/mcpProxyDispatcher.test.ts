/**
 * Tests for Wave 11 MCP proxy dispatcher.
 *
 * Acceptance criteria covered:
 * - T11_1.2: tools/list passthrough, native tool absence
 * - T11_1.3: allowed/denied/fail-closed downstream tools/call
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
	NATIVE_COMPASS_TOOL_NAMES,
	HIDDEN_INTERNAL_PRIMITIVE_NAMES,
	createFakeDownstreamMcpServer,
} from "./fixtures/fakeDownstreamMcpServer";
import { createProxyDispatcher } from "../mcp/proxy/mcpProxyDispatcher";
import { PROXY_SAFE_METHODS } from "../mcp/proxy/mcpProxyContracts";
import type { ProxiedMcpToolCall } from "../mcp/proxy/mcpProxyContracts";
import { resetProxyAuditEvents } from "../mcp/proxy/mcpProxyAudit";
import { classifyProxyToolCall } from "../mcp/proxy/mcpProxyPolicyInterceptor";
import type { HostedClient } from "../mcp/proxy/mcpHostedClientContracts";
import type { EvaluateActionResponse } from "@shared/evaluationContracts";

function createMockHostedClient(
	response: Partial<EvaluateActionResponse> = {},
): HostedClient {
	return {
		evaluateAction: vi.fn().mockResolvedValue({
			correlationId: "corr_default",
			decision: "confirm",
			riskLevel: "medium",
			reasons: ["HOSTED_DEFAULT"],
			suggestedAction: "Request explicit human approval before execution.",
			auditRef: "aud_default",
			...response,
		}),
	};
}

function createTestExecuteTool(
	downstream: ReturnType<typeof createFakeDownstreamMcpServer>,
): (args: ProxiedMcpToolCall) => Promise<CallToolResult> {
	return async (args) => {
		if (!downstream.isAvailable) {
			throw new Error("Downstream MCP server is unavailable.");
		}
		return downstream.callTool(args) as Promise<CallToolResult>;
	};
}

function createHybridDispatcher(
	downstream: ReturnType<typeof createFakeDownstreamMcpServer>,
	overrides: Partial<Parameters<typeof createProxyDispatcher>[0]> = {},
) {
	return createProxyDispatcher({
		downstream,
		hybridGuardEnabled: true,
		hostedClient: overrides.hostedClient ?? createMockHostedClient(),
		executeTool: overrides.executeTool ?? createTestExecuteTool(downstream),
		...overrides,
	});
}

// Reset audit state between tests to prevent test pollution
describe("Wave 11 MCP proxy dispatcher — tools/list passthrough", () => {
	beforeEach(() => {
		resetProxyAuditEvents();
	});
	it("returns downstream tool descriptors unchanged via tools/list", async () => {
		
		const downstream = createFakeDownstreamMcpServer();

		const dispatcher = createProxyDispatcher({ downstream });
		const result = await dispatcher.listTools();

		// The proxy MUST return exactly the downstream tools — no additions
		const downstreamTools = await downstream.listTools();
		expect(result.tools).toHaveLength(downstreamTools.length);

		// Each downstream tool name must appear in the proxy response
		for (const downstreamTool of downstreamTools) {
			const proxyTool = result.tools.find(
				(t: { name: string }) => t.name === downstreamTool.name,
			);
			expect(proxyTool).toBeDefined();
			expect(proxyTool.name).toBe(downstreamTool.name);
		}
	});

	it("does NOT require static Compass-owned schema mapping", async () => {
		
		const downstream = createFakeDownstreamMcpServer();

		const dispatcher = createProxyDispatcher({ downstream });
		const result = await dispatcher.listTools();

		// Proxy tools MUST come from downstream, not from a static registry.
		// Verify by checking that tool descriptors match what downstream provided,
		// not some Compass-compiled schema.
		const downstreamTools = await downstream.listTools();
		for (const downstreamTool of downstreamTools) {
			const proxyTool = result.tools.find(
				(t: { name: string }) => t.name === downstreamTool.name,
			);
			expect(proxyTool).toBeDefined();
			// The proxy returns downstream descriptors without requiring
			// a Compass-maintained schema map.
			expect(proxyTool.inputSchema).toEqual(downstreamTool.inputSchema);
		}
	});

	it("does NOT expose compass_transfer, compass_swap, helper tools, or hidden internal primitives in tools/list", async () => {
		
		const downstream = createFakeDownstreamMcpServer();

		const dispatcher = createProxyDispatcher({ downstream });
		const result = await dispatcher.listTools();
		const toolNames = result.tools.map((t: { name: string }) => t.name);

		// Native Compass tool names MUST NOT appear in the proxy surface
		for (const nativeName of NATIVE_COMPASS_TOOL_NAMES) {
			expect(toolNames).not.toContain(nativeName);
		}

		// Hidden internal primitives MUST NOT appear either
		for (const internalName of HIDDEN_INTERNAL_PRIMITIVE_NAMES) {
			expect(toolNames).not.toContain(internalName);
		}
	});

	it("preserves downstream tool names without Compass namespacing or renaming", async () => {
		// Use a downstream with custom tool names to verify no renaming
		const customTools: import("../mcp/mcpProxyContracts").DownstreamMcpTool[] = [
			{
				name: "custom_tool_alpha",
				description: "A custom tool from downstream.",
				inputSchema: {
					type: "object" as const,
					properties: { input: { type: "string" } },
					required: ["input"],
				},
				descriptor: {
					name: "custom_tool_alpha",
					description: "A custom tool from downstream.",
					inputSchema: {
						type: "object",
						properties: { input: { type: "string" } },
						required: ["input"],
					},
				},
			},
			{
				name: "custom_tool_beta",
				description: "Another custom tool.",
				inputSchema: {
					type: "object" as const,
					properties: { count: { type: "number" } },
				},
				descriptor: {
					name: "custom_tool_beta",
					description: "Another custom tool.",
					inputSchema: {
						type: "object",
						properties: { count: { type: "number" } },
					},
				},
			},
		];
		const downstream = createFakeDownstreamMcpServer({ tools: customTools });

		const dispatcher = createProxyDispatcher({ downstream });
		const result = await dispatcher.listTools();

		// Tool names are exactly as downstream provided — no prefix or suffix
		const resultNames = result.tools.map((t: { name: string }) => t.name);
		expect(resultNames).toEqual(["custom_tool_alpha", "custom_tool_beta"]);
	});

	it("returns an empty tools/list when downstream has no tools", async () => {
		
		const downstream = createFakeDownstreamMcpServer({ tools: [] });

		const dispatcher = createProxyDispatcher({ downstream });
		const result = await dispatcher.listTools();

		expect(result.tools).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// T11_1.3: Allowed, denied, and fail-closed downstream tools/call
// ---------------------------------------------------------------------------

describe("Wave 11 MCP proxy dispatcher — tools/call enforcement", () => {
	beforeEach(() => {
		resetProxyAuditEvents();
	});
	// --- Allowed call forwarding ---

	it("forwards allowed downstream tool call with original tool name and arguments", async () => {
		
		const downstream = createFakeDownstreamMcpServer();
		const callArgs = { path: "/tmp/important.txt" };

		const dispatcher = createHybridDispatcher(downstream);
		const result = await dispatcher.callTool({
			toolName: "read_file",
			arguments: callArgs,
		});

		// The call must have been forwarded to the downstream server
		expect(downstream.recordedCalls).toHaveLength(1);
		expect(downstream.recordedCalls[0].toolName).toBe("read_file");
		expect(downstream.recordedCalls[0].arguments).toEqual(callArgs);

		// The result must reflect successful forwarding
		expect(result.outcome).toBe("allow");
	});

	it("allows wallet UI/bootstrap tool calls and forwards them", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "show_wallet_app",
			arguments: {},
		});

		expect(result.outcome).toBe("allow");
		expect(downstream.recordedCalls).toEqual([
			{ toolName: "show_wallet_app", arguments: {} },
		]);
	});

	it("allows tokenized read-only wallet balance calls and forwards them", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "get_wallet_balance",
			arguments: { wallet: "wallet-address" },
		});

		expect(result.outcome).toBe("allow");
		expect(downstream.recordedCalls).toEqual([
			{ toolName: "get_wallet_balance", arguments: { wallet: "wallet-address" } },
		]);
	});

	it("allows namespaced wallet UI/bootstrap tool calls and forwards them", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "compass_show_wallet_app",
			arguments: {},
		});

		expect(result.outcome).toBe("allow");
		expect(downstream.recordedCalls).toEqual([
			{ toolName: "compass_show_wallet_app", arguments: {} },
		]);
	});

	it("preserves downstream tool-level error results for allowed calls", async () => {
		const downstream = createFakeDownstreamMcpServer();
		downstream.setCallResult("read_file", {
			content: [{ type: "text", text: "File not found" }],
			structuredContent: { code: "ENOENT", path: "/missing.txt" },
			isError: true,
		});

		const dispatcher = createHybridDispatcher(downstream);
		const result = await dispatcher.callTool({
			toolName: "read_file",
			arguments: { path: "/missing.txt" },
		});

		expect(result.outcome).toBe("allow");
		expect(result.data).toEqual({
			content: [{ type: "text", text: "File not found" }],
			structuredContent: { code: "ENOENT", path: "/missing.txt" },
			isError: true,
		});
	});

	it("forwards multiple allowed calls and records each one", async () => {
		
		const downstream = createFakeDownstreamMcpServer();

		const dispatcher = createHybridDispatcher(downstream);

		await dispatcher.callTool({
			toolName: "read_file",
			arguments: { path: "/a.txt" },
		});
		await dispatcher.callTool({
			toolName: "list_directory",
			arguments: { path: "/home" },
		});

		expect(downstream.recordedCalls).toHaveLength(2);
		expect(downstream.recordedCalls[0].toolName).toBe("read_file");
		expect(downstream.recordedCalls[1].toolName).toBe("list_directory");
	});

	// --- Denied call blocking ---

	it("requires approval for unknown tool calls and does NOT forward", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "rebalance_portfolio",
			arguments: { target: "aggressive" },
		});

		expect(result.outcome).toBe("require_approval");
		expect(result.reason).toContain("require_approval");
		expect(result.suggestedAction).toMatch(/human approval|policy rule/i);
		expect(downstream.recordedCalls).toHaveLength(0);
	});

	it("requires approval for ambiguous read-plus-mutation tool calls and does NOT forward", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "get_or_create_wallet",
			arguments: { owner: "user-id" },
		});

		expect(result.outcome).toBe("require_approval");
		expect(result.reason).toContain("require_approval");
		expect(downstream.recordedCalls).toHaveLength(0);
	});

	it("denies sensitive/signing tool calls and does NOT forward", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "sign_and_send_transaction",
			arguments: { transaction: "base64" },
		});

		expect(result.outcome).toBe("deny");
		expect(result.reason).toContain("denied");
		expect(downstream.recordedCalls).toHaveLength(0);
	});

	it.each([
		"sign_message",
		"personal_sign",
		"signTypedData",
		"eth_signTypedData_v4",
		"wallet_signTransaction",
		"signTransaction",
		"signAndSendTransaction",
	])(
		"denies common signing tool %s and does NOT forward",
		async (toolName) => {
			const downstream = createFakeDownstreamMcpServer();
			const dispatcher = createHybridDispatcher(downstream);

			const result = await dispatcher.callTool({
				toolName,
				arguments: { payload: "message" },
			});

			expect(result.outcome).toBe("deny");
			expect(result.reason).toContain("denied");
			expect(downstream.recordedCalls).toHaveLength(0);
		},
	);

	it.each(["assign_role", "signal_status", "design_token"])(
		"does not classify non-signing word %s as signing",
		(toolName) => {
			expect(classifyProxyToolCall(toolName)).not.toBe("signing");
		},
	);

	it("denies a tool call that fails policy and does NOT forward to downstream", async () => {
		
		const downstream = createFakeDownstreamMcpServer();

		// The proxy dispatcher must evaluate policy before forwarding.
		// When policy denies, the downstream should NOT receive the call.
		const dispatcher = createHybridDispatcher(downstream, {
			policyDecision: {
				outcome: "deny",
				reason: "Tool is classified as dangerous and policy denies execution.",
				suggestedAction: "Use a read-only alternative instead.",
			},
		});

		const result = await dispatcher.callTool({
			toolName: "execute_command",
			arguments: { command: "rm -rf /" },
		});

		// The call must NOT have been forwarded to downstream
		expect(downstream.recordedCalls).toHaveLength(0);

		// The proxy must return a denial
		expect(result.outcome).toBe("deny");
		expect(result.reason).toContain("deny");
		expect(result.suggestedAction).toBeDefined();
	});

	it("returns stable denial reason and suggestedAction for denied calls", async () => {
		
		const downstream = createFakeDownstreamMcpServer();

		const dispatcher = createHybridDispatcher(downstream, {
			policyDecision: {
				outcome: "deny",
				reason: "Policy denied this tool call.",
				suggestedAction: "Try a safer approach.",
			},
		});

		const result = await dispatcher.callTool({
			toolName: "execute_command",
			arguments: { command: "dangerous_op" },
		});

		expect(result.outcome).toBe("deny");
		// The reason must contain meaningful text, not just an error code
		expect(typeof result.reason).toBe("string");
		expect(result.reason.length).toBeGreaterThan(0);
		// suggestedAction must be present and actionable
		expect(result.suggestedAction).toBeDefined();
		expect(typeof result.suggestedAction).toBe("string");
		expect(result.suggestedAction!.length).toBeGreaterThan(0);
	});

	// --- Fail-closed behavior ---

	it("denies calls when downstream is unavailable and does NOT forward", async () => {
		
		const downstream = createFakeDownstreamMcpServer();
		downstream.setStartupError(
			new Error("Downstream server failed to start."),
		);

		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "read_file",
			arguments: { path: "/etc/hosts" },
		});

		// Must deny — unavailable downstream is not a safe pass-through
		expect(result.outcome).toBe("deny");
		expect(result.reason).toContain("unavailable");
		// The call must not have reached downstream
		expect(downstream.recordedCalls).toHaveLength(0);
	});

	it("denies calls when downstream tools/list discovery fails", async () => {
		
		const downstream = createFakeDownstreamMcpServer();
		downstream.setListError(
			new Error("Downstream tools/list discovery failed."),
		);

		const dispatcher = createHybridDispatcher(downstream);

		// Even listing tools should fail safely
		const listResult = await dispatcher.listTools();

		// When discovery fails, Compass must fail closed — no tool list
		expect(listResult.tools).toEqual([]);
		// The proxy should signal the discovery failure
		expect(listResult.errorReason).toBeDefined();
	});

	it("denies calls when downstream tools/call fails (fail-closed forwarding)", async () => {
		
		const downstream = createFakeDownstreamMcpServer();
		downstream.setCallError(
			new Error("Downstream tools/call internal error."),
		);

		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "read_file",
			arguments: { path: "/etc/hosts" },
		});

		// A downstream call failure during an allowed call must deny
		expect(result.outcome).toBe("deny");
		expect(result.reason).toBeTruthy();
	});

	it("denies calls when policy evaluation fails without forwarding", async () => {
		
		const downstream = createFakeDownstreamMcpServer();

		const dispatcher = createHybridDispatcher(downstream, {
			policyDecision: {
				outcome: "deny",
				reason: "Policy evaluation failed — classifying as deny for safety.",
				suggestedAction: "Retry after verifying policy configuration.",
			},
		});

		const result = await dispatcher.callTool({
			toolName: "read_file",
			arguments: { path: "/tmp/data" },
		});

		// Policy failure means deny — the downstream must NOT be called
		expect(result.outcome).toBe("deny");
		expect(downstream.recordedCalls).toHaveLength(0);
	});

	it("no longer depends on local audit logging before forwarding", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "read_file",
			arguments: { path: "/tmp/readme.md" },
		});

		expect(result.outcome).toBe("allow");
		expect(downstream.recordedCalls).toHaveLength(1);
	});

	it("does NOT classify tools/call as a safe non-tool method", async () => {
		
		

		// tools/call must NOT be in the safe-methods allowlist
		expect(PROXY_SAFE_METHODS).not.toContain("tools/call");
	});

	it("forwards safe non-tool requests through the explicit allowlist", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createProxyDispatcher({ downstream });

		const result = await dispatcher.forwardSafeRequest({ method: "ping" });

		expect(result).toEqual({ forwarded: true, method: "ping" });
		expect(downstream.forwardedSafeRequests).toEqual([{ method: "ping" }]);
	});

	it("denies unsafe non-tool requests fail-closed", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createProxyDispatcher({ downstream });

		await expect(
			dispatcher.forwardSafeRequest({ method: "resources/read" }),
		).rejects.toThrow(/Unsafe MCP method denied/);
		expect(downstream.forwardedSafeRequests).toHaveLength(0);
	});
});

describe("Wave 11 MCP proxy dispatcher — hybrid hosted guard", () => {
	it("skips hosted evaluation for deterministic local denials", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const hostedClient: HostedClient = {
			evaluateAction: vi.fn(),
		};
		const executeTool = vi.fn();
		const dispatcher = createProxyDispatcher({
			downstream,
			hostedClient,
			executeTool,
			hybridGuardEnabled: true,
		});

		const result = await dispatcher.callTool({
			toolName: "sign_and_send_transaction",
			arguments: { transaction: "base64" },
		});

		expect(result.outcome).toBe("deny");
		expect(hostedClient.evaluateAction).not.toHaveBeenCalled();
		expect(executeTool).not.toHaveBeenCalled();
	});

	it("blocks execution when hosted evaluation denies a routed mutation", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const hostedClient: HostedClient = {
			evaluateAction: vi.fn().mockResolvedValue({
				correlationId: "corr_hosted_deny",
				decision: "deny",
				riskLevel: "high",
				reasons: ["TRANSFER_UNKNOWN_RECIPIENT"],
				suggestedAction: "Review the destination wallet before retrying.",
				auditRef: "aud_hosted_deny",
			}),
		};
		const executeTool = vi.fn();
		const dispatcher = createProxyDispatcher({
			downstream,
			hostedClient,
			executeTool,
			hybridGuardEnabled: true,
		});

		const result = await dispatcher.callTool({
			toolName: "transfer_sol",
			arguments: { recipient: "wallet", amountSol: 1 },
		});

		expect(result.outcome).toBe("deny");
		expect(result.auditRef).toBe("aud_hosted_deny");
		expect(executeTool).not.toHaveBeenCalled();
	});

	it("returns approval when hosted evaluation requests confirmation", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const hostedClient: HostedClient = {
			evaluateAction: vi.fn().mockResolvedValue({
				correlationId: "corr_hosted_confirm",
				decision: "confirm",
				riskLevel: "medium",
				reasons: ["TRANSFER_UNKNOWN_RECIPIENT"],
				suggestedAction: "Request explicit user confirmation before execution.",
				auditRef: "aud_hosted_confirm",
			}),
		};
		const executeTool = vi.fn();
		const dispatcher = createProxyDispatcher({
			downstream,
			hostedClient,
			executeTool,
			hybridGuardEnabled: true,
		});

		const result = await dispatcher.callTool({
			toolName: "transfer_sol",
			arguments: { recipient: "wallet", amountSol: 1 },
		});

		expect(result.outcome).toBe("require_approval");
		expect(result.auditRef).toBe("aud_hosted_confirm");
		expect(executeTool).not.toHaveBeenCalled();
	});

	it("fails closed when hosted evaluation returns a timeout denial", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const hostedClient: HostedClient = {
			evaluateAction: vi.fn().mockResolvedValue({
				correlationId: "corr_hosted_timeout",
				decision: "deny",
				riskLevel: "high",
				reasons: ["HOSTED_TIMEOUT"],
				suggestedAction: "Check hosted backend health before retrying.",
				auditRef: "local_fail_closed_corr_hosted_timeout",
			}),
		};
		const executeTool = vi.fn();
		const dispatcher = createProxyDispatcher({
			downstream,
			hostedClient,
			executeTool,
			hybridGuardEnabled: true,
		});

		const result = await dispatcher.callTool({
			toolName: "transfer_sol",
			arguments: { recipient: "wallet", amountSol: 1 },
		});

		expect(result.outcome).toBe("deny");
		expect(result.auditRef).toBe("local_fail_closed_corr_hosted_timeout");
		expect(executeTool).not.toHaveBeenCalled();
	});

	it("executes routed mutations when hosted evaluation allows them", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const hostedClient: HostedClient = {
			evaluateAction: vi.fn().mockResolvedValue({
				correlationId: "corr_hosted_allow",
				decision: "allow",
				riskLevel: "low",
				reasons: ["ROUTER_SKIP_ALLOW"],
				auditRef: "aud_hosted_allow",
			}),
		};
		const executeTool = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
			structuredContent: { ok: true },
			isError: false,
		});
		const dispatcher = createProxyDispatcher({
			downstream,
			hostedClient,
			executeTool,
			hybridGuardEnabled: true,
		});

		const result = await dispatcher.callTool({
			toolName: "transfer_sol",
			arguments: { recipient: "wallet", amountSol: 1 },
		});

		expect(result.outcome).toBe("allow");
		expect(result.auditRef).toBe("aud_hosted_allow");
		expect(executeTool).toHaveBeenCalledWith({
			toolName: "transfer_sol",
			arguments: { recipient: "wallet", amountSol: 1 },
		});
	});
});

describe("Hosted guard integration (migrated from legacy LLM Router)", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		resetProxyAuditEvents();
		vi.restoreAllMocks();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = { ...originalEnv };
	});

	it("requires approval for ambiguous tools when hosted evaluation confirms", async () => {
		process.env.COMPASS_LLM_ROUTER_ENABLED = "false";
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "rebalance_portfolio",
			arguments: { target: "aggressive" },
		});

		expect(result.outcome).toBe("require_approval");
		expect(downstream.recordedCalls).toHaveLength(0);
	});

	it("allows when hosted evaluation allows an ambiguous tool", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream, {
			hostedClient: createMockHostedClient({
				decision: "allow",
				riskLevel: "low",
				reasons: ["HOSTED_ALLOW"],
				suggestedAction: undefined,
			}),
		});

		const result = await dispatcher.callTool({
			toolName: "summarize_portfolio",
			arguments: { wallet: "wallet" },
		});

		expect(result.outcome).toBe("allow");
		expect(downstream.recordedCalls).toEqual([
			{ toolName: "summarize_portfolio", arguments: { wallet: "wallet" } },
		]);
	});

	it("allows when hosted evaluation allows a transfer-like action", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream, {
			hostedClient: createMockHostedClient({
				decision: "allow",
				riskLevel: "low",
				reasons: ["HOSTED_ALLOW"],
				suggestedAction: undefined,
			}),
		});

		const result = await dispatcher.callTool({
			toolName: "portfolio_action",
			arguments: { amount: 1, recipient: "wallet" },
		});

		expect(result.outcome).toBe("allow");
		expect(downstream.recordedCalls).toHaveLength(1);
	});

	it("denies when hosted evaluation denies a transfer-like action", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream, {
			hostedClient: createMockHostedClient({
				decision: "deny",
				riskLevel: "high",
				reasons: ["HOSTED_DENY"],
				suggestedAction: "Review before retrying.",
			}),
		});

		const result = await dispatcher.callTool({
			toolName: "portfolio_action",
			arguments: { amount: 1, recipient: "wallet" },
		});

		expect(result.outcome).toBe("deny");
		expect(downstream.recordedCalls).toHaveLength(0);
	});

	it("allows when hosted evaluation allows a swap-like action", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream, {
			hostedClient: createMockHostedClient({
				decision: "allow",
				riskLevel: "low",
				reasons: ["HOSTED_ALLOW"],
				suggestedAction: undefined,
			}),
		});

		const result = await dispatcher.callTool({
			toolName: "token_action",
			arguments: { inputToken: "SOL", outputToken: "USDC" },
		});

		expect(result.outcome).toBe("allow");
		expect(downstream.recordedCalls).toHaveLength(1);
	});

	it("requires approval when hosted evaluation confirms an ambiguous tool", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		const result = await dispatcher.callTool({
			toolName: "rebalance_portfolio",
			arguments: { target: "aggressive" },
		});

		expect(result.outcome).toBe("require_approval");
		expect(downstream.recordedCalls).toHaveLength(0);
	});
});
