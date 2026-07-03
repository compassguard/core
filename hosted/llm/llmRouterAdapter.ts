/**
 * LLM Router Adapter - provider boundary for downstream MCP tool routing.
 */

import {
	LLM_ROUTER_DEFAULTS,
	type LlmRouterClassification,
	type LlmRouterConfig,
	type LlmRouterInput,
	type LlmRouterResult,
} from "@shared/llmRouterContracts";
import {
	LLM_ROUTER_SYSTEM_PROMPT,
	LLM_ROUTER_USER_PROMPT_TEMPLATE,
} from "./llmRouterPrompt";

type LlmRouterProviderConfig = LlmRouterConfig & {
	baseUrl?: string;
	apiKey?: string;
};

export type LlmRouterProviderFn = (
	prompt: string,
	config: LlmRouterConfig,
	signal?: AbortSignal,
) => Promise<unknown>;

const VALID_CLASSIFICATIONS = new Set<string>([
	"transfer",
	"swap",
	"skip",
	"unknown",
]);

export function resolveRouterConfig(
	env: Record<string, string | undefined> = process.env,
): LlmRouterConfig {
	return {
		enabled: env.COMPASS_LLM_ROUTER_ENABLED === "true",
		timeoutMs: parseInt(
			env.COMPASS_LLM_ROUTER_TIMEOUT_MS ?? String(LLM_ROUTER_DEFAULTS.TIMEOUT_MS),
			10,
		),
		provider: env.COMPASS_LLM_PROVIDER ?? "opencode-go",
		model: env.COMPASS_LLM_MODEL ?? "kimi-k2.5",
		baseUrl: env.COMPASS_LLM_BASE_URL,
		apiKey: env.COMPASS_LLM_API_KEY,
	} as LlmRouterConfig;
}

export async function routeToolCall(
	input: LlmRouterInput,
	config: LlmRouterConfig,
	providerFn?: LlmRouterProviderFn,
): Promise<LlmRouterResult> {
	const startedAt = Date.now();
	const timeoutMs = Number.isFinite(config.timeoutMs)
		? config.timeoutMs
		: LLM_ROUTER_DEFAULTS.TIMEOUT_MS;

	if (!isRouterConfigured(config)) {
		return fallbackResult(startedAt);
	}

	const provider = providerFn ?? defaultProviderFor(config.provider);
	if (!provider) {
		return fallbackResult(startedAt);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const raw = await provider(buildUserPrompt(input), config, controller.signal);
		clearTimeout(timeoutId);

		const parsed = validateRouterOutput(raw);
		if (!parsed) {
			return fallbackResult(startedAt);
		}

		return {
			...parsed,
			latencyMs: Date.now() - startedAt,
		};
	} catch {
		clearTimeout(timeoutId);
		return fallbackResult(startedAt);
	}
}

function isRouterConfigured(config: LlmRouterConfig): boolean {
	const providerConfig = config as LlmRouterProviderConfig;

	if (
		!config.enabled ||
		typeof config.provider !== "string" ||
		config.provider.length === 0 ||
		typeof config.model !== "string" ||
		config.model.length === 0
	) {
		return false;
	}

	if (config.provider === "opencode-go") {
		return (
			typeof providerConfig.baseUrl === "string" &&
			providerConfig.baseUrl.length > 0
		);
	}

	return (
		(config.provider === "openai" || config.provider === "nan") &&
		typeof providerConfig.apiKey === "string" &&
		providerConfig.apiKey.length > 0
	);
}

function buildUserPrompt(input: LlmRouterInput): string {
	return LLM_ROUTER_USER_PROMPT_TEMPLATE
		.replace("{toolName}", input.toolName)
		.replace("{toolDescription}", input.toolDescription ?? "")
		.replace("{toolParams}", JSON.stringify(input.toolParams ?? {}));
}

function validateRouterOutput(
	raw: unknown,
): Pick<LlmRouterResult, "classification" | "reasoning"> | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	if (
		typeof obj.classification !== "string" ||
		!VALID_CLASSIFICATIONS.has(obj.classification)
	) {
		return undefined;
	}
	if (typeof obj.reasoning !== "string") {
		return undefined;
	}

	return {
		classification: obj.classification as LlmRouterClassification,
		reasoning: obj.reasoning,
	};
}

function fallbackResult(startedAt: number): LlmRouterResult {
	return {
		classification: "unknown",
		reasoning: "error",
		latencyMs: Date.now() - startedAt,
	};
}

function defaultProviderFor(
	provider: string | undefined,
): LlmRouterProviderFn | undefined {
	if (provider === "opencode-go") {
		return callOpenCodeGoChatCompletions;
	}
	if (provider === "openai") {
		return callOpenAiResponses;
	}
	if (provider === "nan") {
		return callNanChatCompletions;
	}
	return undefined;
}

async function callOpenCodeGoChatCompletions(
	prompt: string,
	config: LlmRouterConfig,
	signal?: AbortSignal,
): Promise<unknown> {
	const providerConfig = config as LlmRouterProviderConfig;
	if (!providerConfig.baseUrl) {
		return undefined;
	}

	return callChatCompletionsEndpoint({
		url: providerConfig.baseUrl,
		prompt,
		config: providerConfig,
		signal,
	});
}

async function callNanChatCompletions(
	prompt: string,
	config: LlmRouterConfig,
	signal?: AbortSignal,
): Promise<unknown> {
	const providerConfig = config as LlmRouterProviderConfig;
	const baseUrl = providerConfig.baseUrl ?? "https://api.nan.builders/v1";
	const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;

	return callChatCompletionsEndpoint({
		url,
		prompt,
		config: providerConfig,
		signal,
	});
}

async function callChatCompletionsEndpoint(input: {
	url: string;
	prompt: string;
	config: LlmRouterProviderConfig;
	signal?: AbortSignal;
}): Promise<unknown> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	if (input.config.apiKey) {
		headers.Authorization = `Bearer ${input.config.apiKey}`;
	}

	const response = await fetch(input.url, {
		method: "POST",
		signal: input.signal,
		headers,
		body: JSON.stringify({
			model: input.config.model,
			messages: [
				{ role: "system", content: LLM_ROUTER_SYSTEM_PROMPT },
				{ role: "user", content: input.prompt },
			],
			response_format: { type: "json_object" },
		}),
	});

	if (!response.ok) {
		return undefined;
	}

	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: unknown } }>;
	};
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string") {
		return undefined;
	}

	try {
		return JSON.parse(content);
	} catch {
		return undefined;
	}
}

async function callOpenAiResponses(
	prompt: string,
	config: LlmRouterConfig,
	signal?: AbortSignal,
): Promise<unknown> {
	const providerConfig = config as LlmRouterProviderConfig;
	if (!providerConfig.apiKey) {
		return undefined;
	}

	const response = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${providerConfig.apiKey}`,
		},
		body: JSON.stringify({
			model: providerConfig.model,
			input: [
				{ role: "system", content: LLM_ROUTER_SYSTEM_PROMPT },
				{ role: "user", content: prompt },
			],
			text: { format: { type: "json_object" } },
		}),
	});

	if (!response.ok) {
		return undefined;
	}

	const data = (await response.json()) as { output_text?: unknown };
	if (typeof data.output_text !== "string") {
		return undefined;
	}

	try {
		return JSON.parse(data.output_text);
	} catch {
		return undefined;
	}
}
