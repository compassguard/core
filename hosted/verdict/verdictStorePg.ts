import type { HostedDecision } from "@shared/evaluationContracts";
import type { Discrepancy, IntendedEffect } from "@shared/verdictContracts";

import type {
	ClaimResult,
	ConfirmOutcome,
	DecidedInput,
	VerdictRecord,
	VerdictStatus,
	VerdictStore,
	VerdictStoreOptions,
} from "./verdictStore";

/**
 * Minimal parameterized-SQL seam (D3). A row is a plain column→value map; jsonb
 * columns arrive already parsed (both committed backings — PGlite in tests, the
 * porsager `postgres` driver in prod — parse jsonb on read). This module imports NO
 * driver package: prod injects a Supabase-pooler executor, tests a PGlite one.
 */
export type SqlExecutor = (
	text: string,
	params: unknown[],
) => Promise<Record<string, unknown>[]>;

export type PgVerdictStoreDependencies = { sql: SqlExecutor } & VerdictStoreOptions;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS verdicts (
	correlation_id text PRIMARY KEY,
	seq bigserial,
	status text NOT NULL,
	decision text NOT NULL,
	reasons jsonb NOT NULL,
	human_explanation text NOT NULL,
	intended_effect jsonb NOT NULL,
	decided_at text NOT NULL,
	tx_signature text,
	discrepancies jsonb,
	confirmed_at text,
	claimed_at double precision
)`;

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
	const now = deps.now ?? (() => Date.now());
	const isoNow = deps.isoNow ?? (() => new Date().toISOString());
	const leaseTtlMs = deps.leaseTtlMs ?? 20_000;

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
	}

	async function run(text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
		await ensureSchema();
		return sql(text, params);
	}

	return {
		async putDecided(input: DecidedInput): Promise<void> {
			// Full-replace parity: a re-put of a closed record resets it to DECIDED and
			// clears claimed_at/discrepancies/confirmed_at/tx_signature (seq is preserved).
			await run(
				`INSERT INTO verdicts
					(correlation_id, status, decision, reasons, human_explanation, intended_effect, decided_at)
				VALUES ($1, 'DECIDED', $2, $3::jsonb, $4, $5::jsonb, $6)
				ON CONFLICT (correlation_id) DO UPDATE SET
					status = 'DECIDED',
					decision = EXCLUDED.decision,
					reasons = EXCLUDED.reasons,
					human_explanation = EXCLUDED.human_explanation,
					intended_effect = EXCLUDED.intended_effect,
					decided_at = EXCLUDED.decided_at,
					claimed_at = NULL,
					discrepancies = NULL,
					confirmed_at = NULL,
					tx_signature = NULL`,
				[
					input.correlationId,
					input.decision,
					JSON.stringify(input.reasons),
					input.humanExplanation,
					JSON.stringify(input.intendedEffect),
					input.decidedAt,
				],
			);
		},

		async getByCorrelationId(id: string): Promise<VerdictRecord | undefined> {
			const rows = await run(`SELECT * FROM verdicts WHERE correlation_id = $1`, [id]);
			return rows[0] ? rowToRecord(rows[0]) : undefined;
		},

		// Atomic compare-and-set in the storage layer: the conditional UPDATE's row lock
		// serializes concurrent claims so exactly one wins (DECIDED, or a CONFIRMING lease
		// gone stale, is (re)claimed). No row → classify the loser via a follow-up read.
		async claim(id: string): Promise<ClaimResult> {
			const claimed = await run(
				`UPDATE verdicts SET status = 'CONFIRMING', claimed_at = $2
				WHERE correlation_id = $1
					AND (
						status = 'DECIDED'
						OR (status = 'CONFIRMING' AND (claimed_at IS NULL OR $2 - claimed_at >= $3))
					)
				RETURNING correlation_id`,
				[id, now(), leaseTtlMs],
			);
			if (claimed.length === 1) return "claimed";

			const rows = await sql(`SELECT status FROM verdicts WHERE correlation_id = $1`, [id]);
			const status = rows[0]?.status as VerdictStatus | undefined;
			if (status === undefined) return "unknown";
			if (status === "CONFIRMED_MATCH" || status === "CONFIRMED_MISMATCH") {
				return "already_closed";
			}
			// CONFIRMING (fresh lease held), or DECIDED (a release/put raced between the two
			// statements) → conservatively in_progress; the caller retries later.
			return "in_progress";
		},

		async release(id: string): Promise<void> {
			await run(
				`UPDATE verdicts SET status = 'DECIDED', claimed_at = NULL
				WHERE correlation_id = $1 AND status = 'CONFIRMING'`,
				[id],
			);
		},

		async closeOutcome(
			id: string,
			outcome: ConfirmOutcome,
			discrepancies: Discrepancy[],
			txSignature?: string,
		): Promise<VerdictRecord | undefined> {
			// Conditional close from DECIDED|CONFIRMING only, so an already-closed record is
			// never re-written (idempotent). tx_signature is COALESCE'd: a caller omitting it
			// never clobbers an already-set signature (#14a parity).
			const closed = await run(
				`UPDATE verdicts SET
					status = $2,
					discrepancies = $3::jsonb,
					confirmed_at = $4,
					tx_signature = COALESCE($5, tx_signature),
					claimed_at = NULL
				WHERE correlation_id = $1 AND status IN ('DECIDED', 'CONFIRMING')
				RETURNING *`,
				[
					id,
					outcome === "match" ? "CONFIRMED_MATCH" : "CONFIRMED_MISMATCH",
					JSON.stringify(discrepancies),
					isoNow(),
					txSignature ?? null,
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

/** Map a stored row to a VerdictRecord; NULL optional columns become absent fields. */
function rowToRecord(row: Record<string, unknown>): VerdictRecord {
	const record: VerdictRecord = {
		correlationId: row.correlation_id as string,
		decision: row.decision as HostedDecision,
		reasons: row.reasons as string[],
		humanExplanation: row.human_explanation as string,
		intendedEffect: row.intended_effect as IntendedEffect,
		status: row.status as VerdictStatus,
		decidedAt: row.decided_at as string,
	};
	if (row.tx_signature != null) record.txSignature = row.tx_signature as string;
	if (row.discrepancies != null) record.discrepancies = row.discrepancies as Discrepancy[];
	if (row.confirmed_at != null) record.confirmedAt = row.confirmed_at as string;
	if (row.claimed_at != null) record.claimedAt = Number(row.claimed_at);
	return record;
}
