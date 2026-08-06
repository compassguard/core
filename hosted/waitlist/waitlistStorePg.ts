import type { SqlExecutor } from "../verdict/verdictStorePg";
import { normalizeEmail } from "../credential/credentialStore";

import type { AddWaitlistInput, WaitlistEntry, WaitlistStore } from "./waitlistStore";

export type PgWaitlistStoreDependencies = { sql: SqlExecutor };

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS waitlist_signups (
	email text PRIMARY KEY,
	created_at text NOT NULL
)`;

/**
 * Durable waitlist store over a single `waitlist_signups` table. Every operation is ONE
 * atomic conditional statement, race-safe across serverless invocations and correct under
 * Supabase transaction-mode pooling — same discipline as createPgCredentialStore. Drop-in
 * for createInMemoryWaitlistStore.
 */
export function createPgWaitlistStore(
	deps: PgWaitlistStoreDependencies,
): WaitlistStore {
	const { sql } = deps;

	// Schema ensure, memoized on SUCCESS only: a failed ensure clears the memo so the
	// next operation retries (never poisons a warm serverless container). Race-tolerant:
	// two cold starts racing CREATE resolve via a to_regclass existence probe.
	let ensured: Promise<void> | undefined;
	function ensureSchema(): Promise<void> {
		if (ensured) return ensured;
		const p = doEnsure();
		ensured = p;
		p.catch(() => {
			if (ensured === p) ensured = undefined;
		});
		return p;
	}
	async function doEnsure(): Promise<void> {
		try {
			await sql(CREATE_TABLE, []);
		} catch (error) {
			const probe = await sql(`SELECT to_regclass('waitlist_signups') AS t`, []);
			if (probe[0]?.t == null) throw error; // genuinely absent → real failure
			// else: a concurrent creator won → the table exists, proceed
		}
	}

	async function run(text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
		await ensureSchema();
		return sql(text, params);
	}

	return {
		async add(input: AddWaitlistInput): Promise<void> {
			await run(
				`INSERT INTO waitlist_signups (email, created_at)
				VALUES ($1, $2)
				ON CONFLICT (email) DO NOTHING`,
				[normalizeEmail(input.email), input.createdAt],
			);
		},

		async list(): Promise<WaitlistEntry[]> {
			const rows = await run(`SELECT email, created_at FROM waitlist_signups`, []);
			return rows.map((row) => ({
				email: row.email as string,
				createdAt: row.created_at as string,
			}));
		},
	};
}
