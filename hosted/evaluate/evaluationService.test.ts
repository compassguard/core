import { describe, expect, it, vi } from "vitest";

import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import { LLM_GUARD_DECISIONS } from "@shared/llmDecisionContracts";
import {
	createEvaluationService,
	type EvaluationServiceDependencies,
} from "./evaluationService";
import type { EvaluateActionRequest } from "./evaluationContracts";

function createRequest(overrides: Partial<EvaluateActionRequest> = {}): EvaluateActionRequest {
	return {
		correlationId: "corr_test_1",
		idempotencyKey: "idem_test_1",
		toolName: "transfer_sol",
		arguments: {
			amountUsd: 5,
			recipient: "wallet_123",
			recipientKnown: true,
		},
		agentContext: {
			clientName: "vitest",
			sessionId: "session_123",
		},
		localFindings: [
			{
				code: "ROUTABLE_MUTATION",
				severity: "warn",
				message: "Needs hosted evaluation.",
			},
		],
		requestedAt: "2026-06-17T12:00:00.000Z",
		...overrides,
	};
}

function createDependencies(
	overrides: Partial<EvaluationServiceDependencies> = {},
): EvaluationServiceDependencies {
	return {
		routeToolCall: vi.fn().mockResolvedValue({
			classification: "transfer",
			reasoning: "Looks like a transfer",
			latencyMs: 12,
		}),
		callLlmJudge: vi.fn().mockResolvedValue({
			decision: LLM_GUARD_DECISIONS.ALLOW,
			confidence: 0.9,
			reasonCodes: ["LLM_ALLOW"],
			rationale: "Within limits.",
		}),
		loadPolicy: vi.fn(),
		evaluatePolicy: vi.fn(),
		writeAudit: vi.fn().mockResolvedValue({
			auditRef: "aud_test_1",
			correlationId: "corr_test_1",
			idempotencyKey: "idem_test_1",
			created: true,
		}),
		...overrides,
	};
}

describe("createEvaluationService", () => {
	it("allows skip classifications without calling the LLM judge", async () => {
		const deps = createDependencies({
			routeToolCall: vi.fn().mockResolvedValue({
				classification: "skip",
				reasoning: "Read-only helper.",
				latencyMs: 4,
			}),
		});
		const service = createEvaluationService(deps);

		const response = await service.evaluateAction(
			createRequest({ toolName: "get_wallet_holdings" }),
		);

		expect(response).toMatchObject({
			correlationId: "corr_test_1",
			decision: "allow",
			riskLevel: "low",
			auditRef: "aud_test_1",
		});
		expect(response.reasons).toContain("ROUTER_SKIP_ALLOW");
		expect(deps.callLlmJudge).not.toHaveBeenCalled();
		expect(deps.writeAudit).toHaveBeenCalledTimes(1);
	});

	it("passes unknown classifications to the LLM judge for decision", async () => {
		const deps = createDependencies({
			routeToolCall: vi.fn().mockResolvedValue({
				classification: "unknown",
				reasoning: "Could not classify.",
				latencyMs: 8,
			}),
			callLlmJudge: vi.fn().mockResolvedValue({
				decision: LLM_GUARD_DECISIONS.REQUIRE_HUMAN_APPROVAL,
				confidence: 0.6,
				reasonCodes: ["LLM_UNKNOWN_TOOL_ESCALATED"],
				rationale: "Cannot determine intent with certainty.",
			}),
		});
		const service = createEvaluationService(deps);

		const response = await service.evaluateAction(createRequest());

		expect(response).toMatchObject({
			decision: "confirm",
			riskLevel: "medium",
			auditRef: "aud_test_1",
		});
		expect(response.reasons).toContain("ROUTER_UNKNOWN");
		expect(response.reasons).toContain("LLM_UNKNOWN_TOOL_ESCALATED");
		expect(deps.callLlmJudge).toHaveBeenCalledTimes(1);
		expect(deps.evaluatePolicy).not.toHaveBeenCalled();
	});

	it("allows unknown when LLM judge determines it is safe", async () => {
		const deps = createDependencies({
			routeToolCall: vi.fn().mockResolvedValue({
				classification: "unknown",
				reasoning: "Could not classify.",
				latencyMs: 8,
			}),
			callLlmJudge: vi.fn().mockResolvedValue({
				decision: LLM_GUARD_DECISIONS.ALLOW,
				confidence: 0.85,
				reasonCodes: ["LLM_ALLOW"],
				rationale: "Tool appears safe.",
			}),
		});
		const service = createEvaluationService(deps);

		const response = await service.evaluateAction(createRequest());

		expect(response).toMatchObject({
			decision: "allow",
			riskLevel: "low",
			auditRef: "aud_test_1",
		});
		expect(response.reasons).toContain("ROUTER_UNKNOWN");
		expect(response.reasons).toContain("LLM_ALLOW");
	});

	it("denies unknown when LLM judge determines it is dangerous", async () => {
		const deps = createDependencies({
			routeToolCall: vi.fn().mockResolvedValue({
				classification: "unknown",
				reasoning: "Could not classify.",
				latencyMs: 8,
			}),
			callLlmJudge: vi.fn().mockResolvedValue({
				decision: LLM_GUARD_DECISIONS.DENY,
				confidence: 0.95,
				reasonCodes: ["LLM_DENY"],
				rationale: "Potentially dangerous.",
			}),
		});
		const service = createEvaluationService(deps);

		const response = await service.evaluateAction(createRequest());

		expect(response).toMatchObject({
			decision: "deny",
			riskLevel: "medium",
			auditRef: "aud_test_1",
		});
		expect(response.reasons).toContain("ROUTER_UNKNOWN");
		expect(response.reasons).toContain("LLM_DENY");
	});

	it("applies policy and lets the LLM tighten an allowed transfer into confirm", async () => {
		const deps = createDependencies({
			loadPolicy: vi.fn().mockReturnValue({ policy_id: "default-conservative" }),
			evaluatePolicy: vi.fn().mockReturnValue({
				decision: COMPASS_DECISIONS.ALLOW,
				policyId: "default-conservative",
				reasonCodes: ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
				evaluatedRules: ["transfers.max_usd_without_approval"],
			}),
			callLlmJudge: vi.fn().mockResolvedValue({
				decision: LLM_GUARD_DECISIONS.REQUIRE_HUMAN_APPROVAL,
				confidence: 0.92,
				reasonCodes: ["LLM_ESCALATED_TRANSFER"],
				rationale: "Needs explicit confirmation.",
			}),
		});
		const service = createEvaluationService(deps);

		const response = await service.evaluateAction(createRequest());

		expect(response).toMatchObject({
			decision: "confirm",
			riskLevel: "medium",
			auditRef: "aud_test_1",
			suggestedAction: "Request explicit user confirmation before execution.",
		});
		expect(response.reasons).toEqual(
			expect.arrayContaining([
				"TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT",
				"LLM_ESCALATED_TRANSFER",
			]),
		);
		expect(deps.callLlmJudge).toHaveBeenCalledTimes(1);
	});

	it("runs the LLM judge for swap classifications too", async () => {
		const deps = createDependencies({
			routeToolCall: vi.fn().mockResolvedValue({
				classification: "swap",
				reasoning: "Looks like a swap",
				latencyMs: 10,
			}),
			loadPolicy: vi.fn().mockReturnValue({ policy_id: "default-conservative" }),
			evaluatePolicy: vi.fn().mockReturnValue({
				decision: COMPASS_DECISIONS.ALLOW,
				policyId: "default-conservative",
				reasonCodes: ["SWAP_WITHIN_LIMIT_KNOWN_TOKEN"],
				evaluatedRules: ["swaps.max_usd_without_approval"],
			}),
		});
		const service = createEvaluationService(deps);

		const response = await service.evaluateAction(
			createRequest({
				toolName: "swap_sol_to_usdc",
				arguments: {
					amountUsd: 5,
					tokenMint: "mint_123",
					tokenKnown: true,
					protocol: "orca",
					slippageBps: 50,
				},
			}),
		);

		expect(response).toMatchObject({
			decision: "allow",
			riskLevel: "low",
			auditRef: "aud_test_1",
		});
		expect(deps.callLlmJudge).toHaveBeenCalledTimes(1);
	});

	it("keeps policy denials even when the LLM would allow", async () => {
		const deps = createDependencies({
			loadPolicy: vi.fn().mockReturnValue({ policy_id: "default-conservative" }),
			evaluatePolicy: vi.fn().mockReturnValue({
				decision: COMPASS_DECISIONS.DENY,
				policyId: "default-conservative",
				reasonCodes: ["TRANSFER_BLOCKED_RECIPIENT"],
				evaluatedRules: ["transfers.blocked_recipients"],
			}),
			callLlmJudge: vi.fn().mockResolvedValue({
				decision: LLM_GUARD_DECISIONS.ALLOW,
				confidence: 0.99,
				reasonCodes: ["LLM_ALLOW"],
				rationale: "Looks fine.",
			}),
		});
		const service = createEvaluationService(deps);

		const response = await service.evaluateAction(createRequest());

		expect(response).toMatchObject({
			decision: "deny",
			riskLevel: "high",
			suggestedAction: "Review the policy and risk signals before retrying.",
		});
		expect(response.reasons).toEqual(
			expect.arrayContaining(["TRANSFER_BLOCKED_RECIPIENT"]),
		);
	});

	it("persists audit context for evaluated actions", async () => {
		const deps = createDependencies({
			loadPolicy: vi.fn().mockReturnValue({ policy_id: "default-conservative" }),
			evaluatePolicy: vi.fn().mockReturnValue({
				decision: COMPASS_DECISIONS.ALLOW,
				policyId: "default-conservative",
				reasonCodes: ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
				evaluatedRules: ["transfers.max_usd_without_approval"],
			}),
		});
		const service = createEvaluationService(deps);

		await service.evaluateAction(
			createRequest({
				arguments: {
					amountUsd: 5,
					recipient: "wallet_123",
					recipientKnown: true,
				},
				userId: "user_123",
				sessionId: "session_123",
			}),
		);

		expect(deps.writeAudit).toHaveBeenCalledWith({
			idempotencyKey: "idem_test_1",
			userId: "user_123",
			sessionId: "session_123",
			entry: expect.objectContaining({
				correlationId: "corr_test_1",
				toolName: "transfer_sol",
			}),
		});
	});

	it("handles malformed runtime arguments without throwing", async () => {
		const deps = createDependencies({
			loadPolicy: vi.fn().mockReturnValue({ policy_id: "default-conservative" }),
			evaluatePolicy: vi.fn().mockReturnValue({
				decision: COMPASS_DECISIONS.ALLOW,
				policyId: "default-conservative",
				reasonCodes: ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
				evaluatedRules: ["transfers.max_usd_without_approval"],
			}),
		});
		const service = createEvaluationService(deps);

		const response = await service.evaluateAction(
			createRequest({
				arguments: "not-an-object" as unknown as Record<string, unknown>,
			}),
		);

		expect(response).toMatchObject({
			decision: "allow",
			auditRef: "aud_test_1",
		});
		expect(deps.writeAudit).toHaveBeenCalledTimes(1);
	});

	it("denies when audit persistence fails before returning a decision", async () => {
		const deps = createDependencies({
			loadPolicy: vi.fn().mockReturnValue({ policy_id: "default-conservative" }),
			evaluatePolicy: vi.fn().mockReturnValue({
				decision: COMPASS_DECISIONS.ALLOW,
				policyId: "default-conservative",
				reasonCodes: ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
				evaluatedRules: ["transfers.max_usd_without_approval"],
			}),
			writeAudit: vi.fn().mockRejectedValue(new Error("store unavailable")),
		});
		const service = createEvaluationService(deps);

		const response = await service.evaluateAction(createRequest());

		expect(response).toMatchObject({
			decision: "deny",
			riskLevel: "high",
			auditRef: "audit-unavailable",
			suggestedAction: "Restore hosted audit persistence before retrying.",
		});
		expect(response.reasons).toContain("AUDIT_DEGRADED_DENIAL");
	});
});
