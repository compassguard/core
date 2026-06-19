import { describe, expect, it, vi } from "vitest";

import type { LlmRouterConfig, LlmRouterInput } from "@shared/llmRouterContracts";
import {
	resolveRouterConfig,
	routeToolCall,
	type LlmRouterProviderFn,
} from "@hosted/llm/llmRouterAdapter";

type TestRouterConfig = LlmRouterConfig & {
	baseUrl?: string;
	apiKey?: string;
};

const input: LlmRouterInput = {
	toolName: "send_sol",
	toolDescription: "Send SOL to a recipient.",
	toolParams: { amount: 1, recipient: "wallet" },
};

const config: TestRouterConfig = {
	enabled: true,
	provider: "opencode-go",
	model: "kimi-k2.5",
	baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
	timeoutMs: 100,
};

describe("routeToolCall", () => {
	it.each(["transfer", "swap", "skip", "unknown"] as const)(
		"returns %s when LLM says %s",
		async (classification) => {
			const providerFn: LlmRouterProviderFn = vi.fn().mockResolvedValue({
				classification,
				reasoning: `${classification} route`,
			});

			const result = await routeToolCall(input, config, providerFn);

			expect(result.classification).toBe(classification);
			expect(result.reasoning).toBe(`${classification} route`);
		},
	);

	it("returns unknown on timeout", async () => {
		const providerFn: LlmRouterProviderFn = vi.fn((_prompt, _config, signal) => {
			return new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => {
					reject(new DOMException("Aborted", "AbortError"));
				});
			});
		});

		const result = await routeToolCall(
			input,
			{ ...config, timeoutMs: 1 },
			providerFn,
		);

		expect(result.classification).toBe("unknown");
		expect(result.reasoning).toBe("error");
	});

	it("returns unknown on invalid JSON from LLM", async () => {
		const providerFn: LlmRouterProviderFn = vi.fn().mockResolvedValue("not-json");

		const result = await routeToolCall(input, config, providerFn);

		expect(result.classification).toBe("unknown");
		expect(result.reasoning).toBe("error");
	});

	it("returns unknown on provider error", async () => {
		const providerFn: LlmRouterProviderFn = vi
			.fn()
			.mockRejectedValue(new Error("provider failed"));

		const result = await routeToolCall(input, config, providerFn);

		expect(result.classification).toBe("unknown");
		expect(result.reasoning).toBe("error");
	});
});

describe("resolveRouterConfig", () => {
	it("reads env vars correctly", () => {
		const result = resolveRouterConfig({
			COMPASS_LLM_ROUTER_ENABLED: "true",
			COMPASS_LLM_ROUTER_TIMEOUT_MS: "5000",
			COMPASS_LLM_PROVIDER: "openai",
			COMPASS_LLM_MODEL: "gpt-4o-mini",
			COMPASS_LLM_BASE_URL: "https://example.test/chat",
			COMPASS_LLM_API_KEY: "sk-test",
		});

		expect(result).toEqual({
			enabled: true,
			timeoutMs: 5000,
			provider: "openai",
			model: "gpt-4o-mini",
			baseUrl: "https://example.test/chat",
			apiKey: "sk-test",
		});
	});

	it("uses defaults when env vars missing", () => {
		const result = resolveRouterConfig({});

		expect(result.enabled).toBe(false);
		expect(result.timeoutMs).toBe(3000);
		expect(result.provider).toBe("opencode-go");
		expect(result.model).toBe("kimi-k2.5");
	});
});
