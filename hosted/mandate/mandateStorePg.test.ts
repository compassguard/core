import { describe, expect, it } from "vitest";

import { PGlite } from "@electric-sql/pglite";

import type { SqlExecutor } from "../verdict/verdictStorePg";
import { createPgMandateStore } from "./mandateStorePg";
import { describeMandateStoreContract } from "./mandateStoreContract";

/** Wrap a PGlite instance as the parameterized SqlExecutor the pg store consumes. */
function executor(db: PGlite): SqlExecutor {
	return async (text, params) => {
		const result = await db.query(text, params);
		return result.rows as Record<string, unknown>[];
	};
}

// Same behavioral contract as the in-memory reference, backed by a fresh in-process PGlite
// (real Postgres semantics, no network) per test — proving the durable swap is drop-in.
describeMandateStoreContract("createPgMandateStore (PGlite)", () =>
	createPgMandateStore({ sql: executor(new PGlite()) }),
);

describe("createPgMandateStore — durable-specific", () => {
	it("cross-instance: a mandate put via one store is visible via another over the same database", async () => {
		const db = new PGlite();
		const sql = executor(db);
		const a = createPgMandateStore({ sql });
		const b = createPgMandateStore({ sql });

		await a.put({
			ownerId: "alice@example.com",
			mandateText: "Vendors only.",
			updatedAt: "2026-07-20T00:00:00.000Z",
		});
		expect((await b.get("alice@example.com"))?.mandateText).toBe("Vendors only.");
	});
});
