import { createSqlExecutorFromEnv, readEnv } from "../db/sqlExecutorFromEnv";

import {
	createInMemoryCredentialStore,
	type CredentialStore,
} from "./credentialStore";
import { createPgCredentialStore } from "./credentialStorePg";

/**
 * Env-selected CredentialStore: durable Supabase Postgres when COMPASS_VERDICT_DB_URL is set,
 * the in-memory store otherwise (tests / un-provisioned dev). Consumes the SAME cached pooler
 * client as the verdict store (createSqlExecutorFromEnv), so one connection serves both stores.
 */
export function createCredentialStoreFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): CredentialStore {
	const sql = createSqlExecutorFromEnv(getEnv);
	if (!sql) {
		console.warn(
			"credential store: in-memory (non-durable) — set COMPASS_VERDICT_DB_URL " +
				"(Supabase transaction-pooler URL) to persist",
		);
		return createInMemoryCredentialStore();
	}
	console.info("credential store: supabase postgres");
	return createPgCredentialStore({ sql });
}
