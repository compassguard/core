import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { hostedAuthMiddleware } from "./hostedAuthMiddleware";

function createApp() {
	const app = new Hono();
	app.use("*", hostedAuthMiddleware({ apiKey: "hosted-secret" }));
	app.get("/health", (context) => context.json({ ok: true }, 200));
	app.get("/v1/protected", (context) => context.json({ ok: true }, 200));
	return app;
}

describe("hostedAuthMiddleware", () => {
	it("allows requests with a valid bearer token", async () => {
		const response = await createApp().request("/v1/protected", {
			headers: {
				Authorization: "Bearer hosted-secret",
			},
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("rejects requests without a bearer token", async () => {
		const response = await createApp().request("/v1/protected");

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: {
				code: "UNAUTHENTICATED",
				message: "Missing or invalid hosted API credentials.",
			},
		});
	});

	it("rejects requests with an invalid bearer token", async () => {
		const response = await createApp().request("/v1/protected", {
			headers: {
				Authorization: "Bearer wrong-secret",
			},
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: {
				code: "UNAUTHENTICATED",
				message: "Missing or invalid hosted API credentials.",
			},
		});
	});

	it("skips auth for /health", async () => {
		const response = await createApp().request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});
});
