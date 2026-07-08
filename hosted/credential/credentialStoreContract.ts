import { describe, expect, it } from "vitest";

import type {
	CredentialStore,
	CredentialStoreOptions,
} from "./credentialStore";

/**
 * The behavioral contract of a CredentialStore, as a reusable suite. Every implementation
 * — the in-memory reference and the durable Postgres backing — must satisfy it, so the
 * durable swap is drop-in by construction. `makeStore` builds a FRESH, isolated store
 * (optionally async, e.g. a per-test PGlite database) from injectable options so the
 * isoNow (revokedAt) assertions are deterministic without a real clock.
 */
export type MakeStore = (
	options?: CredentialStoreOptions,
) => Promise<CredentialStore> | CredentialStore;

export function describeCredentialStoreContract(name: string, makeStore: MakeStore): void {
	describe(name, () => {
		it("issue then resolveActive round-trips the email", async () => {
			const store = await makeStore();
			await store.issue({
				email: "alice@example.com",
				tokenHash: "hash-1",
				createdAt: "2026-07-03T00:00:00.000Z",
			});

			expect(await store.resolveActive("hash-1")).toEqual({ email: "alice@example.com" });
		});

		it("resolveActive on an unknown tokenHash returns undefined", async () => {
			const store = await makeStore();
			expect(await store.resolveActive("nope")).toBeUndefined();
		});

		it("revokeByEmail disables the credential so resolveActive returns undefined afterward", async () => {
			const store = await makeStore();
			await store.issue({
				email: "alice@example.com",
				tokenHash: "hash-1",
				createdAt: "2026-07-03T00:00:00.000Z",
			});

			await store.revokeByEmail("alice@example.com");
			expect(await store.resolveActive("hash-1")).toBeUndefined();
		});

		it("revokeByEmail returns the count of credentials disabled", async () => {
			const store = await makeStore();
			await store.issue({
				email: "alice@example.com",
				tokenHash: "hash-1",
				createdAt: "2026-07-03T00:00:00.000Z",
			});

			expect(await store.revokeByEmail("alice@example.com")).toBe(1);
			// Already revoked → a second revoke disables nothing more.
			expect(await store.revokeByEmail("alice@example.com")).toBe(0);
			// An email with no credentials disables nothing.
			expect(await store.revokeByEmail("nobody@example.com")).toBe(0);
		});

		it("re-issue of an existing tokenHash is inert (first-write-wins)", async () => {
			const store = await makeStore();
			await store.issue({
				email: "first@example.com",
				tokenHash: "hash-1",
				createdAt: "2026-07-03T00:00:00.000Z",
			});
			// Same tokenHash, different email — the first write wins, the replay is inert.
			await store.issue({
				email: "second@example.com",
				tokenHash: "hash-1",
				createdAt: "2026-07-03T01:00:00.000Z",
			});

			expect(await store.resolveActive("hash-1")).toEqual({ email: "first@example.com" });
		});

		it("normalizes the email at issue and revoke (casing/whitespace is one identity)", async () => {
			const store = await makeStore();
			await store.issue({
				email: "User@X.com",
				tokenHash: "hash-1",
				createdAt: "2026-07-03T00:00:00.000Z",
			});

			// Stored normalized: resolveActive returns the lowercased form.
			expect(await store.resolveActive("hash-1")).toEqual({ email: "user@x.com" });

			// revokeByEmail normalizes its argument, so the normalized identity is disabled.
			expect(await store.revokeByEmail("user@x.com")).toBe(1);
			expect(await store.resolveActive("hash-1")).toBeUndefined();
		});

		it("revokeByEmail disables every credential for one email in a single call", async () => {
			const store = await makeStore();
			await store.issue({
				email: "alice@example.com",
				tokenHash: "hash-1",
				createdAt: "2026-07-03T00:00:00.000Z",
			});
			await store.issue({
				email: "alice@example.com",
				tokenHash: "hash-2",
				createdAt: "2026-07-03T01:00:00.000Z",
			});
			await store.issue({
				email: "bob@example.com",
				tokenHash: "hash-3",
				createdAt: "2026-07-03T02:00:00.000Z",
			});

			// Both of alice's keys are disabled by one revoke; bob's is untouched.
			expect(await store.revokeByEmail("alice@example.com")).toBe(2);
			expect(await store.resolveActive("hash-1")).toBeUndefined();
			expect(await store.resolveActive("hash-2")).toBeUndefined();
			expect(await store.resolveActive("hash-3")).toEqual({ email: "bob@example.com" });
		});
	});
}
