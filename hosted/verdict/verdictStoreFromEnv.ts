import { createSqlExecutorFromEnv, readEnv } from "../db/sqlExecutorFromEnv";

import { createInMemoryVerdictStore, type VerdictStore } from "./verdictStore";
import { createPgVerdictStore } from "./verdictStorePg";

/**
 * Env-selected VerdictStore: durable Supabase Postgres when COMPASS_VERDICT_DB_URL is set,
 * the in-memory store otherwise (tests / un-provisioned dev). The connection string MUST
 * point at the Supabase transaction-mode pooler (port 6543); `prepare: false` + a bounded
 * pool are required for that pooling mode. The pooler client is built once and shared with the
 * credential store via createSqlExecutorFromEnv.
 */
export function createVerdictStoreFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): VerdictStore {
	const sql = createSqlExecutorFromEnv(getEnv);
	if (!sql) {
		console.warn(
			"verdict store: in-memory (non-durable) — set COMPASS_VERDICT_DB_URL " +
				"(Supabase transaction-pooler URL) to persist across serverless invocations",
		);
		return createInMemoryVerdictStore();
	}
	console.info("verdict store: supabase postgres");
	return createPgVerdictStore({ sql });
}
