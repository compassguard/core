import { describe, expect, it } from "vitest";

import type { WaitlistStore } from "./waitlistStore";

/**
 * The behavioral contract of a WaitlistStore, as a reusable suite. Every implementation —
 * the in-memory reference and the durable Postgres backing — must satisfy it, so the durable
 * swap is drop-in by construction. `makeStore` builds a FRESH, isolated store.
 */
export type MakeWaitlistStore = () => Promise<WaitlistStore> | WaitlistStore;

export function describeWaitlistStoreContract(name: string, makeStore: MakeWaitlistStore): void {
	describe(name, () => {
		it("add then list round-trips the entry", async () => {
			const store = await makeStore();
			await store.add({ email: "alice@example.com", createdAt: "2026-07-03T00:00:00.000Z" });

			expect(await store.list()).toEqual([
				{ email: "alice@example.com", createdAt: "2026-07-03T00:00:00.000Z" },
			]);
		});

		it("list on an empty store returns an empty array", async () => {
			const store = await makeStore();
			expect(await store.list()).toEqual([]);
		});

		it("normalizes the email at add (casing/whitespace is one identity)", async () => {
			const store = await makeStore();
			await store.add({ email: " User@X.com ", createdAt: "2026-07-03T00:00:00.000Z" });

			expect(await store.list()).toEqual([
				{ email: "user@x.com", createdAt: "2026-07-03T00:00:00.000Z" },
			]);
		});

		it("a repeat join for the same email is inert (first-write-wins)", async () => {
			const store = await makeStore();
			await store.add({ email: "alice@example.com", createdAt: "2026-07-03T00:00:00.000Z" });
			await store.add({ email: "Alice@Example.com", createdAt: "2026-07-03T01:00:00.000Z" });

			expect(await store.list()).toEqual([
				{ email: "alice@example.com", createdAt: "2026-07-03T00:00:00.000Z" },
			]);
		});

		it("list returns every distinct email ever joined", async () => {
			const store = await makeStore();
			await store.add({ email: "alice@example.com", createdAt: "2026-07-03T00:00:00.000Z" });
			await store.add({ email: "bob@example.com", createdAt: "2026-07-03T01:00:00.000Z" });

			const sorted = [...(await store.list())].sort((a, b) => a.email.localeCompare(b.email));
			expect(sorted).toEqual([
				{ email: "alice@example.com", createdAt: "2026-07-03T00:00:00.000Z" },
				{ email: "bob@example.com", createdAt: "2026-07-03T01:00:00.000Z" },
			]);
		});
	});
}
