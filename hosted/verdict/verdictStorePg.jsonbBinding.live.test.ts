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
 * Isolated by construction: everything happens in a TEMP table, so a live run touches no real
 * verdict rows. Temp tables are per-session; with the transaction pooler each statement may
 * land on a different backend session, so the table is created UNLOGGED with a unique name and
 * dropped in afterAll instead.
 */
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const DB_URL = process.env.COMPASS_VERDICT_DB_URL;
const LIVE = Boolean(DB_URL);

// prepare:false + bounded pool are required for the Supabase transaction pooler (port 6543).
const sql = LIVE ? postgres(DB_URL as string, { prepare: false, max: 1, ssl: "require" }) : null;
// Fixed suffix (no Date.now()) so a crashed run leaves one predictable table to clean up.
const TABLE = "jsonb_binding_probe_verdictstore";

afterAll(async () => {
	if (sql) {
		await sql.unsafe(`DROP TABLE IF EXISTS ${TABLE}`, []);
		await sql.end();
	}
});

describe.skipIf(!LIVE)("jsonb param binding — real porsager driver", () => {
	it("stores a raw object as a jsonb OBJECT whose keys are server-side queryable", async () => {
		const client = sql as NonNullable<typeof sql>;
		await client.unsafe(`DROP TABLE IF EXISTS ${TABLE}`, []);
		await client.unsafe(`CREATE UNLOGGED TABLE ${TABLE} (id text PRIMARY KEY, eff jsonb, reasons jsonb)`, []);

		// Exactly how verdictStorePg.putDecided binds these params.
		const intendedEffect = { actionKind: "transfer", recipient: "Rcpt111", amountUsd: 42 };
		const reasons = ["TRANSFER_WITHIN_LIMIT", "RECIPIENT_KNOWN"];
		await client.unsafe(
			`INSERT INTO ${TABLE} (id, eff, reasons) VALUES ($1, $2::jsonb, $3::jsonb)`,
			["row-1", intendedEffect as never, reasons as never],
		);

		const rows = await client.unsafe(
			`SELECT jsonb_typeof(eff) AS eff_type,
			        jsonb_typeof(reasons) AS reasons_type,
			        eff->>'amountUsd' AS amount_usd,
			        reasons->>0 AS first_reason
			 FROM ${TABLE} WHERE id = $1`,
			["row-1"],
		);

		// The assertions that would have FAILED before the fix:
		expect(rows[0].eff_type).toBe("object");
		expect(rows[0].reasons_type).toBe("array");
		// The silent-failure symptom: NULL here, not an error, when the value is double-encoded.
		expect(rows[0].amount_usd).toBe("42");
		expect(rows[0].first_reason).toBe("TRANSFER_WITHIN_LIMIT");
	});

	it("demonstrates the OLD binding still corrupts, so this guard is load-bearing", async () => {
		const client = sql as NonNullable<typeof sql>;
		await client.unsafe(
			`INSERT INTO ${TABLE} (id, eff, reasons) VALUES ($1, $2::jsonb, $3::jsonb)`,
			["row-stringified", JSON.stringify({ amountUsd: 42 }), JSON.stringify(["A"])],
		);
		const rows = await client.unsafe(
			`SELECT jsonb_typeof(eff) AS eff_type, eff->>'amountUsd' AS amount_usd
			 FROM ${TABLE} WHERE id = $1`,
			["row-stringified"],
		);
		// Pinning the defect: a stringified param yields a jsonb STRING and a NULL key lookup.
		// If this ever starts returning "object"/"42", the driver's behavior changed and the
		// first test's guarantee no longer needs this workaround — revisit both.
		expect(rows[0].eff_type).toBe("string");
		expect(rows[0].amount_usd).toBeNull();
	});
});
