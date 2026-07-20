import { describe, expect, it } from "vitest";

import { Hono } from "hono";

import type { HostedContextVariables } from "@shared/hostedAuthMiddlewareContracts";

import { createInMemoryMandateStore } from "./mandateStore";
import { createMandateRoutes } from "./mandateRoutes";

function appWith(email?: string) {
	const store = createInMemoryMandateStore();
	const app = new Hono<{ Variables: HostedContextVariables }>();
	// Stand-in for the /v1 auth middleware: sets the credential-derived identity.
	app.use("*", async (context, next) => {
		if (email !== undefined) context.set("authenticatedEmail", email);
		await next();
	});
	app.route(
		"/",
		createMandateRoutes({ mandateStore: store, isoNow: () => "2026-07-20T00:00:00.000Z" }),
	);
	return { app, store };
}

function post(app: Hono<{ Variables: HostedContextVariables }>, body: unknown) {
	return app.request("/mandate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createMandateRoutes", () => {
	it("POST /mandate registers under authenticatedEmail, preferred over body userId", async () => {
		const { app, store } = appWith("alice@example.com");
		const response = await post(app, { userId: "spoofed", mandateText: "Vendors only." });

		expect(response.status).toBe(200);
		expect((await store.get("alice@example.com"))?.mandateText).toBe("Vendors only.");
		expect(await store.get("spoofed")).toBeUndefined();
	});

	it("POST /mandate falls back to self-reported userId on the shared-key path", async () => {
		const { app, store } = appWith(undefined);
		const response = await post(app, { userId: "user-1", mandateText: "Vendors only." });

		expect(response.status).toBe(200);
		expect((await store.get("user-1"))?.mandateText).toBe("Vendors only.");
	});

	it("POST /mandate with no identity at all is a 400", async () => {
		const { app } = appWith(undefined);
		const response = await post(app, { mandateText: "Vendors only." });
		expect(response.status).toBe(400);
	});

	it("POST /mandate rejects an invalid body", async () => {
		const { app } = appWith("alice@example.com");
		const response = await post(app, { mandateText: "" });
		expect(response.status).toBe(400);
	});

	it("GET /mandate returns the registered mandate; 404 when none", async () => {
		const { app } = appWith("alice@example.com");
		await post(app, { mandateText: "Vendors only.", maxAmountUsd: 200 });

		const found = await app.request("/mandate");
		expect(found.status).toBe(200);
		expect(await found.json()).toEqual({
			ownerId: "alice@example.com",
			mandateText: "Vendors only.",
			maxAmountUsd: 200,
			updatedAt: "2026-07-20T00:00:00.000Z",
		});

		const { app: other } = appWith("bob@example.com");
		expect((await other.request("/mandate")).status).toBe(404);
	});

	it("GET /mandate resolves ?userId= on the shared-key path; 400 with no identity", async () => {
		const { app } = appWith(undefined);
		await post(app, { userId: "user-1", mandateText: "Vendors only." });

		expect((await app.request("/mandate?userId=user-1")).status).toBe(200);
		expect((await app.request("/mandate")).status).toBe(400);
	});
});
