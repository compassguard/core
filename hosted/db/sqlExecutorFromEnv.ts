import postgres from "postgres";

import type { SqlExecutor } from "../verdict/verdictStorePg";

// Runtime env read. Bundlers (webpack/Next) inline only *literal* `process.env.X` member access,
// never a dynamic computed lookup, so a plain function reads at runtime as intended — no
// `new Function`/eval indirection, which would run at module load and break eval-restricted
// runtimes (Edge, CSP without unsafe-eval) even on the in-memory path.
export const readEnv = (key: string): string | undefined => process.env[key];

// One client per (process, URL), reused across warm serverless invocations — a fresh TCP/pooler
// connection per invocation would exhaust Postgres. Keyed by URL so a rotated
// COMPASS_VERDICT_DB_URL (or a different injected env in tests) never silently keeps talking to
// the previous database. This is the SINGLE cached client every env-selected store shares.
let cachedClient: ReturnType<typeof postgres> | undefined;
let cachedUrl: string | undefined;

/**
 * The shared env-selected SqlExecutor: a durable Supabase Postgres executor when
 * COMPASS_VERDICT_DB_URL is set, `undefined` otherwise (tests / un-provisioned dev). The
 * connection string MUST point at the Supabase transaction-mode pooler (port 6543);
 * `prepare: false` + a bounded pool are required for that pooling mode. Both the verdict store
 * and the credential store consume this, so one pooler client serves both.
 */
export function createSqlExecutorFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): SqlExecutor | undefined {
	const url = getEnv("COMPASS_VERDICT_DB_URL")?.trim();
	if (!url) return undefined;

	if (!cachedClient || cachedUrl !== url) {
		try {
			// Supabase's pooler rejects non-SSL connections ("SSL connection is required"), but the
			// driver defaults ssl to false when the URL omits sslmode (index.js:443). Default to SSL
			// so operators don't have to remember ?sslmode=require; respect an explicit sslmode/ssl in
			// the URL (e.g. sslmode=disable for a local non-SSL Postgres) by leaving it to the driver.
			const urlDeclaresSsl = /[?&](sslmode|ssl)=/i.test(url);
			cachedClient = postgres(url, {
				prepare: false,
				max: 1,
				idle_timeout: 20,
				...(urlDeclaresSsl ? {} : { ssl: "require" }),
			});
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
	return sql;
}
