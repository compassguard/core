import { describe, expect, it, vi } from "vitest";

import { buildEvaluateActionRequest } from "./mcpEvaluationRequest";

describe("mcpEvaluationRequest", () => {
	it("generates correlation and idempotency ids for hosted evaluation", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));

		const request = buildEvaluateActionRequest({
			toolName: " transfer_sol ",
			arguments: { recipient: "wallet", amountSol: 1 },
			localFindings: [
				{
					code: " routable_mutation ",
					severity: "warn",
					message: " hosted evaluation required ",
				},
			],
		});

		expect(request.correlationId).toMatch(/^corr_/);
		expect(request.idempotencyKey).toBe(`eval_${request.correlationId}`);
		expect(request.toolName).toBe("transfer_sol");
		expect(request.localFindings).toEqual([
			{
				code: "ROUTABLE_MUTATION",
				severity: "warn",
				message: "hosted evaluation required",
			},
		]);
		expect(request.requestedAt).toBe("2026-06-18T00:00:00.000Z");

		vi.useRealTimers();
	});

	it("drops empty agent context and empty local findings", () => {
		const request = buildEvaluateActionRequest({
			toolName: "read_file",
			agentContext: {
				clientName: "  ",
				userIntent: "inspect file",
				sessionId: "",
			},
			localFindings: [
				{ code: "", severity: "info", message: "ignored" },
				{ code: "read_only", severity: "info", message: "read only" },
			],
		});

		expect(request.agentContext).toEqual({ userIntent: "inspect file" });
		expect(request.localFindings).toEqual([
			{ code: "READ_ONLY", severity: "info", message: "read only" },
		]);
		expect(request.arguments).toBeUndefined();
	});
});
