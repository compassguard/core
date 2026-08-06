import type { HostedDecision } from "@shared/evaluationContracts";
import type { ToolClassification } from "@shared/executionGatewayContracts";
import type { IntentSource, Mandate } from "@shared/mandateContracts";
import type { CompassPolicy, PolicyEvaluationContext } from "@shared/policyContracts";
import type { Discrepancy, IntendedEffect } from "@shared/verdictContracts";

import type {
	ConfirmOutcome,
	JudgeStatus,
	DecidedInput,
	VerdictRecord,
	VerdictStatus,
	VerdictStore,
	VerdictStoreOptions,
} from "./verdictStoreTypes";

/**
 * Minimal parameterized-SQL seam (D3). A row is a plain column→value map. jsonb columns are
 * NOT uniformly parsed across backings — PGlite returns them already parsed, but the porsager
 * `postgres` driver's .unsafe() returns them as raw JSON strings (verified live against the
 * Supabase pooler), so rowToRecord normalizes each jsonb column via parseJsonb. This module
 * imports NO driver package: prod injects a Supabase-pooler executor, tests a PGlite one.
 *
 * WRITE SIDE: pass the OBJECT/ARRAY to a `$n::jsonb` param, never JSON.stringify(it). The
 * asymmetry above has a mirror image that is far more dangerous, because it fails silently.
 * Probed live against both drivers (2026-07-27): porsager sends a stringified param as TEXT,
 * so `::jsonb` parses it into a jsonb *string* — `jsonb_typeof` returns "string" and every
 * `col->>'key'` predicate yields NULL rather than erroring. PGlite parses the same string
 * into an object, so tests over the PGlite executor cannot see the difference. parseJsonb
 * unwraps the extra layer on read, which is exactly why the corruption stayed invisible: 66
 * live rows were written that way and every read looked correct while all server-side JSON
 * access was quietly dead. Raw values bind correctly on BOTH drivers (objects → jsonb object,
 * arrays → jsonb array), so there is no backing-specific branch to maintain.
 */
export type SqlExecutor = (
	text: string,
	params: unknown[],
) => Promise<Record<string, unknown>[]>;

export type PgVerdictStoreDependencies = {
	sql: SqlExecutor;
	/**
	 * Skip the idempotent schema-ensure (CREATE TABLE + ~23 ADD COLUMN IF NOT EXISTS) that
	 * normally precedes every operation. For genuinely READ-ONLY consumers — the reconstruction
	 * CLI, any least-privilege credential, any tool that must not touch a production schema.
	 * Default false: the service path provisions on demand, which is what makes a cold deploy
	 * work. A store built with this set will fail on a table that does not exist yet, which is
	 * the correct outcome for a reader: reading is not the moment to migrate.
	 */
	skipSchemaEnsure?: boolean;
} & VerdictStoreOptions;

// confirm_outcome preserves execution_failed vs mismatch (both are CONFIRMED_MISMATCH status).
// claimed_at is the RETIRED lease column, kept nullable-and-unwritten by new code ONLY for
// rolling-deploy safety: an old lease-bearing instance still runs UPDATE ... SET claimed_at and
// would error if the column were absent. Do NOT drop until rollback to a lease-bearing version
// is impossible (see the debt registry in docs/compass-demo-day/proposal.md).
// NOTE: keeping the column is SCHEMA compatibility only. Leaseless code still ignores an ACTIVE
// lease and will close a CONFIRMING row out from under an old instance, so a rollback to a
// lease-bearing version MUST be non-overlapping (drain leaseless instances first). Although the
// atomic close keeps the stored verdict consistent, the old close-race loser can return the
// winner's verdict for a different signature because old code lacks post-close reconciliation.
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
	intent_source text,
	judge_rationale text,
	judge_status text,
	tool_name text,
	policy_context jsonb,
	stated_purpose text,
	mandate_snapshot jsonb,
	policy_id text,
	policy_version text,
	policy_snapshot jsonb,
	tool_classification jsonb,
	evaluated_rules jsonb,
	engine_version text,
	deterministic_decision text,
	judge_model text,
	judge_raw_decision text,
	judge_clamped boolean,
	judge_confidence double precision,
	judge_reason_codes jsonb,
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
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS intent_source text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS judge_rationale text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS judge_status text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS tool_name text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS policy_context jsonb`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS stated_purpose text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS mandate_snapshot jsonb`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS policy_id text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS policy_version text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS policy_snapshot jsonb`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS tool_classification jsonb`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS evaluated_rules jsonb`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS engine_version text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS deterministic_decision text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS judge_model text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS judge_raw_decision text`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS judge_clamped boolean`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS judge_confidence double precision`,
	`ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS judge_reason_codes jsonb`,
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
		if (deps.skipSchemaEnsure !== true) await ensureSchema();
		return sql(text, params);
	}

	return {
		async putDecided(input: DecidedInput): Promise<void> {
			// Existence guard: DB-enforced first-put-wins. A replayed put for an id that already
			// exists is inert (DO NOTHING) — it never resurrects a progressed/closed record to
			// DECIDED. Durable persistence makes replay real, so this must be a DB guarantee.
			await run(
				`INSERT INTO verdicts
					(correlation_id, status, decision, reasons, human_explanation, intended_effect, decided_at, user_id, session_id, authenticated_email, intent_source, judge_rationale, judge_status, tool_name, policy_context, stated_purpose, mandate_snapshot, policy_id, policy_version, policy_snapshot, tool_classification, evaluated_rules, engine_version, deterministic_decision, judge_model, judge_raw_decision, judge_clamped, judge_confidence, judge_reason_codes)
				VALUES ($1, 'DECIDED', $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17, $18, $19::jsonb, $20::jsonb, $21::jsonb, $22, $23, $24, $25, $26, $27, $28::jsonb)
				ON CONFLICT (correlation_id) DO NOTHING`,
				[
					input.correlationId,
					input.decision,
					input.reasons,
					input.humanExplanation,
					input.intendedEffect,
					input.decidedAt,
					input.userId ?? null,
					input.sessionId ?? null,
					input.authenticatedEmail ?? null,
					input.intentSource ?? null,
					input.judgeRationale ?? null,
					input.judgeStatus ?? null,
					input.toolName ?? null,
					input.policyContext ?? null,
					input.statedPurpose ?? null,
					input.mandateSnapshot ?? null,
					input.policyId ?? null,
					input.policyVersion ?? null,
					input.policySnapshot ?? null,
					input.toolClassification ?? null,
					input.evaluatedRules ?? null,
					input.engineVersion ?? null,
					input.deterministicDecision ?? null,
					input.judgeModel ?? null,
					input.judgeRawDecision ?? null,
					input.judgeClamped ?? null,
					input.judgeConfidence ?? null,
					input.judgeReasonCodes ?? null,
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
					discrepancies,
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

/**
 * Shape guard for jsonb columns. Postgres guarantees valid JSON *syntax*, never the right
 * *shape*: a column holding `{"code":"X"}` where `["X"]` belongs parses fine and then breaks
 * a caller far away (a non-iterable spread in mergeJudgeReasons, silently non-array
 * evaluatedRules). Today's writer is typed and cannot produce these, so this is a guard
 * against out-of-band writes, hand-run migrations, and future second writers.
 *
 * Fails LOUD rather than coercing to undefined: this is an audit surface, and a record that
 * silently drops its judge reason codes is the exact "looks right but isn't" failure the
 * reconstruction work exists to prevent. The message names the column and the row.
 */
function parseJsonbArray(value: unknown, column: string, correlationId: unknown): string[] {
	const parsed = parseJsonb<unknown>(value);
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
		throw new Error(
			`verdicts.${column} for ${String(correlationId)} is not a string[]: ` +
				`${JSON.stringify(parsed)?.slice(0, 120) ?? typeof parsed}`,
		);
	}
	return parsed as string[];
}

/** Map a stored row to a VerdictRecord; NULL optional columns become absent fields. */
function rowToRecord(row: Record<string, unknown>): VerdictRecord {
	const record: VerdictRecord = {
		correlationId: row.correlation_id as string,
		decision: row.decision as HostedDecision,
		reasons: parseJsonbArray(row.reasons, "reasons", row.correlation_id),
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
	if (row.intent_source != null) record.intentSource = row.intent_source as IntentSource;
	if (row.judge_rationale != null) record.judgeRationale = row.judge_rationale as string;
	if (row.judge_status != null) record.judgeStatus = row.judge_status as JudgeStatus;
	if (row.tool_name != null) record.toolName = row.tool_name as string;
	if (row.policy_context != null) {
		record.policyContext = parseJsonb<PolicyEvaluationContext>(row.policy_context);
	}
	if (row.stated_purpose != null) record.statedPurpose = row.stated_purpose as string;
	if (row.mandate_snapshot != null) {
		record.mandateSnapshot = parseJsonb<Mandate>(row.mandate_snapshot);
	}
	if (row.policy_id != null) record.policyId = row.policy_id as string;
	if (row.policy_version != null) record.policyVersion = row.policy_version as string;
	if (row.policy_snapshot != null) {
		record.policySnapshot = parseJsonb<CompassPolicy>(row.policy_snapshot);
	}
	if (row.tool_classification != null) {
		record.toolClassification = parseJsonb<ToolClassification>(row.tool_classification);
	}
	if (row.evaluated_rules != null) {
		record.evaluatedRules = parseJsonbArray(
			row.evaluated_rules,
			"evaluated_rules",
			row.correlation_id,
		);
	}
	if (row.engine_version != null) record.engineVersion = row.engine_version as string;
	if (row.deterministic_decision != null) {
		record.deterministicDecision = row.deterministic_decision as string;
	}
	if (row.judge_model != null) record.judgeModel = row.judge_model as string;
	if (row.judge_raw_decision != null) {
		record.judgeRawDecision = row.judge_raw_decision as string;
	}
	if (row.judge_clamped != null) record.judgeClamped = row.judge_clamped as boolean;
	if (row.judge_confidence != null) {
		record.judgeConfidence = row.judge_confidence as number;
	}
	if (row.judge_reason_codes != null) {
		record.judgeReasonCodes = parseJsonbArray(
			row.judge_reason_codes,
			"judge_reason_codes",
			row.correlation_id,
		);
	}
	return record;
}
