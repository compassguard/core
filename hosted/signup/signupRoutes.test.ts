import { describe, expect, it } from "vitest";

import { createInMemoryCredentialStore } from "../credential/credentialStore";

import { createSignupRoutes } from "./signupRoutes";
import { createSignupService } from "./signupService";

function createApp() {
	const service = createSignupService({
		credentialStore: createInMemoryCredentialStore(),
		generateKey: () => "raw-key-123",
		hashKey: (raw) => `hash(${raw})`,
	});
	return createSignupRoutes(service);
}

describe("createSignupRoutes", () => {
	it("returns 200 with { email, apiKey } for a valid signup", async () => {
		const response = await createApp().request("/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "Alice@Example.com" }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			email: "alice@example.com",
			apiKey: "raw-key-123",
		});
	});

	it("400s a missing email (empty object body)", async () => {
		const response = await createApp().request("/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(400);
	});

	it("400s an invalid email shape", async () => {
		const response = await createApp().request("/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "not-an-email" }),
		});

		expect(response.status).toBe(400);
	});

	it("400s a malformed JSON body", async () => {
		const response = await createApp().request("/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{ not json",
		});

		expect(response.status).toBe(400);
	});
});
