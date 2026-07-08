import type { SqlExecutor } from "../verdict/verdictStorePg";

import {
	normalizeEmail,
	type CredentialIdentity,
	type CredentialStore,
	type CredentialStoreOptions,
	type IssueCredentialInput,
} from "./credentialStore";

export type PgCredentialStoreDependencies = { sql: SqlExecutor } & CredentialStoreOptions;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS credentials (
	token_hash text PRIMARY KEY,
	email text NOT NULL,
	created_at text NOT NULL,
	revoked_at text
)`;

// Forward-compat migrations for a table created before a column existed (idempotent; a no-op
// on a freshly-created table, an ADD on a pre-existing one) — parity with the verdict store.
const MIGRATIONS = [
	`ALTER TABLE credentials ADD COLUMN IF NOT EXISTS revoked_at text`,
];

/**
 * Durable credential store over a single `credentials` table (D5). Every operation is ONE
 * atomic conditional statement so it is race-safe across serverless invocations (no
 * read-then-write from JS) and correct under Supabase transaction-mode pooling (each
 * statement is independent autocommit). Drop-in for createInMemoryCredentialStore.
 * All columns are text — no jsonb — so no row normalization is needed.
 */
export function createPgCredentialStore(
	deps: PgCredentialStoreDependencies,
): CredentialStore {
	const { sql } = deps;
	const isoNow = deps.isoNow ?? (() => new Date().toISOString());

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
			const probe = await sql(`SELECT to_regclass('credentials') AS t`, []);
			if (probe[0]?.t == null) throw error; // genuinely absent → real failure
			// else: a concurrent creator won → the table exists, proceed
		}
		for (const migration of MIGRATIONS) await sql(migration, []);
	}

	async function run(text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
		await ensureSchema();
		return sql(text, params);
	}

	return {
		async issue(input: IssueCredentialInput): Promise<void> {
			// Existence guard: DB-enforced first-issue-wins. A replayed issue for a tokenHash that
			// already exists is inert (DO NOTHING) — it never overwrites a stored (possibly revoked)
			// credential. Durable persistence makes replay real, so this must be a DB guarantee.
			await run(
				`INSERT INTO credentials (token_hash, email, created_at)
				VALUES ($1, $2, $3)
				ON CONFLICT (token_hash) DO NOTHING`,
				[input.tokenHash, normalizeEmail(input.email), input.createdAt],
			);
		},

		async resolveActive(tokenHash: string): Promise<CredentialIdentity | undefined> {
			const rows = await run(
				`SELECT email FROM credentials WHERE token_hash = $1 AND revoked_at IS NULL`,
				[tokenHash],
			);
			return rows[0] ? { email: rows[0].email as string } : undefined;
		},

		async revokeByEmail(email: string): Promise<number> {
			// Conditional revoke of every active credential for the email in ONE statement;
			// RETURNING gives the disabled count without a read-then-write.
			const rows = await run(
				`UPDATE credentials SET revoked_at = $2
				WHERE email = $1 AND revoked_at IS NULL
				RETURNING token_hash`,
				[normalizeEmail(email), isoNow()],
			);
			return rows.length;
		},
	};
}
