/**
 * LIVE regression guard for jsonb PARAM BINDING against the REAL porsager driver.
 *
 * RUN:
 *   COMPASS_VERDICT_DB_URL="postgres://...@...:6543/postgres" \
 *   npx vitest --config vitest.back.config.ts run hosted/verdict/verdictStorePg.jsonbBinding.live.test.ts
 *
 * SKIPS entirely when COMPASS_VERDICT_DB_URL is unset (safe for normal CI), matching
 * hosted/verify/__e2e_live_suite.test.ts.
 *
 * WHY THIS CANNOT BE A PGLITE TEST — the whole point:
 * PGlite parses a stringified jsonb param into an object, so `JSON.stringify(value)` bound to
 * `$n::jsonb` looks CORRECT there. The porsager driver sends the same param as TEXT, so
 * `::jsonb` stores a jsonb *string* — `jsonb_typeof` = "string" and every `col->>'key'`
 * predicate silently returns NULL. Because parseJsonb unwraps that extra layer on read, the
 * store's own round-trip tests pass either way. 66 live rows were written corrupted while
 * every existing test stayed green, so a guard that runs only on PGlite cannot protect this.
 *
 * Covers EVERY `::jsonb` write site in the codebase (established by
 * `grep -rn "::jsonb" --include="*.ts"`, 2026-07-27) — one site left unguarded is one that can
 * silently regress:
 *   verdictStorePg putDecided   → reasons (array of strings), intended_effect (object)
 *   verdictStorePg closeOutcome → discrepancies (array of OBJECTS — a third distinct shape)
 *   mandateStorePg  put         → allowed_recipients (array of strings)
 *
 * Drives the STORE METHODS, not hand-written SQL: a binding regression would land in the store,
 * so the store is what must be exercised. Writes land in the REAL tables (the pooler routes each
 * statement to its own session, so TEMP tables are not viable), isolated by unmistakable probe
 * ids and removed in afterAll; the final test asserts the row count returns to its baseline.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSqlExecutorFromEnv } from "../db/sqlExecutorFromEnv";
import { createPgMandateStore } from "../mandate/mandateStorePg";
import { createPgVerdictStore } from "./verdictStorePg";

const LIVE = Boolean(process.env.COMPASS_VERDICT_DB_URL);
const sql = LIVE ? createSqlExecutorFromEnv() : undefined;

const PROBE_DECIDED = "jsonb-binding-probe-decided-DELETE-ME";
const PROBE_CLOSED = "jsonb-binding-probe-closed-DELETE-ME";
const PROBE_OWNER = "jsonb-binding-probe-owner-DELETE-ME";

let baselineRows = 0;

async function removeProbes(): Promise<void> {
	if (!sql) return;
	await sql(`DELETE FROM verdicts WHERE correlation_id = ANY($1)`, [
		[PROBE_DECIDED, PROBE_CLOSED] as never,
	]);
	// mandates may not exist yet (not provisioned in prod as of 2026-07-27).
	try {
		await sql(`DELETE FROM mandates WHERE owner_id = $1`, [PROBE_OWNER]);
	} catch {
		/* table absent — nothing to clean */
	}
}

beforeAll(async () => {
	if (!sql) return;
	await removeProbes();
	const rows = await sql(`SELECT count(*)::int AS n FROM verdicts`, []);
	baselineRows = rows[0].n as number;
});

afterAll(removeProbes);

describe.skipIf(!LIVE)("jsonb param binding — real porsager driver", () => {
	it("putDecided stores intended_effect as a jsonb OBJECT and reasons as a jsonb ARRAY", async () => {
		const client = sql as NonNullable<typeof sql>;
		const store = createPgVerdictStore({ sql: client });
		await store.putDecided({
			correlationId: PROBE_DECIDED,
			decision: "review",
			reasons: ["TRANSFER_WITHIN_LIMIT", "RECIPIENT_KNOWN"],
			humanExplanation: "jsonb binding probe",
			intendedEffect: { actionKind: "transfer", recipient: "Rcpt111", amountUsd: 42 },
			decidedAt: "2026-07-27T00:00:00.000Z",
		});

		const row = (
			await client(
				`SELECT jsonb_typeof(intended_effect) AS eff_t,
				        jsonb_typeof(reasons) AS rsn_t,
				        intended_effect->>'amountUsd' AS amount_usd,
				        reasons->>0 AS first_reason
				 FROM verdicts WHERE correlation_id = $1`,
				[PROBE_DECIDED],
			)
		)[0];

		// Would have FAILED before the fix: both types were "string".
		expect(row.eff_t).toBe("object");
		expect(row.rsn_t).toBe("array");
		// The silent-failure symptom — NULL rather than an error — when double-encoded.
		expect(row.amount_usd).toBe("42");
		expect(row.first_reason).toBe("TRANSFER_WITHIN_LIMIT");
	});

	it("closeOutcome stores discrepancies as a jsonb array of queryable OBJECTS", async () => {
		const client = sql as NonNullable<typeof sql>;
		const store = createPgVerdictStore({ sql: client });
		await store.putDecided({
			correlationId: PROBE_CLOSED,
			decision: "allow",
			reasons: ["A"],
			humanExplanation: "jsonb binding probe (close)",
			intendedEffect: { actionKind: "transfer", recipient: "Want", amountUsd: 10 },
			decidedAt: "2026-07-27T00:00:00.000Z",
		});
		const closed = await store.closeOutcome(
			PROBE_CLOSED,
			"mismatch",
			[
				{ field: "recipient", expected: "Want", actual: "Got" },
				{ field: "amount", expected: "10", actual: "99" },
			],
			"SigProbe123",
		);

		const row = (
			await client(
				`SELECT jsonb_typeof(discrepancies) AS d_t,
				        jsonb_typeof(discrepancies->0) AS d0_t,
				        jsonb_array_length(discrepancies) AS d_len,
				        discrepancies->0->>'field' AS d0_field,
				        discrepancies->1->>'actual' AS d1_actual
				 FROM verdicts WHERE correlation_id = $1`,
				[PROBE_CLOSED],
			)
		)[0];

		expect(row.d_t).toBe("array");
		// An array of OBJECTS — the element type is what a stringified bind destroys.
		expect(row.d0_t).toBe("object");
		expect(row.d_len).toBe(2);
		expect(row.d0_field).toBe("recipient");
		expect(row.d1_actual).toBe("99");
		// The store's own read path must still round-trip it.
		expect(closed?.discrepancies).toHaveLength(2);
	});

	it("mandate put stores allowed_recipients as a jsonb ARRAY", async () => {
		const client = sql as NonNullable<typeof sql>;
		const store = createPgMandateStore({ sql: client });
		await store.put({
			ownerId: PROBE_OWNER,
			mandateText: "jsonb binding probe",
			allowedRecipients: ["Rcpt111", "Rcpt222"],
			maxAmountUsd: 500,
			updatedAt: "2026-07-27T00:00:00.000Z",
		});

		const row = (
			await client(
				`SELECT jsonb_typeof(allowed_recipients) AS ar_t,
				        allowed_recipients->>0 AS first_recipient
				 FROM mandates WHERE owner_id = $1`,
				[PROBE_OWNER],
			)
		)[0];

		expect(row.ar_t).toBe("array");
		expect(row.first_recipient).toBe("Rcpt111");
	});

	it("leaves no probe rows behind (isolation is real, not assumed)", async () => {
		const client = sql as NonNullable<typeof sql>;
		await removeProbes();
		const rows = await client(`SELECT count(*)::int AS n FROM verdicts`, []);
		expect(rows[0].n).toBe(baselineRows);
	});
});
