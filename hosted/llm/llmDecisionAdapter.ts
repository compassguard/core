/**
 * LLM Decision Adapter - provider boundary for the advisory LLM judge.
 */

import {
	LLM_GUARD_DECISIONS,
	LLM_DECISION_STRICTNESS,
	type LlmClampedDecision,
	type LlmGuardDecision,
	type LlmGuardOutput,
	type LlmJudgeConfig,
	type LlmJudgeInput,
} from "@shared/llmDecisionContracts";
import type { CompassDecision } from "@shared/executionGatewayContracts";

export function resolveLlmConfig(
	env: Record<string, string | undefined> = process.env,
): LlmJudgeConfig {
	const enabled = env.COMPASS_LLM_DECISION_ENABLED === "true";
	return {
		enabled,
		provider: env.COMPASS_LLM_PROVIDER ?? "opencode-go",
		model: env.COMPASS_LLM_MODEL ?? "kimi-k2.5",
		baseUrl: env.COMPASS_LLM_BASE_URL,
		apiKey: env.COMPASS_LLM_API_KEY,
		timeoutMs: env.COMPASS_LLM_TIMEOUT_MS
			? parseInt(env.COMPASS_LLM_TIMEOUT_MS, 10)
			: undefined,
	};
}

export function isLlmConfigured(config: LlmJudgeConfig): boolean {
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
		return typeof config.baseUrl === "string" && config.baseUrl.length > 0;
	}

	return typeof config.apiKey === "string" && config.apiKey.length > 0;
}

const VALID_LLM_DECISIONS = new Set<string>(Object.values(LLM_GUARD_DECISIONS));

export function validateLlmGuardOutput(
	raw: unknown,
): LlmGuardOutput | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	if (
		typeof obj.decision !== "string" ||
		!VALID_LLM_DECISIONS.has(obj.decision)
	) {
		return undefined;
	}
	if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
		return undefined;
	}
	if (!Array.isArray(obj.reasonCodes)) {
		return undefined;
	}
	if (typeof obj.rationale !== "string") {
		return undefined;
	}

	return {
		decision: obj.decision as LlmGuardDecision,
		confidence: obj.confidence,
		reasonCodes: obj.reasonCodes as string[],
		rationale: obj.rationale,
	};
}

export function clampLlmDecision(
	deterministicDecision: CompassDecision,
	llmOutput: LlmGuardOutput | undefined,
): LlmClampedDecision {
	if (!llmOutput) {
		return {
			decision: deterministicDecision,
			llmConsulted: true,
			clamped: false,
		};
	}

	const allowedStrictness =
		LLM_DECISION_STRICTNESS[deterministicDecision] ?? [
			LLM_GUARD_DECISIONS.DENY,
		];

	if (allowedStrictness.includes(llmOutput.decision)) {
		return {
			decision: llmOutput.decision as CompassDecision,
			llmConsulted: true,
			llmOutput,
			clamped: llmOutput.decision !== deterministicDecision,
			llmReasonCodes: llmOutput.reasonCodes,
			llmRationale: llmOutput.rationale,
		};
	}

	return {
		decision: deterministicDecision,
		llmConsulted: true,
		llmOutput,
		clamped: true,
		llmReasonCodes: llmOutput.reasonCodes,
		llmRationale: llmOutput.rationale,
	};
}

export type LlmProviderFn = (input: {
	prompt: string;
	config: LlmJudgeConfig;
	signal?: AbortSignal;
}) => Promise<unknown>;

const LLM_SYSTEM_PROMPT = [
	"You are Compass MCP Guard's advisory risk judge.",
	"Return only JSON with decision, confidence, reasonCodes, and rationale.",
	"You may keep or tighten the deterministic decision, never loosen it.",
	"Never request transaction execution or signing.",
].join(" ");

export async function callLlmJudge(
	input: LlmJudgeInput,
	config: LlmJudgeConfig,
	providerFn?: LlmProviderFn,
): Promise<LlmGuardOutput | undefined> {
	if (!isLlmConfigured(config)) {
		return undefined;
	}

	const provider = providerFn ?? defaultProviderFor(config.provider);
	if (!provider) {
		return undefined;
	}

	const timeoutMs = config.timeoutMs ?? 3000;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const raw = await provider({
			prompt: JSON.stringify(input),
			config,
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
		return validateLlmGuardOutput(raw);
	} catch {
		clearTimeout(timeoutId);
		return undefined;
	}
}

function defaultProviderFor(provider: string | undefined): LlmProviderFn | undefined {
	if (provider === "opencode-go") {
		return callOpenCodeGoChatCompletions;
	}
	if (provider === "openai") {
		return callOpenAiResponses;
	}
	return undefined;
}

async function callOpenCodeGoChatCompletions(input: {
	prompt: string;
	config: LlmJudgeConfig;
	signal?: AbortSignal;
}): Promise<unknown> {
	if (!input.config.baseUrl) {
		return undefined;
	}

	return callChatCompletionsEndpoint({
		url: input.config.baseUrl,
		prompt: input.prompt,
		config: input.config,
		signal: input.signal,
	});
}

async function callChatCompletionsEndpoint(input: {
	url: string;
	prompt: string;
	config: LlmJudgeConfig;
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
				{ role: "system", content: LLM_SYSTEM_PROMPT },
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

async function callOpenAiResponses(input: {
	prompt: string;
	config: LlmJudgeConfig;
	signal?: AbortSignal;
}): Promise<unknown> {
	return callResponsesEndpoint({
		url: "https://api.openai.com/v1/responses",
		prompt: input.prompt,
		config: input.config,
		signal: input.signal,
	});
}

async function callResponsesEndpoint(input: {
	url: string;
	prompt: string;
	config: LlmJudgeConfig;
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
			input: [
				{ role: "system", content: LLM_SYSTEM_PROMPT },
				{ role: "user", content: input.prompt },
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

export type EvaluateLlmMetadataParams = {
	input: LlmJudgeInput;
	config: LlmJudgeConfig;
	providerFn?: LlmProviderFn;
};

export async function evaluateLlmMetadata(
	params: EvaluateLlmMetadataParams,
): Promise<LlmClampedDecision> {
	const llmOutput = await callLlmJudge(
		params.input,
		params.config,
		params.providerFn,
	);

	return clampLlmDecision(params.input.deterministicDecision, llmOutput);
}
