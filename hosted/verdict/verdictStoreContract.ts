import { describe, expect, it } from "vitest";

import type { IntendedEffect } from "@shared/verdictContracts";
import type {
	DecidedInput,
	VerdictStore,
	VerdictStoreOptions,
} from "./verdictStore";

/**
 * The behavioral contract of a VerdictStore, as a reusable suite. Every implementation
 * — the in-memory reference and the durable Postgres backing — must satisfy it, so the
 * durable swap is drop-in by construction. `makeStore` builds a FRESH, isolated store
 * (optionally async, e.g. a per-test PGlite database) from injectable options so the
 * lease-TTL / clock / isoNow assertions are deterministic without a real clock.
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

		it("claim on unknown id returns unknown", async () => {
			const store = await makeStore();
			expect(await store.claim("nope")).toBe("unknown");
		});

		it("claims a DECIDED record and marks it CONFIRMING", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));

			expect(await store.claim("c1")).toBe("claimed");
			expect((await store.getByCorrelationId("c1"))?.status).toBe("CONFIRMING");
		});

		it("a second concurrent claim within the lease TTL returns in_progress", async () => {
			const store = await makeStore({ now: () => 1000, leaseTtlMs: 20_000 });
			await store.putDecided(decided("c1"));

			expect(await store.claim("c1")).toBe("claimed");
			expect(await store.claim("c1")).toBe("in_progress");
		});

		it("reclaims a CONFIRMING record whose lease has gone stale (self-healing)", async () => {
			let t = 1000;
			const store = await makeStore({ now: () => t, leaseTtlMs: 20_000 });
			await store.putDecided(decided("c1"));

			expect(await store.claim("c1")).toBe("claimed"); // claimedAt = 1000
			t = 1000 + 20_000; // lease expired
			expect(await store.claim("c1")).toBe("claimed"); // reclaimed, not stranded
		});

		it("release returns a CONFIRMING record to DECIDED (retryable)", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));
			await store.claim("c1");

			await store.release("c1");
			expect((await store.getByCorrelationId("c1"))?.status).toBe("DECIDED");
		});

		it("closeOutcome sets the CONFIRMED status and is idempotent", async () => {
			const store = await makeStore({ isoNow: () => "2026-07-03T01:00:00.000Z" });
			await store.putDecided(decided("c1"));
			await store.claim("c1");

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

		it("claim on a closed record returns already_closed", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));
			await store.claim("c1");
			await store.closeOutcome("c1", "match", []);

			expect(await store.claim("c1")).toBe("already_closed");
		});

		it("closeOutcome persists a provided txSignature on the closed record (#14a)", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));
			await store.claim("c1");

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

		it("re-putDecided of a closed record resets it to a fresh DECIDED (full-replace)", async () => {
			const store = await makeStore();
			await store.putDecided(decided("c1"));
			await store.claim("c1");
			await store.closeOutcome(
				"c1",
				"mismatch",
				[{ field: "recipient", actual: "y" }],
				"sig-1",
			);

			await store.putDecided(decided("c1"));
			const record = await store.getByCorrelationId("c1");
			expect(record?.status).toBe("DECIDED");
			expect(record?.discrepancies).toBeUndefined();
			expect(record?.confirmedAt).toBeUndefined();
			expect(record?.txSignature).toBeUndefined();
		});

		it("closeOutcome on an unknown id returns undefined", async () => {
			const store = await makeStore();
			expect(await store.closeOutcome("nope", "match", [])).toBeUndefined();
		});
	});
}
