#!/usr/bin/env node

/**
 * OpenCode MCP Config Installer for Compass
 *
 * Idempotent, secret-safe installer that writes Compass MCP server config
 * into `.opencode/opencode.json`. Supports `--dry-run`, preserves existing
 * config, creates timestamped backups, and never writes secrets.
 *
 * Usage:
 *   node scripts/install-opencode-mcp.mjs             # write config
 *   node scripts/install-opencode-mcp.mjs --dry-run   # preview only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENCODE_CONFIG_PATH = join(process.cwd(), ".opencode", "opencode.json");
const COMPASS_MCP_KEY = "compass";

const COMPASS_MCP_CONFIG = {
	type: "local",
	command: ["npm", "run", "--silent", "mcp:dev"],
	enabled: true,
	env: {},
};

// Keys that should never be written to config files
const SECRET_ENV_KEYS = [
	/^(COMPASS|OPENAI|ANTHROPIC|LANGCHAIN).*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)$/i,
	/^(COMPASS|OPENAI|ANTHROPIC).*(SIGNER|PRIVATE_?).*/i,
	/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|SIGNER|MNEMONIC|PRIVATE|DATABASE_URL|CONNECTION_STRING)/i,
];

const SENSITIVE_VALUE_PATTERNS = [
	/^(sk-|sk_live_|sk_test_|key_|secret_|token_)/i,
	/^ghp_[A-Za-z0-9_]{20,}$/,
	/^github_pat_[A-Za-z0-9_]{20,}$/,
	/^glpat-[A-Za-z0-9_-]{20,}$/,
	/^xox[baprs]-[A-Za-z0-9-]{20,}$/,
	/^Bearer\s+\S{20,}$/i,
	/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
	/^postgresql:\/\//i,
	/^postgres:\/\//i,
	/^mysql:\/\//i,
	/^mongodb(\+srv)?:\/\//i,
	/^redis:\/\//i,
	/^[a-zA-Z0-9+/]{40,}={0,2}$/,
	/^[a-zA-Z0-9_-]{48,}$/,
];

const EMBEDDED_SENSITIVE_VALUE_PATTERNS = [
	/sk-(?:live-|test-)?[A-Za-z0-9_-]{16,}/i,
	/ghp_[A-Za-z0-9_]{20,}/,
	/github_pat_[A-Za-z0-9_]{20,}/,
	/glpat-[A-Za-z0-9_-]{20,}/,
	/xox[baprs]-[A-Za-z0-9-]{20,}/,
	/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
	/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
	/(postgresql|postgres|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/i,
	/[a-zA-Z0-9+/]{40,}={0,2}/,
	/[a-zA-Z0-9_-]{48,}/,
];

const SENSITIVE_ARG_PATTERNS = [
	/(^|[-_])(?:api[-_]?key|token|secret|password|credential|auth|authorization)(=|:)/i,
	/^Authorization=/i,
];

const SECRET_ARG_FLAG_PATTERN = /^-{1,2}(?:api[-_]?key|token|secret|password|credential|auth|authorization)$/i;

const REDACTED_SECRET_ARG = "[REDACTED_SECRET_ARG]";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function green(text) {
	return `\x1b[32m${text}\x1b[0m`;
}

function yellow(text) {
	return `\x1b[33m${text}\x1b[0m`;
}

function cyan(text) {
	return `\x1b[36m${text}\x1b[0m`;
}

function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function isSecretEnvKey(key) {
	return SECRET_ENV_KEYS.some((pattern) => pattern.test(key));
}

function isSensitiveValue(value) {
	if (typeof value !== "string") return false;
	return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ||
		containsSensitiveSubstring(value);
}

function containsSensitiveSubstring(value) {
	if (typeof value !== "string") return false;
	return EMBEDDED_SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function hasSensitiveArgShape(value) {
	return SENSITIVE_ARG_PATTERNS.some((pattern) => pattern.test(value));
}

function isSecretArgFlag(value) {
	return typeof value === "string" && SECRET_ARG_FLAG_PATTERN.test(value);
}

function splitCommandTokens(value) {
	return value.trim().split(/\s+/).filter(Boolean);
}

function containsSecretFlagValuePair(tokens) {
	return tokens.some((token, index) => isSecretArgFlag(token) && typeof tokens[index + 1] === "string");
}

function sanitizeArg(arg) {
	if (typeof arg !== "string") return arg;
	if (containsSensitiveSubstring(arg) || hasSensitiveArgShape(arg)) {
		const [name] = arg.split(/[=:]/, 1);
		if (name && name !== arg) return `${name}=${REDACTED_SECRET_ARG}`;
		return REDACTED_SECRET_ARG;
	}
	return arg;
}

function sanitizeArgs(args) {
	return args.map(sanitizeArg);
}

function assertNoUnsafeCommandValue(value, fieldName) {
	if (typeof value !== "string") return;
	const tokens = splitCommandTokens(value);
	if (
		containsSensitiveSubstring(value) ||
		hasSensitiveArgShape(value) ||
		containsSecretFlagValuePair(tokens)
	) {
		throw new Error(
			`Unsafe secret-like value found in downstream ${fieldName}. Move credentials to env references instead of command or cwd values.`,
		);
	}
}

function assertNoSecretFlagArgs(args) {
	for (let index = 0; index < args.length; index += 1) {
		if (isSecretArgFlag(args[index]) && typeof args[index + 1] === "string") {
			throw new Error(
				"Unsafe secret-like value found in downstream command args. Move credentials to env references instead of command or cwd values.",
			);
		}
	}
}

function assertSafeDownstreamCommand({ command, args, cwd }) {
	assertNoUnsafeCommandValue(command, "command");
	assertNoSecretFlagArgs(args);
	for (const arg of args) {
		assertNoUnsafeCommandValue(arg, "command args");
	}
	if (typeof cwd === "string") {
		assertNoUnsafeCommandValue(cwd, "cwd");
	}
}

function redactSensitiveSubstrings(value) {
	let redacted = value;
	for (const pattern of EMBEDDED_SENSITIVE_VALUE_PATTERNS) {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		redacted = redacted.replace(new RegExp(pattern.source, flags), "[REDACTED]");
	}
	return redacted;
}

function sanitizeEnv(env) {
	const clean = {};
	for (const [key, value] of Object.entries(env)) {
		if (isEnvReference(value)) {
			clean[key] = value;
			continue;
		}
		if (isSecretEnvKey(key)) {
			clean[key] = `$${key}`;
			continue;
		}
		if (isSensitiveValue(value)) {
			clean[key] = `$${key}`;
			continue;
		}
		clean[key] = value;
	}
	return clean;
}

function isEnvReference(value) {
	return typeof value === "string" && /^\$\{?[A-Z_][A-Z0-9_]*\}?$/i.test(value);
}

function redactValue(value) {
	if (typeof value === "string" && isSensitiveValue(value)) return redactSensitiveSubstrings(value);
	if (Array.isArray(value)) return value.map(redactValue);
	if (value && typeof value === "object") {
		const redacted = {};
		for (const [key, nested] of Object.entries(value)) {
			redacted[key] = isSecretEnvKey(key) ? "[REDACTED]" : redactValue(nested);
		}
		return redacted;
	}
	return value;
}

function containsSecretLikeKey(value) {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(containsSecretLikeKey);
	return Object.entries(value).some(
		([key, nested]) => isSecretEnvKey(key) || containsSecretLikeKey(nested),
	);
}

function containsSecretLikeKeyText(content) {
	try {
		return containsSecretLikeKey(JSON.parse(content));
	} catch {
		return /["']?(?:[A-Z0-9_]*)(?:API[-_]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|SIGNER|MNEMONIC|PRIVATE|DATABASE_URL|CONNECTION_STRING)(?:[A-Z0-9_]*)["']?\s*[:=]/i.test(content);
	}
}

function containsSensitiveBackupContent(content) {
	return containsSensitiveSubstring(content) || containsSecretLikeKeyText(content);
}

function extractLocalCommand(entry) {
	if (!entry || entry.type !== "local") return null;
	if (Array.isArray(entry.command) && entry.command.length > 0) {
		const [command, ...args] = entry.command;
		return typeof command === "string"
			? { command, args: args.filter((arg) => typeof arg === "string") }
			: null;
	}
	if (typeof entry.command === "string" && entry.command.trim() !== "") {
		return { command: entry.command, args: Array.isArray(entry.args) ? entry.args : [] };
	}
	return null;
}

function parseJsonObject(value) {
	if (typeof value !== "string" || value.trim() === "") return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: null;
	} catch {
		return null;
	}
}

function getCompassDownstreamConfig(entry) {
	if (!entry || typeof entry !== "object") return null;
	const envConfig = parseJsonObject(entry.env?.COMPASS_MCP_DOWNSTREAM_CONFIG);
	if (envConfig) return envConfig;

	const command = Array.isArray(entry.command) ? entry.command : [];
	const configFlagIndex = command.indexOf("--downstream-config");
	if (configFlagIndex === -1) return null;
	return parseJsonObject(command[configFlagIndex + 1]);
}

function isCompassWrappedEntry(entry) {
	const downstreamConfig = getCompassDownstreamConfig(entry);
	return Boolean(
		downstreamConfig &&
		typeof downstreamConfig.name === "string" &&
		typeof downstreamConfig.command === "string" &&
		Array.isArray(downstreamConfig.args),
	);
}

export function buildCompassWrappedMcpConfig(config) {
	const mcp = config.mcp ?? {};
	const downstreamEntries = Object.entries(mcp).filter(
		([key, entry]) => key !== COMPASS_MCP_KEY && entry?.enabled !== false && entry?.type === "local",
	);

	if (downstreamEntries.length === 0) {
		const hasRemoteEntries = Object.entries(mcp).some(
			([key, entry]) => key !== COMPASS_MCP_KEY && entry?.enabled !== false && entry?.type === "remote",
		);
		if (isCompassWrappedEntry(mcp[COMPASS_MCP_KEY])) {
			return config;
		}
		const hint = hasRemoteEntries
			? " Found remote/HTTPS MCP entries (e.g. supabase) but Compass only wraps local stdio servers. Add a local MCP server as downstream."
			: " Configure one local MCP server before installing Compass.";
		throw new Error(`No local downstream MCP entry found to wrap.${hint}`);
	}
	if (downstreamEntries.length > 1) {
		throw new Error(
			"Wave 11 supports exactly one downstream MCP server per Compass proxy process. Disable extra MCP entries before installing Compass.",
		);
	}

	const [downstreamKey, downstreamEntry] = downstreamEntries[0];
	const localCommand = extractLocalCommand(downstreamEntry);
	if (!localCommand) {
		throw new Error(
			`MCP entry "${downstreamKey}" is not a local stdio command and cannot be wrapped by Wave 11 Compass proxy.`,
		);
	}
	assertSafeDownstreamCommand({
		...localCommand,
		cwd: downstreamEntry.cwd,
	});
	const downstreamArgs = sanitizeArgs(localCommand.args);

	const env = downstreamEntry.env && typeof downstreamEntry.env === "object"
		? downstreamEntry.env
		: {};
	const envReferences = Object.keys(env);
	const downstreamConfig = {
		name: downstreamKey,
		command: localCommand.command,
		args: downstreamArgs,
		...(typeof downstreamEntry.cwd === "string" ? { cwd: downstreamEntry.cwd } : {}),
		envReferences,
	};
	const compassEnv = {
		...sanitizeEnv(env),
		COMPASS_MCP_DOWNSTREAM_CONFIG: JSON.stringify(downstreamConfig),
	};

	const updatedMcp = {
		[COMPASS_MCP_KEY]: {
			...COMPASS_MCP_CONFIG,
			command: [
				...COMPASS_MCP_CONFIG.command,
				"--",
				"--downstream-config",
				JSON.stringify(downstreamConfig),
			],
			env: compassEnv,
		},
	};

	return {
		...config,
		mcp: updatedMcp,
	};
}

function readJsonFile(filePath) {
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content);
	} catch {
		console.error(yellow(`Warning: Could not parse ${filePath}. Treating as empty.`));
		return {};
	}
}

function writeJsonFile(filePath, data) {
	const dir = join(filePath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const content = JSON.stringify(data, null, 2) + "\n";
	writeFileSync(filePath, content, "utf-8");
}

function createBackup(filePath) {
	const backupPath = `${filePath}.backup-${timestamp()}`;
	if (existsSync(filePath)) {
		const content = readFileSync(filePath, "utf-8");
		if (containsSensitiveBackupContent(content)) {
			console.log(yellow("Warning: Existing OpenCode config contains secret-like content; skipping raw backup to avoid duplicating secrets."));
			return null;
		}
		writeFileSync(backupPath, content, "utf-8");
		console.log(cyan(`Backup created: ${backupPath}`));
	}
	return backupPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
	console.log(cyan("=== Compass OpenCode MCP Installer ===\n"));

	if (dryRun) {
		console.log(yellow("DRY RUN — no files will be written.\n"));
	}

	// Read existing config
	const existingConfig = readJsonFile(OPENCODE_CONFIG_PATH);
	const config = existingConfig ?? {};

	const updatedConfig = buildCompassWrappedMcpConfig(config);

	// Preserve $schema and instructions from existing config
	if (config.$schema) {
		updatedConfig.$schema = config.$schema;
	}
	if (config.instructions) {
		updatedConfig.instructions = config.instructions;
	}

	// Print planned changes
	console.log("Planned changes to .opencode/opencode.json:");
	console.log();
	console.log(JSON.stringify(redactValue(updatedConfig.mcp), null, 2));
	console.log();

	if (dryRun) {
		console.log(yellow("DRY RUN: No files were written."));
		console.log();
		console.log(yellow("To apply, run without --dry-run:"));
		console.log("  npm run mcp:install:opencode");
		return;
	}

	// Create backup before writing
	createBackup(OPENCODE_CONFIG_PATH);

	// Write updated config
	writeJsonFile(OPENCODE_CONFIG_PATH, updatedConfig);
	console.log(green("✓ Updated .opencode/opencode.json with Compass MCP config"));
	console.log();
	console.log(yellow("Restart OpenCode to apply: just close and reopen your editor/terminal."));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
