import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createFakeDownstreamMcpServer } from "./fixtures/fakeDownstreamMcpServer";
import { createProxyDispatcher } from "../mcp/proxy/mcpProxyDispatcher";
import type { ProxiedMcpToolCall } from "../mcp/proxy/mcpProxyContracts";
import {
	listProxyAuditEvents,
	resetProxyAuditEvents,
} from "../mcp/proxy/mcpProxyAudit";
import type { HostedClient } from "../mcp/proxy/mcpHostedClientContracts";
import type { EvaluateActionResponse } from "@shared/evaluationContracts";

function createMockHostedClient(
	response: Partial<EvaluateActionResponse> = {},
): HostedClient {
	return {
		evaluateAction: vi.fn().mockResolvedValue({
			correlationId: "corr_test",
			decision: "allow",
			riskLevel: "low",
			reasons: ["HOSTED_TEST"],
			auditRef: "aud_test",
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

describe("MCP proxy hosted decision integration", () => {
	beforeEach(() => {
		resetProxyAuditEvents();
	});

	it("evaluates transfer-like tools with hosted evaluation", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const hostedClient = createMockHostedClient();
		const dispatcher = createHybridDispatcher(downstream, { hostedClient });

		const result = await dispatcher.callTool({
			toolName: "transfer_sol",
			arguments: { amount: 1, recipient: "wallet" },
		});

		expect(result.outcome).toBe("allow");
		expect(hostedClient.evaluateAction).toHaveBeenCalledTimes(1);
		const request = (hostedClient.evaluateAction as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(request.toolName).toBe("transfer_sol");
		expect(request.arguments).toEqual({ amount: 1, recipient: "wallet" });
		expect(request.localFindings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "ROUTABLE_MUTATION" }),
			]),
		);
	});

	it("evaluates swap-like tools with hosted evaluation", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const hostedClient = createMockHostedClient();
		const dispatcher = createHybridDispatcher(downstream, { hostedClient });

		const result = await dispatcher.callTool({
			toolName: "swap_tokens",
			arguments: { inputToken: "SOL", outputToken: "USDC" },
		});

		expect(result.outcome).toBe("allow");
		expect(hostedClient.evaluateAction).toHaveBeenCalledTimes(1);
		const request = (hostedClient.evaluateAction as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(request.toolName).toBe("swap_tokens");
		expect(request.arguments).toEqual({ inputToken: "SOL", outputToken: "USDC" });
		expect(request.localFindings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "ROUTABLE_MUTATION" }),
			]),
		);
	});

	it("skips hosted evaluation for locally allowed read-only tools", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const hostedClient = createMockHostedClient();
		const dispatcher = createHybridDispatcher(downstream, { hostedClient });

		const result = await dispatcher.callTool({
			toolName: "read_file",
			arguments: { path: "/tmp/example.txt" },
		});

		expect(result.outcome).toBe("allow");
		expect(hostedClient.evaluateAction).not.toHaveBeenCalled();
		expect(downstream.recordedCalls).toEqual([
			{ toolName: "read_file", arguments: { path: "/tmp/example.txt" } },
		]);
	});

	it("does not loosen a local gateway denial even when hosted allows", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const hostedClient = createMockHostedClient();
		const dispatcher = createHybridDispatcher(downstream, { hostedClient });

		const result = await dispatcher.callTool({
			toolName: "sign_and_send_transaction",
			arguments: { transaction: "base64" },
		});

		expect(result.outcome).toBe("deny");
		expect(hostedClient.evaluateAction).not.toHaveBeenCalled();
		expect(downstream.recordedCalls).toHaveLength(0);
	});

	it("keeps local proxy diagnostics empty during hosted routing", async () => {
		const downstream = createFakeDownstreamMcpServer();
		const dispatcher = createHybridDispatcher(downstream);

		await dispatcher.callTool({
			toolName: "swap_tokens",
			arguments: { inputToken: "SOL", outputToken: "USDC" },
		});

		expect(listProxyAuditEvents()).toEqual([]);
	});
});
