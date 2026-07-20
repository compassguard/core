import { describe, expect, it } from "vitest";

import { createMandateStoreFromEnv } from "./mandateStoreFromEnv";

describe("createMandateStoreFromEnv", () => {
	it("falls back to a working in-memory store when no DB url is configured", async () => {
		const store = createMandateStoreFromEnv(() => undefined);
		await store.put({
			ownerId: "alice@example.com",
			mandateText: "Test mandate.",
			updatedAt: "2026-07-20T00:00:00.000Z",
		});
		expect((await store.get("alice@example.com"))?.mandateText).toBe("Test mandate.");
	});
});
