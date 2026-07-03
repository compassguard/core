export function getEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

const DEFAULT_HOSTED_TIMEOUT_MS = 750;

export function readHostedBackendEnvConfig(
	env: Record<string, string | undefined> = process.env,
) {
	return {
		apiUrl: readNonEmptyString(env.COMPASS_HOSTED_API_URL),
		apiKey: readNonEmptyString(env.COMPASS_HOSTED_API_KEY),
		timeoutMs: readPositiveInteger(
			env.COMPASS_HOSTED_TIMEOUT_MS,
			DEFAULT_HOSTED_TIMEOUT_MS,
		),
		hybridGuardEnabled: readBoolean(env.COMPASS_HYBRID_GUARD_ENABLED, true),
		installationId: readNonEmptyString(env.COMPASS_INSTALLATION_ID),
	} as const;
}

function readNonEmptyString(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalizedValue = value.trim();
	return normalizedValue.length > 0 ? normalizedValue : undefined;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
	if (typeof value !== "string") {
		return fallback;
	}

	const parsedValue = Number.parseInt(value, 10);
	return Number.isFinite(parsedValue) && parsedValue > 0
		? parsedValue
		: fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
	if (typeof value !== "string") {
		return fallback;
	}

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return fallback;
	}
}
