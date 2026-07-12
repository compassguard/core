import { describe, expect, it } from "vitest";

import { PGlite } from "@electric-sql/pglite";

import type { DecidedInput } from "./verdictStore";
import { createPgVerdictStore, type SqlExecutor } from "./verdictStorePg";
import { describeVerdictStoreContract } from "./verdictStoreContract";

/** Wrap a PGlite instance as the parameterized SqlExecutor the pg store consumes. */
function executor(db: PGlite): SqlExecutor {
	return async (text, params) => {
		const result = await db.query(text, params);
		return result.rows as Record<string, unknown>[];
	};
}

/**
 * Simulates the porsager `postgres` driver, whose .unsafe() returns jsonb columns as raw
 * JSON strings (unlike PGlite, which parses them) — verified live against the Supabase
 * pooler. rowToRecord must parse these back, so the full contract runs over this too.
 */
function stringifyingJsonbExecutor(db: PGlite): SqlExecutor {
	const base = executor(db);
	return async (text, params) => {
		const rows = await base(text, params);
		return rows.map((row) => {
			const out = { ...row };
			for (const col of ["reasons", "intended_effect", "discrepancies"]) {
				if (out[col] != null && typeof out[col] !== "string") {
					out[col] = JSON.stringify(out[col]);
				}
			}
			return out;
		});
	};
}

/** Executor that throws on CREATE TABLE while `failing()` is true (simulates a DDL race loser). */
function throwingCreateExecutor(db: PGlite, failing: () => boolean): SqlExecutor {
	const base = executor(db);
	return async (text, params) => {
		if (failing() && /create table/i.test(text)) {
			throw new Error("simulated CREATE failure");
		}
		return base(text, params);
	};
}

function decided(correlationId: string): DecidedInput {
	return {
		correlationId,
		decision: "review",
		reasons: ["TRANSFER_UNKNOWN_RECIPIENT"],
		humanExplanation: "Recipient is not on the allowlist.",
		intendedEffect: { actionKind: "transfer", recipient: "RcpT111", lamports: 25_000_000 },
		decidedAt: "2026-07-03T00:00:00.000Z",
	};
}

// Same behavioral contract as the in-memory reference, backed by a fresh in-process PGlite
// (real Postgres semantics, no network) per test — proving the durable swap is drop-in.
describeVerdictStoreContract("createPgVerdictStore (PGlite)", (options) =>
	createPgVerdictStore({ sql: executor(new PGlite()), ...options }),
);

// Same contract, but jsonb comes back as strings (porsager/Supabase behavior) — guards the
// rowToRecord parse-back that a PGlite-only suite cannot exercise.
describeVerdictStoreContract("createPgVerdictStore (jsonb-as-strings — porsager driver sim)", (options) =>
	createPgVerdictStore({ sql: stringifyingJsonbExecutor(new PGlite()), ...options }),
);

describe("createPgVerdictStore — durable-specific (cross-instance + schema ensure)", () => {
	it("cross-instance: a record put via one store is visible via another over the same database", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const a = createPgVerdictStore({ sql });
		const b = createPgVerdictStore({ sql });

		await a.putDecided(decided("c1"));
		expect((await b.getByCorrelationId("c1"))?.status).toBe("DECIDED");
	});

	it("cross-instance: closeOutcome is idempotent and preserves the first signature across stores", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const a = createPgVerdictStore({ sql });
		const b = createPgVerdictStore({ sql });

		await a.putDecided(decided("c1"));
		const closedA = await a.closeOutcome(
			"c1",
			"mismatch",
			[{ field: "recipient", expected: "x", actual: "y" }],
			"sigA",
		);
		const closedB = await b.closeOutcome("c1", "match", [], "sigB");

		expect(closedA?.status).toBe("CONFIRMED_MISMATCH");
		// B sees A's stored outcome unchanged (idempotent), signature not clobbered.
		expect(closedB?.status).toBe("CONFIRMED_MISMATCH");
		expect(closedB?.discrepancies).toHaveLength(1);
		expect(closedB?.txSignature).toBe("sigA");
	});

	it("legacy tolerance: a CONFIRMING row left by pre-deletion code is still closable", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const store = createPgVerdictStore({ sql });

		await store.putDecided(decided("c1")); // ensures schema + inserts a DECIDED row
		// Simulate a pre-deletion (lease-bearing) instance having parked the row in CONFIRMING.
		await sql(`UPDATE verdicts SET status = 'CONFIRMING' WHERE correlation_id = $1`, ["c1"]);

		const closed = await store.closeOutcome("c1", "match", [], "sig");
		// The retained 'CONFIRMING' predicate lets its next confirm still close it — not stranded.
		expect(closed?.status).toBe("CONFIRMED_MATCH");
		expect(closed?.confirmOutcome).toBe("match");
	});

	it("provisions claimed_at so an old lease-bearing instance's UPDATE does not error on a new-code table", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const store = createPgVerdictStore({ sql });

		await store.putDecided(decided("c1")); // new code creates the table (no claimed_at written)
		// An old instance still runs the retired lease UPDATE; the column must exist for it.
		await expect(
			sql(`UPDATE verdicts SET status = 'CONFIRMING', claimed_at = $2 WHERE correlation_id = $1`, [
				"c1",
				1000,
			]),
		).resolves.toBeDefined();
	});

	it("ensure: a race-loser whose CREATE throws proceeds when the table already exists", async () => {
		const db = new PGlite();
		// Store A creates the table for real.
		const a = createPgVerdictStore({ sql: executor(db) });
		await a.putDecided(decided("c1"));

		// Store B's CREATE always throws, but the table exists → to_regclass probe passes → proceed.
		const b = createPgVerdictStore({ sql: throwingCreateExecutor(db, () => true) });
		expect((await b.getByCorrelationId("c1"))?.status).toBe("DECIDED");
	});

	it("ensure: a genuine CREATE failure with no table rethrows (no silent degrade)", async () => {
		const db = new PGlite();
		const b = createPgVerdictStore({ sql: throwingCreateExecutor(db, () => true) });
		await expect(b.getByCorrelationId("c1")).rejects.toThrow("simulated CREATE failure");
	});

	it("ensure: the memo re-arms after a failed ensure so the next op retries", async () => {
		const db = new PGlite();
		let failing = true;
		const b = createPgVerdictStore({ sql: throwingCreateExecutor(db, () => failing) });

		await expect(b.getByCorrelationId("c1")).rejects.toThrow();
		failing = false;
		// The memo was cleared on failure, so the next op re-attempts ensure, which now succeeds.
		expect(await b.getByCorrelationId("c1")).toBeUndefined();
	});
});
