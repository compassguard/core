import postgres from "postgres";

import { createInMemoryVerdictStore, type VerdictStore } from "./verdictStore";
import { createPgVerdictStore, type SqlExecutor } from "./verdictStorePg";

// Runtime env read that survives webpack's build-time `process.env.X` inlining — the same
// pattern the Vercel route handler uses (app/api/hosted/[...route]/route.ts).
const readEnv = new Function("key", "return process.env[key]") as (
	key: string,
) => string | undefined;

// One client per process, reused across warm serverless invocations (a new TCP/pooler
// connection per invocation would exhaust Postgres).
let cachedClient: ReturnType<typeof postgres> | undefined;

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

	if (!cachedClient) {
		cachedClient = postgres(url, { prepare: false, max: 1, idle_timeout: 20 });
	}
	const client = cachedClient;
	const sql: SqlExecutor = async (text, params) => {
		const rows = await client.unsafe(text, params as (string | number | null)[]);
		return rows as unknown as Record<string, unknown>[];
	};
	console.info("verdict store: supabase postgres");
	return createPgVerdictStore({ sql });
}
