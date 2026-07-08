import { describe, expect, it, vi } from "vitest";

import { createHostedApp } from "./app";
import type { HostedAppDependencies } from "./appContracts";
import type { EvaluateActionResponse } from "./evaluate/evaluationContracts";
import {
	createInMemoryVerdictStore,
	type VerdictStore,
} from "./verdict/verdictStore";
import {
	createInMemoryCredentialStore,
	type CredentialStore,
} from "./credential/credentialStore";

type InjectedStores = {
	verdictStore: VerdictStore;
	credentialStore: CredentialStore;
};

function createStores(): InjectedStores {
	return {
		verdictStore: createInMemoryVerdictStore(),
		credentialStore: createInMemoryCredentialStore(),
	};
}

// Inject explicit in-memory stores so app construction never falls through to the
// env-selected factories — tests stay hermetic even when COMPASS_VERDICT_DB_URL is exported.
function createDependencies(
	stores: InjectedStores = createStores(),
): HostedAppDependencies {
	return {
		auth: { apiKey: "hosted-secret" },
		health: {
			dependencies: {
				auditStore: "ok",
				policy: "ok",
				llm: "ok",
			},
		},
		evaluations: {
			evaluateAction: vi.fn().mockResolvedValue({
				correlationId: "corr_route_1",
				decision: "review",
				riskLevel: "medium",
				reasons: ["TRANSFER_UNKNOWN_RECIPIENT"],
				suggestedAction: "Request explicit user confirmation before execution.",
				auditRef: "aud_route_1",
			} satisfies EvaluateActionResponse),
		},
		verdictStore: stores.verdictStore,
		credentialStore: stores.credentialStore,
	};
}

describe("createHostedApp", () => {
	it("returns hosted health status without auth", async () => {
		const app = createHostedApp(createDependencies());

		const response = await app.request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			service: "compass-hosted-guard",
			dependencies: {
				auditStore: "ok",
				policy: "ok",
				llm: "ok",
			},
		});
	});

	it("returns hosted evaluation decisions for authenticated requests", async () => {
		const deps = createDependencies();
		const app = createHostedApp(deps);

		const response = await app.request("/v1/evaluate", {
			method: "POST",
			headers: {
				Authorization: "Bearer hosted-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				correlationId: "corr_route_1",
				idempotencyKey: "idem_route_1",
				toolName: "transfer_sol",
				arguments: { recipient: "wallet", amountUsd: 10 },
				localFindings: [
					{
						code: "ROUTABLE_MUTATION",
						severity: "warn",
						message: "Needs hosted evaluation.",
					},
				],
				requestedAt: "2026-06-17T12:00:00.000Z",
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			decision: "review",
			auditRef: "aud_route_1",
		});
	});

	it("rejects evaluate requests without auth", async () => {
		const app = createHostedApp(createDependencies());

		const response = await app.request("/v1/evaluate", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: {
				code: "UNAUTHENTICATED",
				message: "Missing or invalid hosted API credentials.",
			},
		});
	});

	it("writes and lists audit entries through hosted routes", async () => {
		const app = createHostedApp(createDependencies());

		const writeResponse = await app.request("/v1/audit/events", {
			method: "POST",
			headers: {
				Authorization: "Bearer hosted-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				idempotencyKey: "idem_audit_1",
				userId: "user_1",
				sessionId: "session_1",
				entry: {
					correlationId: "corr_audit_1",
					auditRef: "aud_audit_1",
					toolName: "transfer_sol",
					decision: "review",
					riskLevel: "medium",
					reasons: ["TRANSFER_UNKNOWN_RECIPIENT"],
					occurredAt: "2026-06-17T12:00:01.000Z",
				},
			}),
		});

		expect(writeResponse.status).toBe(200);
		expect(await writeResponse.json()).toMatchObject({
			auditRef: "aud_audit_1",
			created: true,
		});

		const listResponse = await app.request("/v1/audits?userId=user_1", {
			headers: {
				Authorization: "Bearer hosted-secret",
			},
		});

		expect(listResponse.status).toBe(200);
		expect(await listResponse.json()).toEqual({
			audits: [
				{
					correlationId: "corr_audit_1",
					auditRef: "aud_audit_1",
					toolName: "transfer_sol",
					decision: "review",
					riskLevel: "medium",
					reasons: ["TRANSFER_UNKNOWN_RECIPIENT"],
					occurredAt: "2026-06-17T12:00:01.000Z",
				},
			],
		});
	});

	it("returns the active policy snapshot", async () => {
		const app = createHostedApp(createDependencies());

		const response = await app.request("/v1/policies", {
			headers: {
				Authorization: "Bearer hosted-secret",
			},
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			version: expect.any(String),
			updatedAt: expect.any(String),
			rules: expect.objectContaining({
				transfers: expect.any(Object),
				swaps: expect.any(Object),
			}),
		});
	});

	it("returns a deterministic verdict through POST /v1/verify", async () => {
		const app = createHostedApp(createDependencies());

		const response = await app.request("/v1/verify", {
			method: "POST",
			headers: {
				Authorization: "Bearer hosted-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				toolName: "transfer_sol",
				intent: { kind: "transfer" },
				arguments: { recipient: "Stranger", amountUsd: 999 },
			}),
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			decision: "review",
			correlationId: expect.any(String),
			humanExplanation: expect.any(String),
		});
	});

	it("rejects a /v1/verify request without auth", async () => {
		const app = createHostedApp(createDependencies());

		const response = await app.request("/v1/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ toolName: "transfer_sol" }),
		});

		expect(response.status).toBe(401);
	});

	it("400s a malformed /v1/verify body", async () => {
		const app = createHostedApp(createDependencies());

		const response = await app.request("/v1/verify", {
			method: "POST",
			headers: {
				Authorization: "Bearer hosted-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ intent: { kind: "transfer" } }), // missing toolName
		});

		expect(response.status).toBe(400);
	});

	it("returns unknown_correlation from /v1/verify/confirm for an unseen id", async () => {
		const app = createHostedApp(createDependencies());

		const response = await app.request("/v1/verify/confirm", {
			method: "POST",
			headers: {
				Authorization: "Bearer hosted-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ correlationId: "never-seen", txSignature: "sig123" }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			outcome: "unknown_correlation",
			discrepancies: [],
		});
	});

	it("400s a /v1/verify/confirm body missing txSignature", async () => {
		const app = createHostedApp(createDependencies());

		const response = await app.request("/v1/verify/confirm", {
			method: "POST",
			headers: {
				Authorization: "Bearer hosted-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ correlationId: "c1" }),
		});

		expect(response.status).toBe(400);
	});

	it("throws on inconsistent partial injection of only one verify service (#15)", () => {
		const partial = {
			...createDependencies(),
			verifications: { verifyAction: vi.fn() },
		} as HostedAppDependencies;

		expect(() => createHostedApp(partial)).toThrow(/share a single verdict store/);
	});
});

describe("createHostedApp — per-email credential flow (end-to-end)", () => {
	const SIGNUP_EMAIL = "e2e@example.com";

	async function signup(
		app: ReturnType<typeof createHostedApp>,
	): Promise<{ email: string; apiKey: string }> {
		const response = await app.request("/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: SIGNUP_EMAIL }),
		});
		expect(response.status).toBe(200);
		return (await response.json()) as { email: string; apiKey: string };
	}

	function verifyBody(): string {
		return JSON.stringify({
			toolName: "transfer_sol",
			intent: { kind: "transfer" },
			arguments: { recipient: "Stranger", amountUsd: 999 },
		});
	}

	it("mints a credential via public POST /signup (no auth)", async () => {
		const app = createHostedApp(createDependencies());

		const body = await signup(app);

		expect(body.email).toBe(SIGNUP_EMAIL);
		expect(typeof body.apiKey).toBe("string");
		expect(body.apiKey.length).toBeGreaterThan(0);
	});

	it("authenticates /v1/verify with a signup key and attributes the verdict to the email", async () => {
		const stores = createStores();
		const app = createHostedApp(createDependencies(stores));

		const { apiKey } = await signup(app);

		const response = await app.request("/v1/verify", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: verifyBody(),
		});

		expect(response.status).toBe(200);
		const verified = (await response.json()) as { correlationId: string };
		const record = await stores.verdictStore.getByCorrelationId(
			verified.correlationId,
		);
		expect(record?.authenticatedEmail).toBe(SIGNUP_EMAIL);
	});

	it("rejects /v1/verify with no Authorization header", async () => {
		const app = createHostedApp(createDependencies());

		const response = await app.request("/v1/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: verifyBody(),
		});

		expect(response.status).toBe(401);
	});

	it("rejects a revoked credential reusing the same key", async () => {
		const stores = createStores();
		const app = createHostedApp(createDependencies(stores));

		const { apiKey } = await signup(app);
		await stores.credentialStore.revokeByEmail(SIGNUP_EMAIL);

		const response = await app.request("/v1/verify", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: verifyBody(),
		});

		expect(response.status).toBe(401);
	});
});
