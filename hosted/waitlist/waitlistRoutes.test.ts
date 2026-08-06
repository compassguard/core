import { describe, expect, it } from "vitest";

import { createInMemoryWaitlistStore } from "./waitlistStore";

import { createWaitlistRoutes } from "./waitlistRoutes";
import { createWaitlistService } from "./waitlistService";

function createApp() {
	const service = createWaitlistService({
		waitlistStore: createInMemoryWaitlistStore(),
		isoNow: () => "2026-07-08T00:00:00.000Z",
	});
	return createWaitlistRoutes(service);
}

describe("createWaitlistRoutes", () => {
	it("returns 200 with { email } for a valid join", async () => {
		const response = await createApp().request("/waitlist", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "Alice@Example.com" }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ email: "alice@example.com" });
	});

	it("400s a missing email (empty object body)", async () => {
		const response = await createApp().request("/waitlist", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(400);
	});

	it("400s an invalid email shape", async () => {
		const response = await createApp().request("/waitlist", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "not-an-email" }),
		});

		expect(response.status).toBe(400);
	});

	it("400s a malformed JSON body", async () => {
		const response = await createApp().request("/waitlist", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{ not json",
		});

		expect(response.status).toBe(400);
	});
});
