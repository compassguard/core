import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { HostedContextVariables } from "@shared/hostedAuthMiddlewareContracts";

import { hashApiKey } from "../credential/apiKey";
import {
	createInMemoryCredentialStore,
	type CredentialStore,
} from "../credential/credentialStore";
import { hostedAuthMiddleware } from "./hostedAuthMiddleware";

const UNAUTHENTICATED_BODY = {
	error: {
		code: "UNAUTHENTICATED",
		message: "Missing or invalid hosted API credentials.",
	},
};

/** Seed an in-memory store with one credential: hashApiKey("cred-key") → user@example.com. */
async function seedCredentialStore(): Promise<CredentialStore> {
	const store = createInMemoryCredentialStore();
	await store.issue({
		email: "user@example.com",
		tokenHash: hashApiKey("cred-key"),
		createdAt: "2026-07-08T00:00:00.000Z",
	});
	return store;
}

function createApp(
	credentialStore: CredentialStore,
	captureException?: (error: unknown) => void,
) {
	const app = new Hono<{ Variables: HostedContextVariables }>();
	app.use(
		"*",
		hostedAuthMiddleware(
			{ apiKey: "hosted-secret" },
			credentialStore,
			captureException,
		),
	);
	app.get("/health", (context) => context.json({ ok: true }, 200));
	// Echo the credential-derived identity so tests can assert c.get is set/typed.
	app.get("/v1/protected", (context) =>
		context.json(
			{ ok: true, email: context.get("authenticatedEmail") ?? null },
			200,
		),
	);
	return app;
}

describe("hostedAuthMiddleware", () => {
	it("allows the shared key (fast path, no identity set)", async () => {
		const app = createApp(await seedCredentialStore());

		const response = await app.request("/v1/protected", {
			headers: { Authorization: "Bearer hosted-secret" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, email: null });
	});

	it("rejects requests without a bearer token", async () => {
		const app = createApp(await seedCredentialStore());

		const response = await app.request("/v1/protected");

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual(UNAUTHENTICATED_BODY);
	});

	it("rejects a token that is neither the shared key nor a credential", async () => {
		const app = createApp(await seedCredentialStore());

		const response = await app.request("/v1/protected", {
			headers: { Authorization: "Bearer not-a-known-token" },
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual(UNAUTHENTICATED_BODY);
	});

	it("resolves a valid email credential and exposes the identity downstream", async () => {
		const app = createApp(await seedCredentialStore());

		const response = await app.request("/v1/protected", {
			headers: { Authorization: "Bearer cred-key" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			email: "user@example.com",
		});
	});

	it("rejects a revoked credential (fail closed after revokeByEmail)", async () => {
		const store = await seedCredentialStore();
		await store.revokeByEmail("user@example.com");
		const app = createApp(store);

		const response = await app.request("/v1/protected", {
			headers: { Authorization: "Bearer cred-key" },
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual(UNAUTHENTICATED_BODY);
	});

	it("fails closed with 401 and captures the error when resolveActive throws", async () => {
		const resolveError = new Error("credential store unavailable");
		const throwingStore = {
			issue: async () => {},
			resolveActive: async () => {
				throw resolveError;
			},
			revokeByEmail: async () => 0,
		} satisfies CredentialStore;
		const captureException = vi.fn();
		const app = createApp(throwingStore, captureException);

		const response = await app.request("/v1/protected", {
			headers: { Authorization: "Bearer cred-key" },
		});

		// Fail CLOSED: still a 401 (F15) — telemetry is best-effort, never a bypass.
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual(UNAUTHENTICATED_BODY);
		// Best-effort capture (D7): called once with the thrown error, never the raw token.
		expect(captureException).toHaveBeenCalledTimes(1);
		expect(captureException).toHaveBeenCalledWith(resolveError);
	});

	it("skips auth for /health", async () => {
		const app = createApp(await seedCredentialStore());

		const response = await app.request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});
});
