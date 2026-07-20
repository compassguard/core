import type { Mandate, MandateStore } from "@shared/mandateContracts";

import type { SqlExecutor } from "../verdict/verdictStorePg";

export type PgMandateStoreDependencies = { sql: SqlExecutor };

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS mandates (
	owner_id text PRIMARY KEY,
	mandate_text text NOT NULL,
	allowed_recipients jsonb,
	max_amount_usd double precision,
	updated_at text NOT NULL
)`;

/**
 * Durable mandate store over a single `mandates` table. put is ONE atomic upsert
 * (INSERT ... ON CONFLICT DO UPDATE) so it is race-safe across serverless invocations —
 * same idioms as createPgVerdictStore (success-memoized ensureSchema with a to_regclass
 * race probe, driver-agnostic jsonb normalization).
 */
export function createPgMandateStore(deps: PgMandateStoreDependencies): MandateStore {
	const { sql } = deps;

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
			const probe = await sql(`SELECT to_regclass('mandates') AS t`, []);
			if (probe[0]?.t == null) throw error; // genuinely absent → real failure
			// else: a concurrent creator won → the table exists, proceed
		}
	}

	async function run(text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
		await ensureSchema();
		return sql(text, params);
	}

	return {
		async put(mandate: Mandate): Promise<void> {
			// Upsert: the owner's latest mandate wins; omitted optional fields overwrite to
			// NULL (an upsert can clear them — see the store contract).
			await run(
				`INSERT INTO mandates (owner_id, mandate_text, allowed_recipients, max_amount_usd, updated_at)
				VALUES ($1, $2, $3::jsonb, $4, $5)
				ON CONFLICT (owner_id) DO UPDATE SET
					mandate_text = EXCLUDED.mandate_text,
					allowed_recipients = EXCLUDED.allowed_recipients,
					max_amount_usd = EXCLUDED.max_amount_usd,
					updated_at = EXCLUDED.updated_at`,
				[
					mandate.ownerId,
					mandate.mandateText,
					mandate.allowedRecipients ? JSON.stringify(mandate.allowedRecipients) : null,
					mandate.maxAmountUsd ?? null,
					mandate.updatedAt,
				],
			);
		},

		async get(ownerId: string): Promise<Mandate | undefined> {
			const rows = await run(`SELECT * FROM mandates WHERE owner_id = $1`, [ownerId]);
			return rows[0] ? rowToMandate(rows[0]) : undefined;
		},
	};
}

/** jsonb normalization: PGlite returns parsed values, the porsager driver raw JSON strings. */
function parseJsonb<T>(value: unknown): T {
	return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function rowToMandate(row: Record<string, unknown>): Mandate {
	const mandate: Mandate = {
		ownerId: row.owner_id as string,
		mandateText: row.mandate_text as string,
		updatedAt: row.updated_at as string,
	};
	if (row.allowed_recipients != null) {
		mandate.allowedRecipients = parseJsonb<string[]>(row.allowed_recipients);
	}
	if (row.max_amount_usd != null) mandate.maxAmountUsd = Number(row.max_amount_usd);
	return mandate;
}
