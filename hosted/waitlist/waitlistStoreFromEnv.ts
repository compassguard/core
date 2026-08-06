import { createSqlExecutorFromEnv, readEnv } from "../db/sqlExecutorFromEnv";

import { createInMemoryWaitlistStore, type WaitlistStore } from "./waitlistStore";
import { createPgWaitlistStore } from "./waitlistStorePg";

/**
 * Env-selected WaitlistStore: durable Supabase Postgres when COMPASS_VERDICT_DB_URL is set,
 * the in-memory store otherwise (tests / un-provisioned dev). Consumes the SAME cached pooler
 * client as the credential and verdict stores (createSqlExecutorFromEnv), so one connection
 * serves all three.
 */
export function createWaitlistStoreFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): WaitlistStore {
	const sql = createSqlExecutorFromEnv(getEnv);
	if (!sql) {
		console.warn(
			"waitlist store: in-memory (non-durable) — set COMPASS_VERDICT_DB_URL " +
				"(Supabase transaction-pooler URL) to persist",
		);
		return createInMemoryWaitlistStore();
	}
	console.info("waitlist store: supabase postgres");
	return createPgWaitlistStore({ sql });
}
