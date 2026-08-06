import { describe, expect, it } from "vitest";

import { createWaitlistStoreFromEnv } from "./waitlistStoreFromEnv";

// Mirrors credentialStoreFromEnv.test.ts: only the no-env fallback is exercised in CI — the
// durable branch needs a live pooler and is discharged by a deploy-time smoke test, not the
// no-network suite. getEnv is injected explicitly so nothing reads real process env or opens
// a connection.
describe("createWaitlistStoreFromEnv", () => {
	it("falls back to a functional in-memory store when COMPASS_VERDICT_DB_URL is unset", async () => {
		const store = createWaitlistStoreFromEnv(() => undefined);

		await store.add({ email: "a@b.co", createdAt: "2026-07-08T00:00:00.000Z" });
		expect(await store.list()).toEqual([{ email: "a@b.co", createdAt: "2026-07-08T00:00:00.000Z" }]);
	});

	it("treats a blank/whitespace URL as unset (falls back to in-memory)", async () => {
		const store = createWaitlistStoreFromEnv(() => "   ");
		expect(await store.list()).toEqual([]);
	});

	it("throws an actionable error when COMPASS_VERDICT_DB_URL is malformed", () => {
		// A malformed URL makes postgres() throw synchronously; the shared factory must rethrow
		// with a message naming the env var rather than surfacing a bare driver TypeError.
		expect(() => createWaitlistStoreFromEnv(() => "not a valid url")).toThrow(
			/COMPASS_VERDICT_DB_URL is not a valid Postgres connection string/,
		);
	});
});
