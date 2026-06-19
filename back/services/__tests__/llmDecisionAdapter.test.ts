import { describe, expect, it, vi } from "vitest";

import {
	LLM_GUARD_DECISIONS,
	type LlmJudgeConfig,
	type LlmJudgeInput,
} from "@shared/llmDecisionContracts";
import {
	callLlmJudge,
	clampLlmDecision,
	isLlmConfigured,
	resolveLlmConfig,
	validateLlmGuardOutput,
	type LlmProviderFn,
} from "@hosted/llm/llmDecisionAdapter";

// ---------------------------------------------------------------------------
// resolveLlmConfig
// ---------------------------------------------------------------------------

describe("resolveLlmConfig", () => {
	it("returns disabled config when env var is not 'true'", () => {
		const config = resolveLlmConfig({ COMPASS_LLM_DECISION_ENABLED: "false" });
		expect(config.enabled).toBe(false);
	});

	it("returns enabled config when COMPASS_LLM_DECISION_ENABLED is 'true'", () => {
		const config = resolveLlmConfig({
			COMPASS_LLM_DECISION_ENABLED: "true",
			COMPASS_LLM_PROVIDER: "opencode-go",
			COMPASS_LLM_MODEL: "kimi-k2.5",
			COMPASS_LLM_BASE_URL: "https://opencode.ai/zen/go/v1/chat/completions",
			COMPASS_LLM_API_KEY: "sk-test",
			COMPASS_LLM_TIMEOUT_MS: "5000",
		});
		expect(config.enabled).toBe(true);
		expect(config.provider).toBe("opencode-go");
		expect(config.model).toBe("kimi-k2.5");
		expect(config.baseUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
		expect(config.apiKey).toBe("sk-test");
		expect(config.timeoutMs).toBe(5000);
	});

	it("defaults to OpenCode Go kimi-k2.5 when provider and model are unset", () => {
		const config = resolveLlmConfig({
			COMPASS_LLM_DECISION_ENABLED: "true",
			COMPASS_LLM_BASE_URL: "https://opencode.ai/zen/go/v1/chat/completions",
		});

		expect(config.provider).toBe("opencode-go");
		expect(config.model).toBe("kimi-k2.5");
	});

	it("defaults timeoutMs to undefined when not set", () => {
		const config = resolveLlmConfig({
			COMPASS_LLM_DECISION_ENABLED: "true",
		});
		expect(config.timeoutMs).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// isLlmConfigured
// ---------------------------------------------------------------------------

describe("isLlmConfigured", () => {
	it("returns false when disabled", () => {
		expect(
			isLlmConfigured({
				enabled: false,
				provider: "opencode-go",
				model: "kimi-k2.5",
				baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
			}),
		).toBe(false);
	});

	it("returns false when missing provider", () => {
		expect(
			isLlmConfigured({
				enabled: true,
				model: "kimi-k2.5",
				baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
			}),
		).toBe(false);
	});

	it("returns false when missing model", () => {
		expect(
			isLlmConfigured({
				enabled: true,
				provider: "opencode-go",
				baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
			}),
		).toBe(false);
	});

	it("returns false when opencode-go is missing baseUrl", () => {
		expect(
			isLlmConfigured({
				enabled: true,
				provider: "opencode-go",
				model: "kimi-k2.5",
			}),
		).toBe(false);
	});

	it("returns false when openai is missing apiKey", () => {
		expect(
			isLlmConfigured({
				enabled: true,
				provider: "openai",
				model: "gpt-4o-mini",
			}),
		).toBe(false);
	});

	it("returns true when fully configured", () => {
		expect(
			isLlmConfigured({
				enabled: true,
				provider: "opencode-go",
				model: "kimi-k2.5",
				baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
			}),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// validateLlmGuardOutput
// ---------------------------------------------------------------------------

describe("validateLlmGuardOutput", () => {
	it("returns undefined for null", () => {
		expect(validateLlmGuardOutput(null)).toBeUndefined();
	});

	it("returns undefined for non-object", () => {
		expect(validateLlmGuardOutput("string")).toBeUndefined();
	});

	it("returns undefined for invalid decision value", () => {
		expect(
			validateLlmGuardOutput({
				decision: "MAYBE",
				confidence: 0.9,
				reasonCodes: [],
				rationale: "test",
			}),
		).toBeUndefined();
	});

	it("returns undefined for missing confidence", () => {
		expect(
			validateLlmGuardOutput({
				decision: "ALLOW",
				reasonCodes: [],
				rationale: "test",
			}),
		).toBeUndefined();
	});

	it("returns undefined for missing reasonCodes", () => {
		expect(
			validateLlmGuardOutput({
				decision: "DENY",
				confidence: 0.95,
				rationale: "test",
			}),
		).toBeUndefined();
	});

	it("returns undefined for missing rationale", () => {
		expect(
			validateLlmGuardOutput({
				decision: "DENY",
				confidence: 0.95,
				reasonCodes: ["HIGH_RISK"],
			}),
		).toBeUndefined();
	});

	it("returns valid output for well-formed ALLOW", () => {
		const result = validateLlmGuardOutput({
			decision: "ALLOW",
			confidence: 0.8,
			reasonCodes: ["LOW_RISK"],
			rationale: "Low-risk action within policy.",
		});
		expect(result).toEqual({
			decision: "ALLOW",
			confidence: 0.8,
			reasonCodes: ["LOW_RISK"],
			rationale: "Low-risk action within policy.",
		});
	});

	it("returns valid output for well-formed DENY", () => {
		const result = validateLlmGuardOutput({
			decision: "DENY",
			confidence: 0.99,
			reasonCodes: ["KNOWN_SCAM_PATTERN"],
			rationale: "Destination flagged.",
		});
		expect(result).toEqual({
			decision: "DENY",
			confidence: 0.99,
			reasonCodes: ["KNOWN_SCAM_PATTERN"],
			rationale: "Destination flagged.",
		});
	});
});

// ---------------------------------------------------------------------------
// clampLlmDecision
// ---------------------------------------------------------------------------

describe("clampLlmDecision", () => {
	it("keeps deterministic DENY when LLM returns DENY", () => {
		const result = clampLlmDecision("DENY", {
			decision: LLM_GUARD_DECISIONS.DENY,
			confidence: 0.99,
			reasonCodes: ["CONFIRMED_SCAM"],
			rationale: "Confirmed scam destination.",
		});
		expect(result.decision).toBe("DENY");
		expect(result.clamped).toBe(false);
		expect(result.llmConsulted).toBe(true);
	});

	it("keeps deterministic DENY when LLM tries to ALLOW (impossible loosening)", () => {
		const result = clampLlmDecision("DENY", {
			decision: LLM_GUARD_DECISIONS.ALLOW,
			confidence: 0.5,
			reasonCodes: [],
			rationale: "Looks fine to me.",
		});
		expect(result.decision).toBe("DENY");
		expect(result.clamped).toBe(true);
	});

	it("keeps deterministic ALLOW when LLM agrees ALLOW", () => {
		const result = clampLlmDecision("ALLOW", {
			decision: LLM_GUARD_DECISIONS.ALLOW,
			confidence: 0.9,
			reasonCodes: ["LOW_RISK"],
			rationale: "Action within policy limits.",
		});
		expect(result.decision).toBe("ALLOW");
		expect(result.clamped).toBe(false);
	});

	it("tightens ALLOW to REQUIRE_HUMAN_APPROVAL when LLM recommends", () => {
		const result = clampLlmDecision("ALLOW", {
			decision: LLM_GUARD_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			confidence: 0.85,
			reasonCodes: ["NEW_RECIPIENT"],
			rationale: "Recipient not previously seen.",
		});
		expect(result.decision).toBe("REQUIRE_HUMAN_APPROVAL");
		expect(result.clamped).toBe(true);
	});

	it("tightens ALLOW to DENY when LLM recommends", () => {
		const result = clampLlmDecision("ALLOW", {
			decision: LLM_GUARD_DECISIONS.DENY,
			confidence: 0.95,
			reasonCodes: ["KNOWN_SCAM"],
			rationale: "Scam destination detected.",
		});
		expect(result.decision).toBe("DENY");
		expect(result.clamped).toBe(true);
	});

	it("keeps REQUIRE_HUMAN_APPROVAL when LLM agrees", () => {
		const result = clampLlmDecision("REQUIRE_HUMAN_APPROVAL", {
			decision: LLM_GUARD_DECISIONS.REQUIRE_HUMAN_APPROVAL,
			confidence: 0.8,
			reasonCodes: ["UNKNOWN_TOKEN"],
			rationale: "Token not recognized.",
		});
		expect(result.decision).toBe("REQUIRE_HUMAN_APPROVAL");
		expect(result.clamped).toBe(false);
	});

	it("clamps REQUIRE_HUMAN_APPROVAL when LLM tries to ALLOW", () => {
		const result = clampLlmDecision("REQUIRE_HUMAN_APPROVAL", {
			decision: LLM_GUARD_DECISIONS.ALLOW,
			confidence: 0.5,
			reasonCodes: [],
			rationale: "Looks OK.",
		});
		expect(result.decision).toBe("REQUIRE_HUMAN_APPROVAL");
		expect(result.clamped).toBe(true);
	});

	it("tightens REQUIRE_HUMAN_APPROVAL to DENY when LLM recommends", () => {
		const result = clampLlmDecision("REQUIRE_HUMAN_APPROVAL", {
			decision: LLM_GUARD_DECISIONS.DENY,
			confidence: 0.9,
			reasonCodes: ["CONFIRMED_BAD"],
			rationale: "Known bad actor.",
		});
		expect(result.decision).toBe("DENY");
		expect(result.clamped).toBe(true);
	});

	it("returns deterministic decision when LLM output is undefined (failure)", () => {
		const result = clampLlmDecision("REQUIRE_HUMAN_APPROVAL", undefined);
		expect(result.decision).toBe("REQUIRE_HUMAN_APPROVAL");
		expect(result.llmConsulted).toBe(true);
		expect(result.clamped).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// callLlmJudge
// ---------------------------------------------------------------------------

describe("callLlmJudge", () => {
	const validInput: LlmJudgeInput = {
		toolName: "guarded_transfer_sol",
		actionKind: "transfer",
		network: "devnet",
		deterministicDecision: "REQUIRE_HUMAN_APPROVAL",
		riskClass: "SENSITIVE_EXECUTION",
		reasonCodes: ["TRANSFER_UNKNOWN_RECIPIENT"],
		policyId: "default-conservative",
		sanitized: true,
	};

	const configuredEnv: LlmJudgeConfig = {
		enabled: true,
		provider: "opencode-go",
		model: "kimi-k2.5",
		baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
		apiKey: "sk-test",
		timeoutMs: 3000,
	};

	it("returns undefined when disabled", async () => {
		const result = await callLlmJudge(validInput, {
			...configuredEnv,
			enabled: false,
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined when missing provider config", async () => {
		const result = await callLlmJudge(validInput, {
			enabled: true,
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined when provider is unsupported and no providerFn is given", async () => {
		const result = await callLlmJudge(validInput, {
			...configuredEnv,
			provider: "unsupported",
		});
		expect(result).toBeUndefined();
	});

	it("calls OpenCode Go chat completions endpoint when provider is opencode-go and no providerFn is injected", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
			ok: true,
			json: vi.fn().mockResolvedValue({
				choices: [
					{
						message: {
							content: JSON.stringify({
								decision: "REQUIRE_HUMAN_APPROVAL",
								confidence: 0.9,
								reasonCodes: ["LLM_UNKNOWN_RECIPIENT"],
								rationale: "Recipient is unfamiliar.",
							}),
						},
					},
				],
			}),
		} as unknown as Response);

		const result = await callLlmJudge(validInput, configuredEnv);

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://opencode.ai/zen/go/v1/chat/completions",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer sk-test",
				}),
			}),
		);
		const requestInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(requestInit.body))).toEqual(
			expect.objectContaining({
				model: "kimi-k2.5",
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "system" }),
					expect.objectContaining({ role: "user" }),
				]),
				response_format: { type: "json_object" },
			}),
		);
		expect(result).toEqual({
			decision: "REQUIRE_HUMAN_APPROVAL",
			confidence: 0.9,
			reasonCodes: ["LLM_UNKNOWN_RECIPIENT"],
			rationale: "Recipient is unfamiliar.",
		});
	});

	it("calls OpenAI responses when provider is openai", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
			ok: true,
			json: vi.fn().mockResolvedValue({
				output_text: JSON.stringify({
					decision: "DENY",
					confidence: 0.93,
					reasonCodes: ["LLM_DENY"],
					rationale: "Risk is too high.",
				}),
			}),
		} as unknown as Response);

		const result = await callLlmJudge(validInput, {
			...configuredEnv,
			provider: "openai",
			model: "gpt-4o-mini",
			baseUrl: undefined,
			apiKey: "sk-test",
		});

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.openai.com/v1/responses",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer sk-test",
				}),
			}),
		);
		expect(result?.decision).toBe("DENY");
	});

	it("returns undefined on provider error", async () => {
		const providerFn: LlmProviderFn = vi.fn().mockRejectedValue(new Error("timeout"));
		const result = await callLlmJudge(validInput, configuredEnv, providerFn);
		expect(result).toBeUndefined();
	});

	it("returns undefined on invalid JSON output", async () => {
		const providerFn: LlmProviderFn = vi.fn().mockResolvedValue("not-json");
		const result = await callLlmJudge(validInput, configuredEnv, providerFn);
		expect(result).toBeUndefined();
	});

	it("returns undefined on schema-mismatch output", async () => {
		const providerFn: LlmProviderFn = vi
			.fn()
			.mockResolvedValue({ decision: "MAYBE" });
		const result = await callLlmJudge(validInput, configuredEnv, providerFn);
		expect(result).toBeUndefined();
	});

	it("returns validated output on valid LLM response", async () => {
		const validOutput = {
			decision: "REQUIRE_HUMAN_APPROVAL",
			confidence: 0.85,
			reasonCodes: ["UNKNOWN_RECIPIENT"],
			rationale: "Recipient not seen before.",
		};
		const providerFn: LlmProviderFn = vi.fn().mockResolvedValue(validOutput);
		const result = await callLlmJudge(validInput, configuredEnv, providerFn);
		expect(result).toEqual(validOutput);
	});

	it("returns undefined on provider timeout (rejects with abort error)", async () => {
		const providerFn: LlmProviderFn = vi
			.fn()
			.mockImplementation(({ signal }) => {
				return new Promise((_resolve, reject) => {
					if (signal) {
						signal.addEventListener("abort", () => {
							reject(new DOMException("Aborted", "AbortError"));
						});
					}
				});
			});
		const result = await callLlmJudge(validInput, {
			...configuredEnv,
			timeoutMs: 100,
		}, providerFn);
		expect(result).toBeUndefined();
	});
});
