import { describe, expect, it } from "vitest";

import { PGlite } from "@electric-sql/pglite";

import type { SqlExecutor } from "../verdict/verdictStorePg";
import { createPgCredentialStore } from "./credentialStorePg";
import { describeCredentialStoreContract } from "./credentialStoreContract";

/** Wrap a PGlite instance as the parameterized SqlExecutor the pg store consumes. */
function executor(db: PGlite): SqlExecutor {
	return async (text, params) => {
		const result = await db.query(text, params);
		return result.rows as Record<string, unknown>[];
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

// Same behavioral contract as the in-memory reference, backed by a fresh in-process PGlite
// (real Postgres semantics, no network) per test — proving the durable swap is drop-in.
describeCredentialStoreContract("createPgCredentialStore (PGlite)", (options) =>
	createPgCredentialStore({ sql: executor(new PGlite()), ...options }),
);

describe("createPgCredentialStore — durable-specific (cross-instance + schema ensure)", () => {
	it("cross-instance: a credential issued via one store is visible via another over the same database", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const a = createPgCredentialStore({ sql });
		const b = createPgCredentialStore({ sql });

		await a.issue({
			email: "alice@example.com",
			tokenHash: "hash-1",
			createdAt: "2026-07-03T00:00:00.000Z",
		});
		expect(await b.resolveActive("hash-1")).toEqual({ email: "alice@example.com" });
	});

	it("ensure: a race-loser whose CREATE throws proceeds when the table already exists", async () => {
		const db = new PGlite();
		// Store A creates the table for real.
		const a = createPgCredentialStore({ sql: executor(db) });
		await a.issue({
			email: "alice@example.com",
			tokenHash: "hash-1",
			createdAt: "2026-07-03T00:00:00.000Z",
		});

		// Store B's CREATE always throws, but the table exists → to_regclass probe passes → proceed.
		const b = createPgCredentialStore({ sql: throwingCreateExecutor(db, () => true) });
		expect(await b.resolveActive("hash-1")).toEqual({ email: "alice@example.com" });
	});

	it("ensure: a genuine CREATE failure with no table rethrows (no silent degrade)", async () => {
		const db = new PGlite();
		const b = createPgCredentialStore({ sql: throwingCreateExecutor(db, () => true) });
		await expect(b.resolveActive("hash-1")).rejects.toThrow("simulated CREATE failure");
	});

	it("ensure: the memo re-arms after a failed ensure so the next op retries", async () => {
		const db = new PGlite();
		let failing = true;
		const b = createPgCredentialStore({ sql: throwingCreateExecutor(db, () => failing) });

		await expect(b.resolveActive("hash-1")).rejects.toThrow();
		failing = false;
		// The memo was cleared on failure, so the next op re-attempts ensure, which now succeeds.
		expect(await b.resolveActive("hash-1")).toBeUndefined();
	});
});
