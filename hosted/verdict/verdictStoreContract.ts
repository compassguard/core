import { describe, expect, it } from "vitest";

import type { IntendedEffect } from "@shared/verdictContracts";
import type {
	DecidedInput,
	VerdictStore,
	VerdictStoreOptions,
} from "./verdictStoreTypes";

/**
 * The behavioral contract of a VerdictStore, as a reusable suite. Every implementation
 * — the in-memory reference and the durable Postgres backing — must satisfy it, so the
 * durable swap is drop-in by construction. `makeStore` builds a FRESH, isolated store
 * (optionally async, e.g. a per-test PGlite database) from injectable options so the
 * isoNow (confirmedAt) assertions are deterministic without a real clock.
 */
export type MakeStore = (
	options?: VerdictStoreOptions,
) => Promise<VerdictStore> | VerdictStore;

const INTENDED: IntendedEffect = {
	actionKind: "transfer",
	recipient: "RcpT111",
	lamports: 25_000_000,
};

function decided(correlationId: string): DecidedInput {
	return {
		correlationId,
		decision: "review",
		reasons: ["TRANSFER_UNKNOWN_RECIPIENT"],
		humanExplanation: "Recipient is not on the allowlist.",
		intendedEffect: INTENDED,
		decidedAt: "2026-07-03T00:00:00.000Z",
	};
}

export function describeVerdictStoreContract(name: string, makeStore: MakeStore): void {
	describe(name, () => {
		it("round-trips a DECIDED record by correlationId", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));

			const record = await store.getByCorrelationId("c1");
			expect(record?.status).toBe("DECIDED");
			expect(record?.intendedEffect).toEqual(INTENDED);
			expect(record?.decision).toBe("review");
		});

		it("closeOutcome sets the CONFIRMED status and is idempotent", async () => {
			const store = await makeStore({ isoNow: () => "2026-07-03T01:00:00.000Z" });
			await store.putDecided(decided("c1"));

			const closed = await store.closeOutcome("c1", "mismatch", [
				{ field: "extra_instruction", actual: "SetAuthority" },
			]);
			expect(closed?.status).toBe("CONFIRMED_MISMATCH");
			expect(closed?.discrepancies).toHaveLength(1);
			expect(closed?.confirmedAt).toBe("2026-07-03T01:00:00.000Z");

			// Idempotent: a repeat returns the cached outcome, does not re-write.
			const again = await store.closeOutcome("c1", "match", []);
			expect(again?.status).toBe("CONFIRMED_MISMATCH");
			expect(again?.discrepancies).toHaveLength(1);
		});

		it("closeOutcome is first-writer-wins under concurrency: racing closes yield one shared winner", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));

			const [a, b] = await Promise.all([
				store.closeOutcome("c1", "match", []),
				store.closeOutcome(
					"c1",
					"mismatch",
					[{ field: "recipient", actual: "y" }],
					"sig",
				),
			]);

			// Two racing closes resolve to ONE winning outcome that BOTH callers receive
			// (the atomic close doing the old lease's job): same status, same discrepancies.
			expect(["CONFIRMED_MATCH", "CONFIRMED_MISMATCH"]).toContain(a?.status);
			expect(a?.status).toBe(b?.status);
			expect(a?.discrepancies).toEqual(b?.discrepancies);

			// The stored record is that single winner.
			const stored = await store.getByCorrelationId("c1");
			expect(stored?.status).toBe(a?.status);
			expect(stored?.discrepancies).toEqual(a?.discrepancies);
		});

		it("closeOutcome persists confirmOutcome, keeping execution_failed distinct from the CONFIRMED_MISMATCH status, and round-trips it", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));

			const closed = await store.closeOutcome("c1", "execution_failed", [], "sig-ef");
			// execution_failed collapses to CONFIRMED_MISMATCH status but is preserved verbatim.
			expect(closed?.status).toBe("CONFIRMED_MISMATCH");
			expect(closed?.confirmOutcome).toBe("execution_failed");

			// Survives a re-read (durable round-trip), not just the returned record.
			const again = await store.getByCorrelationId("c1");
			expect(again?.status).toBe("CONFIRMED_MISMATCH");
			expect(again?.confirmOutcome).toBe("execution_failed");
		});

		it("closeOutcome persists a provided txSignature on the closed record (#14a)", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));

			const closed = await store.closeOutcome("c1", "match", [], "sig-abc");
			expect(closed?.txSignature).toBe("sig-abc");
			expect((await store.getByCorrelationId("c1"))?.txSignature).toBe("sig-abc");
		});

		it("list returns stored records", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));
			await store.putDecided(decided("c2"));

			expect(await store.list()).toHaveLength(2);
			expect(await store.list(1)).toHaveLength(1);
		});

		it("list(limit <= 0) returns no records, never every record (#13)", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));
			await store.putDecided(decided("c2"));

			expect(await store.list(0)).toHaveLength(0);
			expect(await store.list(-1)).toHaveLength(0);
		});

		it("re-putDecided does not resurrect an existing record — replay is inert (existence guard)", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));
			await store.closeOutcome(
				"c1",
				"mismatch",
				[{ field: "recipient", actual: "y" }],
				"sig-1",
			);

			await store.putDecided(decided("c1")); // replay of an already-closed id — must be inert
			const record = await store.getByCorrelationId("c1");
			expect(record?.status).toBe("CONFIRMED_MISMATCH"); // preserved, NOT reset to DECIDED
			expect(record?.discrepancies).toHaveLength(1);
			expect(record?.txSignature).toBe("sig-1");
		});

		it("closeOutcome on an unknown id returns undefined", async () => {
			const store = await makeStore();
			expect(await store.closeOutcome("nope", "match", [])).toBeUndefined();
		});

		it("persists userId/sessionId attribution and round-trips it", async () => {
			const store = await makeStore();
			await store.putDecided({ ...decided("c1"), userId: "user-42", sessionId: "sess-7" });

			const record = await store.getByCorrelationId("c1");
			expect(record?.userId).toBe("user-42");
			expect(record?.sessionId).toBe("sess-7");
		});

		it("leaves attribution absent when the request carried neither", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));

			const record = await store.getByCorrelationId("c1");
			expect(record?.userId).toBeUndefined();
			expect(record?.sessionId).toBeUndefined();
		});

		it("persists authenticatedEmail and round-trips it", async () => {
			const store = await makeStore();
			await store.putDecided({ ...decided("c1"), authenticatedEmail: "alice@example.com" });

			const record = await store.getByCorrelationId("c1");
			expect(record?.authenticatedEmail).toBe("alice@example.com");
		});

		it("leaves authenticatedEmail absent when the request carried none", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));

			const record = await store.getByCorrelationId("c1");
			expect(record?.authenticatedEmail).toBeUndefined();
		});
	});
}
