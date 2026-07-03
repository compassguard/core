/**
 * Runtime config parsing for the Wave 11 stdio MCP proxy.
 *
 * The proxy supports one downstream stdio MCP server per process. Runtime
 * config may arrive from CLI flags, an environment variable, or installer
 * wrapper output. Raw secret values are not required in CLI/config payloads;
 * envReferences are resolved from the current process environment at startup.
 */

import type {
	DownstreamMcpRuntimeConfig,
	DownstreamMcpStdioConfig,
} from "../proxy/mcpProxyContracts";

const CONFIG_ENV_KEY = "COMPASS_MCP_DOWNSTREAM_CONFIG";

export type DownstreamConfigParseInput = {
	argv?: readonly string[];
	env?: NodeJS.ProcessEnv;
};

export function parseDownstreamMcpRuntimeConfig(
	input: DownstreamConfigParseInput = {},
): DownstreamMcpStdioConfig {
	const argv = [...(input.argv ?? process.argv.slice(2))];
	const env = input.env ?? process.env;
	const fromCliJson = getFlagValue(argv, "--downstream-config");
	const fromEnvJson = env[CONFIG_ENV_KEY];
	const parsed = fromCliJson
		? parseConfigJson(fromCliJson, "--downstream-config")
		: fromEnvJson
			? parseConfigJson(fromEnvJson, CONFIG_ENV_KEY)
			: parseFlagConfig(argv);

	if (!parsed) {
		throw new Error(
			"Compass MCP proxy is not configured. Provide one downstream stdio MCP server via --downstream-config, --downstream-command, or COMPASS_MCP_DOWNSTREAM_CONFIG.",
		);
	}

	return normalizeRuntimeConfig(parsed, env);
}

function parseConfigJson(
	value: string,
	source: string,
): DownstreamMcpRuntimeConfig {
	try {
		return JSON.parse(value) as DownstreamMcpRuntimeConfig;
	} catch {
		throw new Error(
			`Invalid downstream MCP config in ${source}. Expected JSON object with name, command, args, cwd, and envReferences.`,
		);
	}
}

function parseFlagConfig(
	argv: readonly string[],
): DownstreamMcpRuntimeConfig | undefined {
	const command = getFlagValue(argv, "--downstream-command");
	if (!command) {
		return undefined;
	}

	const argsJson = getFlagValue(argv, "--downstream-args-json");
	const args = argsJson ? parseStringArray(argsJson, "--downstream-args-json") : [];
	const cwd = getFlagValue(argv, "--downstream-cwd");
	const envRefs = getFlagValue(argv, "--downstream-env-keys");

	return {
		name: getFlagValue(argv, "--downstream-name") ?? "downstream-mcp",
		command,
		args,
		...(cwd ? { cwd } : {}),
		...(envRefs ? { envReferences: splitCsv(envRefs) } : {}),
	};
}

function normalizeRuntimeConfig(
	config: DownstreamMcpRuntimeConfig,
	env: NodeJS.ProcessEnv,
): DownstreamMcpStdioConfig {
	if (!config || typeof config !== "object") {
		throw new Error("Downstream MCP config must be an object.");
	}
	if (!config.command || config.command.trim() === "") {
		throw new Error("Downstream MCP config requires a non-empty command.");
	}
	const args = Array.isArray(config.args) ? [...config.args] : [];
	if (!args.every((arg) => typeof arg === "string")) {
		throw new Error("Downstream MCP config args must be an array of strings.");
	}

	const referencedEnv: Record<string, string> = {};
	for (const key of config.envReferences ?? []) {
		if (typeof key !== "string" || key.trim() === "") continue;
		const value = env[key];
		if (typeof value === "string") {
			referencedEnv[key] = value;
		}
	}

	return {
		name: config.name || "downstream-mcp",
		command: config.command,
		args,
		...(config.cwd ? { cwd: config.cwd } : {}),
		...(Object.keys(referencedEnv).length > 0 ? { env: referencedEnv } : {}),
	};
}

function getFlagValue(argv: readonly string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	if (index === -1) return undefined;
	const value = argv[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

function parseStringArray(value: string, source: string): string[] {
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
			return parsed;
		}
	} catch {
		// fall through to clear error below
	}
	throw new Error(`${source} must be a JSON array of strings.`);
}

function splitCsv(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}
