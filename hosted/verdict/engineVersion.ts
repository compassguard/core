/**
 * The build identity stamped on every verdict (plan R4).
 *
 * Policy and tool classification are SNAPSHOTTED onto the row because they are compiled-in
 * constants a decision reads (D4a/D4b). The engine CODE is the third such input and the one
 * that cannot be snapshotted — `evaluateAction`, `clampLlmDecision`, `collapseToHostedDecision`
 * and `composeVerdictExplanation` all run from whatever build is executing. Recording which
 * build decided turns an otherwise unanswerable question ("would this code have decided the
 * same thing?") into a `git checkout`.
 *
 * Sources, in order: VERCEL_GIT_COMMIT_SHA (set automatically on Vercel deployments), then
 * COMPASS_ENGINE_VERSION (self-hosted / bun / local override).
 *
 * Returns undefined rather than a "unknown" sentinel when neither is set: an absent field reads
 * as absent, while a sentinel that looks like a value invites being compared, grouped, and
 * trusted. Local dev and tests therefore stamp nothing, which is the honest answer.
 */
export function readEngineVersion(
	getEnv: (key: string) => string | undefined = (key) => process.env[key],
): string | undefined {
	const vercelSha = getEnv("VERCEL_GIT_COMMIT_SHA")?.trim();
	if (vercelSha) return vercelSha;
	const explicit = getEnv("COMPASS_ENGINE_VERSION")?.trim();
	if (explicit) return explicit;
	return undefined;
}
