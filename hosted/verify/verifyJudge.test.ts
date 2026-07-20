import { describe, expect, it, vi } from "vitest";

import { COMPASS_DECISIONS } from "@shared/executionGatewayContracts";
import type { LlmJudgeConfig } from "@shared/llmDecisionContracts";
import type { Mandate } from "@shared/mandateContracts";

import type { VerifyJudgeDecisionInput } from "./verifyJudge";
import { createVerifyJudge, resolveVerifyJudgeConfig } from "./verifyJudge";

const MANDATE: Mandate = {
	ownerId: "alice@example.com",
	mandateText: "Only pay invoices from approved vendors; never more than $200.",
	allowedRecipients: ["VendorA111"],
	maxAmountUsd: 200,
	updatedAt: "2026-07-20T00:00:00.000Z",
};

const CONFIG: LlmJudgeConfig = {
	enabled: true,
	provider: "opencode-go",
	model: "test-model",
	baseUrl: "http://llm.test/v1/chat/completions",
	timeoutMs: 1000,
};

function decisionInput(
	overrides: Partial<VerifyJudgeDecisionInput> = {},
): VerifyJudgeDecisionInput {
	return {
		toolName: "transfer_sol",
		actionKind: "transfer",
		deterministicDecision: COMPASS_DECISIONS.ALLOW,
		reasonCodes: ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
		args: { recipient: "Stranger999", amountUsd: 150 },
		statedPurpose: "pay vendor Acme for invoice #42",
		mandate: MANDATE,
		...overrides,
	};
}

describe("createVerifyJudge", () => {
	it("honors a tightening verdict (ALLOW → DENY)", async () => {
		const judge = createVerifyJudge({
			config: CONFIG,
			providerFn: async () => ({
				decision: "DENY",
				confidence: 0.9,
				reasonCodes: ["off_mandate_recipient"],
				rationale: "Recipient is not part of the owner's mandate.",
			}),
		});

		const result = await judge(decisionInput());
		expect(result).toEqual({
			ran: true,
			decision: COMPASS_DECISIONS.DENY,
			clamped: true,
			reasonCodes: ["off_mandate_recipient"],
			rationale: "Recipient is not part of the owner's mandate.",
		});
	});

	it("clamps a loosening verdict — REQUIRE_HUMAN_APPROVAL never becomes ALLOW", async () => {
		const judge = createVerifyJudge({
			config: CONFIG,
			providerFn: async () => ({
				decision: "ALLOW",
				confidence: 0.99,
				reasonCodes: ["looks_fine"],
				rationale: "Seems consistent with the mandate.",
			}),
		});

		const result = await judge(
			decisionInput({ deterministicDecision: COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL }),
		);
		expect(result.ran).toBe(true);
		if (result.ran) {
			expect(result.decision).toBe(COMPASS_DECISIONS.REQUIRE_HUMAN_APPROVAL);
		}
	});

	it("reports ran:false on an invalid provider payload", async () => {
		const judge = createVerifyJudge({
			config: CONFIG,
			providerFn: async () => ({ nonsense: true }),
		});
		expect(await judge(decisionInput())).toEqual({ ran: false });
	});

	it("reports ran:false without calling the provider when the config is disabled", async () => {
		const providerFn = vi.fn();
		const judge = createVerifyJudge({
			config: { ...CONFIG, enabled: false },
			providerFn,
		});

		expect(await judge(decisionInput())).toEqual({ ran: false });
		expect(providerFn).not.toHaveBeenCalled();
	});

	it("sends the mandate-judge system prompt and a sanitized, fenced input", async () => {
		const providerFn = vi.fn(async (input: { prompt: string; systemPrompt?: string }) => {
			void input;
			return {
				decision: "ALLOW",
				confidence: 0.9,
				reasonCodes: [],
				rationale: "ok",
			};
		});
		const judge = createVerifyJudge({ config: CONFIG, providerFn });

		await judge(
			decisionInput({ args: { recipient: "Stranger999", privateKey: "s3cr3t" } }),
		);

		const call = providerFn.mock.calls[0][0];
		expect(call.systemPrompt).toMatch(/never loosen/i);
		const payload = JSON.parse(call.prompt) as {
			statedPurpose: string;
			mandateText: string;
			flagsSource: string;
			sanitizedContext: Record<string, unknown>;
		};
		expect(payload.statedPurpose).toBe("pay vendor Acme for invoice #42");
		expect(payload.mandateText).toMatch(/approved vendors/);
		expect(payload.flagsSource).toBe("self_report");
		expect(payload.sanitizedContext.privateKey).toBe("[REDACTED]");
	});
});

describe("resolveVerifyJudgeConfig", () => {
	it("is gated by COMPASS_VERIFY_JUDGE_ENABLED, independent of the legacy /evaluate flag", () => {
		const env = {
			COMPASS_LLM_DECISION_ENABLED: "true",
			COMPASS_LLM_PROVIDER: "opencode-go",
			COMPASS_LLM_MODEL: "m",
			COMPASS_LLM_BASE_URL: "http://llm.test",
		};
		expect(resolveVerifyJudgeConfig(env).enabled).toBe(false);
		expect(
			resolveVerifyJudgeConfig({ ...env, COMPASS_VERIFY_JUDGE_ENABLED: "true" }).enabled,
		).toBe(true);
	});
});
