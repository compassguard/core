/**
 * Generic MCP tool-call policy interceptor for Wave 11 proxy.
 *
 * Classifies arbitrary downstream tool calls without recreating a native
 * Compass registry. Evaluates reusable policy/approval primitives before
 * forwarding. Returns allow or deny with reason and suggestedAction.
 *
 * Uncertainty requires explicit approval and is never forwarded automatically.
 */

import { debug } from "@back/guardrail/debugLogger";

import type { ProxyDecision } from "./mcpProxyContracts";

// ---------------------------------------------------------------------------
// Risk classification for arbitrary downstream tools
// ---------------------------------------------------------------------------

/**
 * Risk classification categories for downstream tool calls.
 *
 * The proxy does NOT maintain a static registry of known tools.
 * Instead, it classifies calls based on heuristics and policy rules.
 */
	export type ProxyRiskClass =
	| "read_only"
	| "ui_bootstrap"
	| "preparation_simulation"
	| "routable_mutation"
	| "sensitive_execution"
	| "signing"
	| "unknown";

const READ_ONLY_VERBS = new Set(["read", "list", "get", "query", "search", "balance", "balances", "prices", "status", "info", "account"]);

const PREPARATION_SIMULATION_VERBS = new Set([
	"quote",
	"simulate",
	"estimate",
	"check",
]);

const SIGNING_TOOL_NAMES = new Set([
	"eth_sign",
	"personal_sign",
	"sign",
	"sign_message",
	"sign_typed_data",
	"wallet_sign",
]);

const SIGNING_PHRASES = new Set([
	"execute_transaction",
	"send_transaction",
	"sign_and_send",
	"sign_and_send_transaction",
	"sign_transaction",
]);

const SIGNING_TARGET_TOKENS = new Set([
	"message",
	"transaction",
]);

/**
 * Tokens that should be routed to the LLM Router for classification.
 * These are potentially financial actions (transfer, swap) that need
 * context-aware classification rather than blanket denial.
 */
const ROUTABLE_MUTATION_TOKENS = new Set([
	"send",
	"swap",
	"transfer",
]);

/**
 * Tokens that are unambiguously dangerous operations.
 * These bypass the router and are denied directly by the prefilter.
 */
const SENSITIVE_EXECUTION_TOKENS = new Set([
	"approve",
	"burn",
	"buy",
	"delete",
	"deposit",
	"execute",
	"mint",
	"sell",
	"stake",
	"unstake",
	"withdraw",
	"write",
]);

const AMBIGUOUS_MUTATION_TOKENS = new Set([
	...SENSITIVE_EXECUTION_TOKENS,
	"create",
	"set",
	"update",
]);

function normalizeToolName(toolName: string): string {
	return toolName
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function tokenizeToolName(toolName: string): string[] {
	const normalizedToolName = normalizeToolName(toolName);
	return normalizedToolName === "" ? [] : normalizedToolName.split("_");
}

function hasAnyToken(tokens: readonly string[], tokenSet: ReadonlySet<string>): boolean {
	return tokens.some((token) => tokenSet.has(token));
}

function hasSigningToolPattern(
	normalizedToolName: string,
	tokens: readonly string[],
): boolean {
	if (
		SIGNING_TOOL_NAMES.has(normalizedToolName) ||
		SIGNING_PHRASES.has(normalizedToolName) ||
		normalizedToolName.startsWith("sign_typed_data_") ||
		normalizedToolName.includes("_sign_typed_data")
	) {
		return true;
	}

	const signTokenIndex = tokens.indexOf("sign");
	if (signTokenIndex === -1) return false;

	const nextToken = tokens[signTokenIndex + 1];
	const followingToken = tokens[signTokenIndex + 2];
	return (typeof nextToken === "string" && SIGNING_TARGET_TOKENS.has(nextToken)) ||
		(nextToken === "and" && followingToken === "send") ||
		(nextToken === "typed" && followingToken === "data");
}

/**
 * Classify a downstream tool call by risk level.
 *
 * Uses heuristic name patterns rather than a static registry.
 * Unknown or ambiguous tools require explicit approval and are not forwarded.
 */
export function classifyProxyToolCall(toolName: string): ProxyRiskClass {
	const normalizedToolName = normalizeToolName(toolName);
	const tokens = tokenizeToolName(toolName);

// UI/bootstrap operations — intentionally exact to avoid allowing financial
  // actions such as open_position through broad verb matching.
  if (
    normalizedToolName === "show_wallet_app" ||
    normalizedToolName === "compass_show_wallet_app"
  ) {
    debug("interceptor", "classify", "Classified as ui_bootstrap", { toolName });
    return "ui_bootstrap";
  }

  if (hasSigningToolPattern(normalizedToolName, tokens)) {
    debug("interceptor", "classify", "Classified as signing", { toolName });
    return "signing";
  }

  if (hasAnyToken(tokens, SENSITIVE_EXECUTION_TOKENS)) {
    debug("interceptor", "classify", "Classified as sensitive_execution", { toolName });
    return "sensitive_execution";
  }

  // Routable mutations: financial actions that should go to the LLM Router
  // for context-aware classification (transfer vs swap vs skip vs unknown).
  if (hasAnyToken(tokens, ROUTABLE_MUTATION_TOKENS)) {
    debug("interceptor", "classify", "Classified as routable_mutation", { toolName });
    return "routable_mutation";
  }

  if (
    (tokens.some((t) => READ_ONLY_VERBS.has(t))) &&
    !hasAnyToken(tokens, AMBIGUOUS_MUTATION_TOKENS)
  ) {
    debug("interceptor", "classify", "Classified as read_only", { toolName });
    return "read_only";
  }

  if (
    (tokens.some((t) => PREPARATION_SIMULATION_VERBS.has(t))) &&
    !hasAnyToken(tokens, AMBIGUOUS_MUTATION_TOKENS)
  ) {
    debug("interceptor", "classify", "Classified as preparation_simulation", { toolName });
    return "preparation_simulation";
  }

  debug("interceptor", "classify", "Classified as unknown", { toolName });
  return "unknown";
}

// ---------------------------------------------------------------------------
// Policy interceptor
// ---------------------------------------------------------------------------

/**
 * Configuration for the proxy policy interceptor.
 */
export type ProxyPolicyInterceptorConfig = {
	/**
	 * Optional policy decision override for testing.
	 * When provided, the interceptor returns this decision directly
	 * instead of evaluating heuristics.
	 */
	policyDecision?: ProxyDecision;
};

/**
 * Evaluate whether a downstream tool call should be allowed or denied.
 *
 * The interceptor classifies the call, applies policy rules, and returns
 * a ProxyDecision. Uncertainty requires explicit approval and is never
 * forwarded automatically.
 *
 * In the first slice, read-only and preparation/simulation calls are
 * allowed by default. Sensitive execution and signing calls are denied
 * pending future policy/approval integration. Unknown calls require approval.
 */
export function evaluateProxyToolCallPolicy(
	toolName: string,
	_arguments?: Record<string, unknown>,
	config?: ProxyPolicyInterceptorConfig,
): ProxyDecision {
	// Test override: if a policy decision is explicitly provided, use it.
	if (config?.policyDecision) {
		return config.policyDecision;
	}

	const riskClass = classifyProxyToolCall(toolName);
	debug("interceptor", "evaluate", "Interceptor decision", {
		toolName,
		riskClass,
	});

	switch (riskClass) {
		case "read_only":
			return {
				outcome: "allow",
				reason: `Tool "${toolName}" classified as read-only; allowed by default policy.`,
			};
		case "ui_bootstrap":
			return {
				outcome: "allow",
				reason: `Tool "${toolName}" classified as UI/bootstrap; allowed by default policy.`,
			};
		case "preparation_simulation":
			return {
				outcome: "allow",
				reason: `Tool "${toolName}" classified as preparation/simulation; allowed by default policy.`,
			};
		case "routable_mutation":
			return {
				outcome: "require_approval",
				reason: `Tool "${toolName}" classified as routable mutation; routing via LLM Router for transfer/swap classification.`,
			};
		case "sensitive_execution":
			return {
				outcome: "deny",
				reason: `Tool "${toolName}" classified as sensitive execution; denied pending policy/approval integration.`,
				suggestedAction:
					"Configure an explicit policy rule to allow this tool, or request manual approval.",
			};
		case "signing":
			return {
				outcome: "deny",
				reason: `Tool "${toolName}" classified as signing; denied by default policy.`,
				suggestedAction:
					"Signing tools require explicit approval configuration before forwarding.",
			};
		case "unknown":
			return {
				outcome: "require_approval",
				reason: `Tool "${toolName}" could not be classified; explicit approval is required before forwarding.`,
				suggestedAction:
					"Ask for explicit human approval or add an explicit policy rule for this tool before retrying.",
			};
	}
}
