import postgres from "postgres";

import { createInMemoryVerdictStore, type VerdictStore } from "./verdictStore";
import { createPgVerdictStore, type SqlExecutor } from "./verdictStorePg";

// Runtime env read. Bundlers (webpack/Next) inline only *literal* `process.env.X` member access,
// never a dynamic computed lookup, so a plain function reads at runtime as intended — no
// `new Function`/eval indirection, which would run at module load and break eval-restricted
// runtimes (Edge, CSP without unsafe-eval) even on the in-memory path.
const readEnv = (key: string): string | undefined => process.env[key];

// One client per (process, URL), reused across warm serverless invocations — a fresh TCP/pooler
// connection per invocation would exhaust Postgres. Keyed by URL so a rotated
// COMPASS_VERDICT_DB_URL (or a different injected env in tests) never silently keeps talking to
// the previous database.
let cachedClient: ReturnType<typeof postgres> | undefined;
let cachedUrl: string | undefined;

/**
 * Env-selected VerdictStore: durable Supabase Postgres when COMPASS_VERDICT_DB_URL is set,
 * the in-memory store otherwise (tests / un-provisioned dev). The connection string MUST
 * point at the Supabase transaction-mode pooler (port 6543); `prepare: false` + a bounded
 * pool are required for that pooling mode.
 */
export function createVerdictStoreFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): VerdictStore {
	const url = getEnv("COMPASS_VERDICT_DB_URL")?.trim();
	if (!url) {
		console.warn(
			"verdict store: in-memory (non-durable) — set COMPASS_VERDICT_DB_URL " +
				"(Supabase transaction-pooler URL) to persist across serverless invocations",
		);
		return createInMemoryVerdictStore();
	}

	if (!cachedClient || cachedUrl !== url) {
		try {
			cachedClient = postgres(url, { prepare: false, max: 1, idle_timeout: 20 });
		} catch (error) {
			// A malformed URL makes postgres() throw synchronously. Rethrow with an actionable
			// message so a misconfigured deploy fails loudly and diagnosably, instead of a bare
			// "Invalid URL" TypeError surfacing from deep in the driver on every route.
			throw new Error(
				"COMPASS_VERDICT_DB_URL is not a valid Postgres connection string: " +
					(error instanceof Error ? error.message : String(error)),
				{ cause: error },
			);
		}
		cachedUrl = url;
	}
	const client = cachedClient;
	const sql: SqlExecutor = async (text, params) => {
		const rows = await client.unsafe(text, params as (string | number | null)[]);
		return rows as unknown as Record<string, unknown>[];
	};
	console.info("verdict store: supabase postgres");
	return createPgVerdictStore({ sql });
}
