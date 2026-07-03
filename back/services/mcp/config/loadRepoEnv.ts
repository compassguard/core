/**
 * Minimal repo .env loader for MCP stdio server startup.
 *
 * When the MCP server runs via `npm run mcp:dev` (tsx), process.env doesn't
 * automatically pick up .env files. This loader reads the repo-root .env once
 * and merges non-conflicting values into process.env, so COMPASS_LLM_* and
 * other Compass settings are available without requiring dotenv as a runtime
 * dependency.
 *
 * Guarantees:
 * - Never overrides an existing process.env value (explicit env wins).
 * - Never logs secret values.
 * - Idempotent: safe to call multiple times (only loads once).
 * - No runtime dependencies beyond Node.js builtins.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { debug } from "@back/guardrail/debugLogger";

let loaded = false;

/** Keys whose values should never be logged. */
const SECRET_KEY_PATTERNS = [
	/SECRET/i,
	/KEY/i,
	/PASSWORD/i,
	/TOKEN/i,
	/CREDENTIAL/i,
	/AUTH/i,
	/SIGNER/i,
	/MNEMONIC/i,
	/PRIVATE/i,
];

function isSecretKey(key: string): boolean {
	return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Parse a simple .env file contents into key-value pairs.
 * - Lines starting with # are comments.
 * - Empty lines are skipped.
 * - Values may be unquoted, single-quoted, or double-quoted.
 * - Inline comments after values are stripped (only for unquoted values).
 * - Lines without = are skipped.
 * - export prefix is stripped.
 */
export function parseEnvContents(contents: string): Record<string, string> {
	const result: Record<string, string> = {};

	for (const rawLine of contents.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;

		// Strip optional "export " prefix
		const withoutExport = line.startsWith("export ")
			? line.slice("export ".length)
			: line;

		const eqIndex = withoutExport.indexOf("=");
		if (eqIndex === -1) continue;

		const key = withoutExport.slice(0, eqIndex).trim();
		let value = withoutExport.slice(eqIndex + 1);

		// Double-quoted: use value between quotes
		if (value.startsWith('"')) {
			const endQuote = value.indexOf('"', 1);
			if (endQuote !== -1) {
				value = value.slice(1, endQuote);
			} else {
				value = value.slice(1);
			}
		} else if (value.startsWith("'")) {
			// Single-quoted: use value between quotes
			const endQuote = value.indexOf("'", 1);
			if (endQuote !== -1) {
				value = value.slice(1, endQuote);
			} else {
				value = value.slice(1);
			}
		} else {
			// Unquoted: strip inline comments (# not inside value)
			const commentIndex = value.indexOf("#");
			if (commentIndex !== -1) {
				value = value.slice(0, commentIndex);
			}
			value = value.trim();
		}

		result[key] = value;
	}

	return result;
}

/**
 * Load repo-root .env into process.env without overriding existing values.
 * Safe to call multiple times - only loads once.
 *
 * @param options.overrideRootDir - Override the repo root directory (for testing).
 */
export function loadRepoEnv(options?: { overrideRootDir?: string }): {
	loaded: boolean;
	keysLoaded: string[];
} {
	if (loaded) {
		return { loaded: true, keysLoaded: [] };
	}

	const rootDir = options?.overrideRootDir ?? process.cwd();
	const envPath = join(rootDir, ".env");

	if (!existsSync(envPath)) {
		loaded = true;
		return { loaded: true, keysLoaded: [] };
	}

	let contents: string;
	try {
		contents = readFileSync(envPath, "utf-8");
	} catch {
		loaded = true;
		return { loaded: true, keysLoaded: [] };
	}

	const parsed = parseEnvContents(contents);
	const keysLoaded: string[] = [];

	for (const [key, value] of Object.entries(parsed)) {
		// Never override existing process.env values - explicit env wins.
		if (process.env[key] !== undefined) {
			continue;
		}

		process.env[key] = value;
		keysLoaded.push(key);
	}

	// Log loaded keys (not values) - secrets are masked.
	if (keysLoaded.length > 0) {
		const safeKeys = keysLoaded.map((k) =>
			isSecretKey(k) ? `${k}=***` : k,
		);
		debug("connection", "loadEnv", "Loaded variables from .env", { keys: safeKeys });
	}

	loaded = true;
	return { loaded: true, keysLoaded };
}

/** Reset the loaded flag - for testing only. */
export function resetLoadRepoEnvFlag(): void {
	loaded = false;
}
