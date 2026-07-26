import { describe, expect, it } from "vitest";

import type { Mandate, MandateStore } from "@shared/mandateContracts";

/**
 * Behavioral contract of a MandateStore as a reusable suite (same pattern as
 * describeCredentialStoreContract): every backing — the in-memory reference and the durable
 * Postgres one — must satisfy it, so the durable swap is drop-in by construction.
 */
export type MakeMandateStore = () => Promise<MandateStore> | MandateStore;

function mandate(overrides: Partial<Mandate> = {}): Mandate {
	return {
		ownerId: "alice@example.com",
		mandateText: "Pay only invoices from approved vendors, never more than $200.",
		updatedAt: "2026-07-20T00:00:00.000Z",
		...overrides,
	};
}

export function describeMandateStoreContract(
	name: string,
	makeStore: MakeMandateStore,
): void {
	describe(name, () => {
		it("put then get round-trips every field", async () => {
			const store = await makeStore();
			await store.put(
				mandate({ allowedRecipients: ["VendorA111", "VendorB222"], maxAmountUsd: 200 }),
			);

			expect(await store.get("alice@example.com")).toEqual({
				ownerId: "alice@example.com",
				mandateText: "Pay only invoices from approved vendors, never more than $200.",
				allowedRecipients: ["VendorA111", "VendorB222"],
				maxAmountUsd: 200,
				updatedAt: "2026-07-20T00:00:00.000Z",
			});
		});

		it("get on an unknown ownerId returns undefined", async () => {
			const store = await makeStore();
			expect(await store.get("nobody@example.com")).toBeUndefined();
		});

		it("put is an upsert — the latest mandate for an ownerId wins", async () => {
			const store = await makeStore();
			await store.put(mandate());
			await store.put(
				mandate({
					mandateText: "Treasury ops only; nothing over $50.",
					updatedAt: "2026-07-20T01:00:00.000Z",
				}),
			);

			const stored = await store.get("alice@example.com");
			expect(stored?.mandateText).toBe("Treasury ops only; nothing over $50.");
			expect(stored?.updatedAt).toBe("2026-07-20T01:00:00.000Z");
		});

		it("omitted optional fields stay absent (and an upsert can clear them)", async () => {
			const store = await makeStore();
			await store.put(mandate({ allowedRecipients: ["VendorA111"], maxAmountUsd: 200 }));
			await store.put(mandate({ updatedAt: "2026-07-20T01:00:00.000Z" }));

			const stored = await store.get("alice@example.com");
			expect(stored?.allowedRecipients).toBeUndefined();
			expect(stored?.maxAmountUsd).toBeUndefined();
		});

		it("mandates for different owners are independent", async () => {
			const store = await makeStore();
			await store.put(mandate());
			await store.put(mandate({ ownerId: "bob@example.com", mandateText: "Bob's rules." }));

			expect((await store.get("alice@example.com"))?.mandateText).toMatch(/approved vendors/);
			expect((await store.get("bob@example.com"))?.mandateText).toBe("Bob's rules.");
		});
	});
}
