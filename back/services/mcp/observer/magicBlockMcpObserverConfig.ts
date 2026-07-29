import {
	MAGICBLOCK_MCP_AUDIT_DEFAULT_TIMEOUT_MS,
	MAGICBLOCK_MCP_AUDIT_MAX_TIMEOUT_MS,
	MAGICBLOCK_MCP_AUDIT_PATH,
	type MagicBlockMcpObserverRuntimeConfig,
} from "./magicBlockMcpObserverContracts";

const ENABLED_ENV = "COMPASS_MAGICBLOCK_MCP_OBSERVER_ENABLED";
const URL_ENV = "COMPASS_MAGICBLOCK_MCP_AUDIT_URL";
const API_KEY_ENV = "COMPASS_MAGICBLOCK_MCP_OBSERVER_API_KEY";
const TIMEOUT_ENV = "COMPASS_MAGICBLOCK_MCP_OBSERVER_TIMEOUT_MS";

export function readMagicBlockMcpObserverEnvConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
): MagicBlockMcpObserverRuntimeConfig {
	if (env[ENABLED_ENV]?.trim() !== "true") return { enabled: false };

	const url = env[URL_ENV]?.trim();
	const apiKey = env[API_KEY_ENV]?.trim();
	const timeoutMs = parseTimeout(env[TIMEOUT_ENV]);
	if (
		!url ||
		!apiKey ||
		timeoutMs === undefined ||
		!isSafeAuditUrl(url) ||
		!isSafeAuditApiKey(apiKey)
	) {
		return { enabled: false };
	}

	return { enabled: true, url, apiKey, timeoutMs };
}

export function isSafeAuditUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.port === "" &&
			url.pathname === MAGICBLOCK_MCP_AUDIT_PATH &&
			url.search === "" &&
			url.hash === "" &&
			isDnsHostname(url.hostname) &&
			url.toString() === value
		);
	} catch {
		return false;
	}
}

export function isSafeAuditApiKey(value: string): boolean {
	return value.length > 0 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

function parseTimeout(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") {
		return MAGICBLOCK_MCP_AUDIT_DEFAULT_TIMEOUT_MS;
	}
	if (!/^[1-9]\d*$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) &&
		parsed <= MAGICBLOCK_MCP_AUDIT_MAX_TIMEOUT_MS
		? parsed
		: undefined;
}

function isDnsHostname(value: string): boolean {
	if (
		value.length > 253 ||
		value === "localhost" ||
		/^\d+(?:\.\d+){3}$/.test(value)
	) {
		return false;
	}
	const labels = value.split(".");
	return (
		labels.length >= 2 &&
		labels.every(
			(label) =>
				label.length > 0 &&
				label.length <= 63 &&
				/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
		)
	);
}
