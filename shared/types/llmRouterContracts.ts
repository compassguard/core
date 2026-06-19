/**
 * LLM Router Contracts - types for the tool classification router.
 *
 * The router classifies downstream MCP tools as transfer, swap, skip, or unknown
 * using an LLM. Contracts live separately from behavior per project convention.
 */

export type LlmRouterClassification = "transfer" | "swap" | "skip" | "unknown";

export type LlmRouterResult = {
	classification: LlmRouterClassification;
	reasoning: string;
	latencyMs: number;
};

export type LlmRouterInput = {
	toolName: string;
	toolDescription?: string;
	toolParams?: Record<string, unknown>;
};

export type LlmRouterConfig = {
	enabled: boolean;
	timeoutMs: number;
	provider?: string;
	model?: string;
};

export const LLM_ROUTER_ENV = {
	ENABLED: "COMPASS_LLM_ROUTER_ENABLED",
	TIMEOUT_MS: "COMPASS_LLM_ROUTER_TIMEOUT_MS",
} as const;

export const LLM_ROUTER_DEFAULTS = {
	TIMEOUT_MS: 3000,
} as const;
