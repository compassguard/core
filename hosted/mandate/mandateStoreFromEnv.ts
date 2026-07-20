import type { MandateStore } from "@shared/mandateContracts";

import { createSqlExecutorFromEnv, readEnv } from "../db/sqlExecutorFromEnv";

import { createInMemoryMandateStore } from "./mandateStore";
import { createPgMandateStore } from "./mandateStorePg";

/**
 * Env-selected MandateStore: durable Supabase Postgres when COMPASS_VERDICT_DB_URL is set
 * (the SAME shared pooler client as the verdict + credential stores), in-memory otherwise.
 */
export function createMandateStoreFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): MandateStore {
	const sql = createSqlExecutorFromEnv(getEnv);
	if (!sql) {
		console.warn(
			"mandate store: in-memory (non-durable) — set COMPASS_VERDICT_DB_URL " +
				"(Supabase transaction-pooler URL) to persist across serverless invocations",
		);
		return createInMemoryMandateStore();
	}
	console.info("mandate store: supabase postgres");
	return createPgMandateStore({ sql });
}
