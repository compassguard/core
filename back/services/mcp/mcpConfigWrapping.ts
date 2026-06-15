/**
 * Secret-safe MCP config wrapping helper for Wave 11 proxy.
 *
 * Wraps an existing local MCP server config into a Compass proxy entry.
 * Preserves env references and cwd/args for downstream startup.
 * Redacts secret-like values from previews, errors, and dry-run output.
 *
 * Wave 11 supports exactly one downstream stdio server per proxy process.
 * Multi-downstream and remote MCP hosting are out of scope and rejected.
 */

import type { DownstreamMcpStdioConfig } from "./mcpProxyContracts";
import type { ProxyConfigWrapResult } from "./mcpProxyContracts";

// ---------------------------------------------------------------------------
// Secret detection patterns
// ---------------------------------------------------------------------------

/**
 * Environment variable key patterns that identify secrets.
 * Values for these keys are always redacted in output.
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
	/SECRET/i,
	/KEY/i,
	/PASSWORD/i,
	/TOKEN/i,
	/CREDENTIAL/i,
	/AUTH/i,
	/SIGNER/i,
	/MNEMONIC/i,
	/PRIVATE/i,
	/DATABASE_URL/i,
	/CONNECTION_STRING/i,
];

/**
 * Check whether an environment variable key looks like a secret.
 */
function isSecretEnvKey(key: string): boolean {
	return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Sensitive value patterns that identify raw secret content.
 * Any value matching these patterns is redacted regardless of key name.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
	/^sk[_-]/i, // OpenAI-style keys
	/^sk_live_/i, // Stripe live keys
	/^sk_test_/i, // Stripe test keys
	/^key[_-]/i, // Generic key prefixes
	/^secret[_-]/i, // Generic secret prefixes
	/^token[_-]/i, // Generic token prefixes
	/^[a-zA-Z0-9+/]{40,}={0,2}$/, // Base64-looking strings 40+ chars
	/^postgresql:\/\//i, // Database connection strings
	/^postgres:\/\//i,
	/^mysql:\/\//i,
	/^mongodb(\+srv)?:\/\//i,
	/^redis:\/\//i,
];

/**
 * Check whether a value looks like a secret.
 */
function isSecretValue(value: string): boolean {
	return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

// ---------------------------------------------------------------------------
// Config wrapping
// ---------------------------------------------------------------------------

/**
 * Input type for wrapping. Must be a single stdio-based MCP server config.
 * Reuses DownstreamMcpStdioConfig for the wire format.
 */
export type McpConfigWrapInput = DownstreamMcpStdioConfig & {
	/** Remote URL — presence indicates this is NOT a stdio config. */
	url?: string;
};

/**
 * Wrap one local MCP server config into a Compass proxy configuration.
 *
 * The resulting proxy entry exposes Compass as the only client-facing
 * command while preserving the original downstream command, args, env,
 * and cwd for the proxy process to start the downstream server.
 *
 * Secret env values are never included in the result. Instead, only
 * the key names are listed in envReferences for indirection.
 */
export function wrapMcpConfigForProxy(
	config: McpConfigWrapInput | McpConfigWrapInput[],
): ProxyConfigWrapResult {
	// Reject multi-downstream config — Wave 11 only supports one per proxy process
	if (Array.isArray(config)) {
		throw new Error(
			"Wave 11 out of scope: multiple downstream servers are not supported. " +
				"Compass proxy supports exactly one stdio downstream server per process.",
		);
	}

	// Reject remote MCP hosting (URL-based, not stdio)
	if ("url" in config && config.url && typeof config.url === "string" && config.url.trim() !== "") {
		throw new Error(
			"Wave 11 out of scope: remote MCP hosting is not supported. " +
				"Compass proxy supports only stdio-based downstream servers.",
		);
	}

	// Reject configs without a valid stdio command
	if (!config.command || config.command.trim() === "") {
		throw new Error(
			"Wave 11 out of scope: invalid stdio config. " +
				"Compass proxy requires a non-empty command for the downstream server.",
		);
	}

	// Collect env references (key names only, never values)
	const envReferences: string[] = [];
	const sanitizedEnv: Record<string, string> = {};

	if (config.env) {
		for (const [key, value] of Object.entries(config.env)) {
			envReferences.push(key);
			// Always redact secret values; never include raw secrets
			if (isSecretEnvKey(key) || isSecretValue(value)) {
				sanitizedEnv[key] = "[REDACTED]";
			} else {
				// Non-secret values can be preserved in the wrapped config
				// for functional downstream startup, but the outer result
				// only references them indirectly
				sanitizedEnv[key] = value;
			}
		}
	}

	// Build the Compass proxy command
	const proxyCommand = "compass";
	const downstreamArgs = [...config.args];

	// Build the wrapped config that will be used internally
	// This preserves the full config for downstream startup, but with
	// secrets redacted in the serializable form.
	const wrappedConfig: Record<string, unknown> = {
		name: config.name,
		type: "local",
		proxy: {
			command: proxyCommand,
			args: [
				"mcp:dev",
				"--downstream-command",
				config.command,
				"--downstream-args",
				...downstreamArgs,
			],
		},
		downstream: {
			command: config.command,
			args: downstreamArgs,
			...(config.cwd ? { cwd: config.cwd } : {}),
			// env is deliberately NOT included here —
			// downstream startup picks it from process.env via indirection
		},
		// Never serialize raw env values in the static config.
		// The proxy process will load env from the original source at runtime.
	};

	return {
		proxyCommand,
		downstreamCommand: config.command,
		downstreamArgs,
		downstreamCwd: config.cwd,
		envReferences,
		isSingleDownstream: true,
		wrappedConfig,
	};
}

/**
 * Format a dry-run output string for a proxy config wrap result.
 * All secret values are redacted. Only env key names are shown.
 */
export function formatDryRunOutput(result: ProxyConfigWrapResult): string {
	// Deep-clone and redact any potential secrets from the serialized output
	const safeWrappedConfig = deepRedactSecrets(result.wrappedConfig);

	const lines: string[] = [
		"=== Compass MCP Proxy Dry Run ===",
		"",
		"Proxy Command:",
		`  ${result.proxyCommand}`,
		"",
		"Downstream Server:",
		`  Command: ${result.downstreamCommand}`,
		`  Args: ${JSON.stringify(result.downstreamArgs)}`,
		`  CWD: ${result.downstreamCwd ?? "(inherit)"}`,
		"",
		"Environment References (key names only, values not shown):",
		...result.envReferences.map((key) => `  ${key}`),
		"",
		"Wrapped Config (secrets redacted):",
		JSON.stringify(safeWrappedConfig, null, 2),
		"",
		"=== End Dry Run ===",
	];

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Deep redaction for dry-run output
// ---------------------------------------------------------------------------

/**
 * Recursively redact any secret-looking values from a config object.
 * This is a defense-in-depth measure for dry-run output.
 */
function deepRedactSecrets(obj: unknown): unknown {
	if (typeof obj === "string") {
		if (isSecretValue(obj)) {
			return "[REDACTED]";
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map(deepRedactSecrets);
	}

	if (typeof obj === "object" && obj !== null) {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
			if (isSecretEnvKey(key)) {
				result[key] = "[REDACTED]";
			} else {
				result[key] = deepRedactSecrets(value);
			}
		}
		return result;
	}

	return obj;
}