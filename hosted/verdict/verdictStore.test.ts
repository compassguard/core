import { describe, expect, it } from "vitest";

import type { IntendedEffect } from "@shared/verdictContracts";
import { createInMemoryVerdictStore, type DecidedInput } from "./verdictStore";

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

describe("createInMemoryVerdictStore", () => {
	it("round-trips a DECIDED record by correlationId", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));

		const record = await store.getByCorrelationId("c1");
		expect(record?.status).toBe("DECIDED");
		expect(record?.intendedEffect).toEqual(INTENDED);
		expect(record?.decision).toBe("review");
	});

	it("claim on unknown id returns unknown", async () => {
		const store = createInMemoryVerdictStore();
		expect(await store.claim("nope")).toBe("unknown");
	});

	it("claims a DECIDED record and marks it CONFIRMING", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));

		expect(await store.claim("c1")).toBe("claimed");
		expect((await store.getByCorrelationId("c1"))?.status).toBe("CONFIRMING");
	});

	it("a second concurrent claim within the lease TTL returns in_progress", async () => {
		const store = createInMemoryVerdictStore({ now: () => 1000, leaseTtlMs: 20_000 });
		await store.putDecided(decided("c1"));

		expect(await store.claim("c1")).toBe("claimed");
		expect(await store.claim("c1")).toBe("in_progress");
	});

	it("reclaims a CONFIRMING record whose lease has gone stale (self-healing)", async () => {
		let t = 1000;
		const store = createInMemoryVerdictStore({ now: () => t, leaseTtlMs: 20_000 });
		await store.putDecided(decided("c1"));

		expect(await store.claim("c1")).toBe("claimed"); // claimedAt = 1000
		t = 1000 + 20_000; // lease expired
		expect(await store.claim("c1")).toBe("claimed"); // reclaimed, not stranded
	});

	it("release returns a CONFIRMING record to DECIDED (retryable)", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		await store.claim("c1");

		await store.release("c1");
		expect((await store.getByCorrelationId("c1"))?.status).toBe("DECIDED");
	});

	it("closeOutcome sets the CONFIRMED status and is idempotent", async () => {
		const store = createInMemoryVerdictStore({ isoNow: () => "2026-07-03T01:00:00.000Z" });
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
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		await store.claim("c1");
		await store.closeOutcome("c1", "match", []);

		expect(await store.claim("c1")).toBe("already_closed");
	});

	it("list returns stored records", async () => {
		const store = createInMemoryVerdictStore();
		await store.putDecided(decided("c1"));
		await store.putDecided(decided("c2"));

		expect(await store.list()).toHaveLength(2);
		expect(await store.list(1)).toHaveLength(1);
	});
});
