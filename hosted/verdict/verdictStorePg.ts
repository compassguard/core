import type { HostedDecision } from "@shared/evaluationContracts";
import type { Discrepancy, IntendedEffect } from "@shared/verdictContracts";

import type {
	ConfirmOutcome,
	DecidedInput,
	VerdictRecord,
	VerdictStatus,
	VerdictStore,
	VerdictStoreOptions,
} from "./verdictStore";

/**
 * Minimal parameterized-SQL seam (D3). A row is a plain column→value map. jsonb columns are
 * NOT uniformly parsed across backings — PGlite returns them already parsed, but the porsager
 * `postgres` driver's .unsafe() returns them as raw JSON strings (verified live against the
 * Supabase pooler), so rowToRecord normalizes each jsonb column via parseJsonb. This module
 * imports NO driver package: prod injects a Supabase-pooler executor, tests a PGlite one.
 */
export type SqlExecutor = (
	text: string,
	params: unknown[],
) => Promise<Record<string, unknown>[]>;

export type PgVerdictStoreDependencies = { sql: SqlExecutor } & VerdictStoreOptions;

// confirm_outcome preserves execution_failed vs mismatch (both are CONFIRMED_MISMATCH status).
// claimed_at is the RETIRED lease column, kept nullable-and-unwritten by new code ONLY for
// rolling-deploy safety: an old lease-bearing instance still runs UPDATE ... SET claimed_at and
// would error if the column were absent. Do NOT drop until rollback to a lease-bearing version
// is impossible (see the debt registry in docs/compass-demo-day/proposal.md).
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS verdicts (
	correlation_id text PRIMARY KEY,
	seq bigserial,
	status text NOT NULL,
	decision text NOT NULL,
	reasons jsonb NOT NULL,
	human_explanation text NOT NULL,
	intended_effect jsonb NOT NULL,
	decided_at text NOT NULL,
	user_id text,
	session_id text,
	authenticated_email text,
	tx_signature text,
	discrepancies jsonb,
	confirmed_at text,
	confirm_outcome text,
	claimed_at double precision
)`;

// Forward-compat migrations for a table created before a column existed (idempotent; a no-op
// on a freshly-created table, an ADD on a pre-existing one — so a live `verdicts` table gains
// new columns with no manual migration). claimed_at is re-provisioned here too, so a table
// created new-code-first still carries the column old instances write during a rolling deploy.
const MIGRATIONS = [
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS user_id text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS session_id text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS authenticated_email text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS confirm_outcome text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS claimed_at double precision`,
];

/**
 * Durable verdict store over a single `verdicts` table (D4-v5/D5-v5). Every lifecycle
 * transition is ONE atomic conditional statement so it is race-safe across serverless
 * invocations (no read-then-write from JS) and correct under Supabase transaction-mode
 * pooling (each statement is independent autocommit). Drop-in for createInMemoryVerdictStore.
 */
export function createPgVerdictStore(
	deps: PgVerdictStoreDependencies,
): VerdictStore {
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
			const probe = await sql(`SELECT to_regclass('verdicts') AS t`, []);
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
		async putDecided(input: DecidedInput): Promise<void> {
			// Existence guard: DB-enforced first-put-wins. A replayed put for an id that already
			// exists is inert (DO NOTHING) — it never resurrects a progressed/closed record to
			// DECIDED. Durable persistence makes replay real, so this must be a DB guarantee.
			await run(
				`INSERT INTO verdicts
					(correlation_id, status, decision, reasons, human_explanation, intended_effect, decided_at, user_id, session_id, authenticated_email)
				VALUES ($1, 'DECIDED', $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8, $9)
				ON CONFLICT (correlation_id) DO NOTHING`,
				[
					input.correlationId,
					input.decision,
					JSON.stringify(input.reasons),
					input.humanExplanation,
					JSON.stringify(input.intendedEffect),
					input.decidedAt,
					input.userId ?? null,
					input.sessionId ?? null,
					input.authenticatedEmail ?? null,
				],
			);
		},

		async getByCorrelationId(id: string): Promise<VerdictRecord | undefined> {
			const rows = await run(`SELECT * FROM verdicts WHERE correlation_id = $1`, [id]);
			return rows[0] ? rowToRecord(rows[0]) : undefined;
		},

		async closeOutcome(
			id: string,
			outcome: ConfirmOutcome,
			discrepancies: Discrepancy[],
			txSignature?: string,
		): Promise<VerdictRecord | undefined> {
			// Conditional close from a non-terminal row only, so an already-closed record is
			// never re-written (idempotent). tx_signature is COALESCE'd: a caller omitting it
			// never clobbers an already-set signature (#14a parity). 'CONFIRMING' is retained in
			// the predicate ONLY as legacy-row tolerance — a row written CONFIRMING by pre-deletion
			// code stays closable by its next confirm; new code never writes CONFIRMING.
			const closed = await run(
				`UPDATE verdicts SET
					status = $2,
					confirm_outcome = $6,
					discrepancies = $3::jsonb,
					confirmed_at = $4,
					tx_signature = COALESCE($5, tx_signature)
				WHERE correlation_id = $1 AND status IN ('DECIDED', 'CONFIRMING')
				RETURNING *`,
				[
					id,
					outcome === "match" ? "CONFIRMED_MATCH" : "CONFIRMED_MISMATCH",
					JSON.stringify(discrepancies),
					isoNow(),
					txSignature ?? null,
					outcome,
				],
			);
			if (closed[0]) return rowToRecord(closed[0]);

			// No row updated → either absent (undefined) or already closed (return cached).
			const rows = await sql(`SELECT * FROM verdicts WHERE correlation_id = $1`, [id]);
			return rows[0] ? rowToRecord(rows[0]) : undefined;
		},

		async list(limit?: number): Promise<VerdictRecord[]> {
			if (limit !== undefined && limit <= 0) return [];
			if (limit === undefined) {
				const rows = await run(`SELECT * FROM verdicts ORDER BY seq ASC`, []);
				return rows.map(rowToRecord);
			}
			// Last N in insertion order: take the newest N by seq, then reverse to ascending.
			const rows = await run(
				`SELECT * FROM verdicts ORDER BY seq DESC LIMIT $1`,
				[limit],
			);
			return rows.map(rowToRecord).reverse();
		},
	};
}

/**
 * Normalize a jsonb column to its parsed value. Drivers differ: PGlite returns jsonb
 * already parsed (object/array), while the porsager `postgres` driver's .unsafe() returns
 * it as a raw JSON string — verified live against the Supabase pooler. Parsing the string
 * form keeps a VerdictRecord's reasons/intendedEffect/discrepancies structured regardless
 * of backing.
 */
function parseJsonb<T>(value: unknown): T {
	return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

/** Map a stored row to a VerdictRecord; NULL optional columns become absent fields. */
function rowToRecord(row: Record<string, unknown>): VerdictRecord {
	const record: VerdictRecord = {
		correlationId: row.correlation_id as string,
		decision: row.decision as HostedDecision,
		reasons: parseJsonb<string[]>(row.reasons),
		humanExplanation: row.human_explanation as string,
		intendedEffect: parseJsonb<IntendedEffect>(row.intended_effect),
		status: row.status as VerdictStatus,
		decidedAt: row.decided_at as string,
	};
	if (row.user_id != null) record.userId = row.user_id as string;
	if (row.session_id != null) record.sessionId = row.session_id as string;
	if (row.authenticated_email != null) {
		record.authenticatedEmail = row.authenticated_email as string;
	}
	if (row.tx_signature != null) record.txSignature = row.tx_signature as string;
	if (row.discrepancies != null) {
		record.discrepancies = parseJsonb<Discrepancy[]>(row.discrepancies);
	}
	if (row.confirmed_at != null) record.confirmedAt = row.confirmed_at as string;
	if (row.confirm_outcome != null) {
		record.confirmOutcome = row.confirm_outcome as ConfirmOutcome;
	}
	return record;
}
