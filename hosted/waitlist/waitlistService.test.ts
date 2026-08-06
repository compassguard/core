import { describe, expect, it } from "vitest";

import { createInMemoryWaitlistStore } from "./waitlistStore";

import { createWaitlistService } from "./waitlistService";

describe("createWaitlistService", () => {
	it("joins the waitlist and echoes the normalized email", async () => {
		const store = createInMemoryWaitlistStore();
		const service = createWaitlistService({
			waitlistStore: store,
			isoNow: () => "2026-07-08T00:00:00.000Z",
		});

		const response = await service.join({ email: "Alice@Example.com" });

		expect(response).toEqual({ email: "alice@example.com" });
		expect(await store.list()).toEqual([
			{ email: "alice@example.com", createdAt: "2026-07-08T00:00:00.000Z" },
		]);
	});

	it("mints no credential — the response has only email, never an apiKey", async () => {
		const service = createWaitlistService({ waitlistStore: createInMemoryWaitlistStore() });
		const response = await service.join({ email: "b@example.com" });

		expect(response).toEqual({ email: "b@example.com" });
		expect(Object.keys(response)).toEqual(["email"]);
	});

	it("a repeat join for the same email does not overwrite the original createdAt", async () => {
		const store = createInMemoryWaitlistStore();
		let now = "2026-07-08T00:00:00.000Z";
		const service = createWaitlistService({ waitlistStore: store, isoNow: () => now });

		await service.join({ email: "alice@example.com" });
		now = "2026-07-09T00:00:00.000Z";
		await service.join({ email: "alice@example.com" });

		expect(await store.list()).toEqual([
			{ email: "alice@example.com", createdAt: "2026-07-08T00:00:00.000Z" },
		]);
	});
});
