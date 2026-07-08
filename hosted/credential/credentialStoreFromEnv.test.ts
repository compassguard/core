import { describe, expect, it } from "vitest";

import { createCredentialStoreFromEnv } from "./credentialStoreFromEnv";

// Mirrors verdictStoreFromEnv.test.ts: only the no-env fallback is exercised in CI — the durable
// branch needs a live pooler and is discharged by a deploy-time smoke test, not the no-network
// suite. getEnv is injected explicitly so nothing reads real process env or opens a connection.
describe("createCredentialStoreFromEnv", () => {
	it("falls back to a functional in-memory store when COMPASS_VERDICT_DB_URL is unset", async () => {
		const store = createCredentialStoreFromEnv(() => undefined);

		await store.issue({
			email: "a@b.co",
			tokenHash: "hash-1",
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		expect(await store.resolveActive("hash-1")).toEqual({ email: "a@b.co" });
	});

	it("treats a blank/whitespace URL as unset (falls back to in-memory)", async () => {
		const store = createCredentialStoreFromEnv(() => "   ");
		expect(await store.resolveActive("nope")).toBeUndefined();
	});

	it("throws an actionable error when COMPASS_VERDICT_DB_URL is malformed", () => {
		// A malformed URL makes postgres() throw synchronously; the shared factory must rethrow
		// with a message naming the env var rather than surfacing a bare driver TypeError.
		expect(() => createCredentialStoreFromEnv(() => "not a valid url")).toThrow(
			/COMPASS_VERDICT_DB_URL is not a valid Postgres connection string/,
		);
	});
});
