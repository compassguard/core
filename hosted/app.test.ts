import { describe, expect, it, vi } from "vitest";

import { createHostedApp } from "./app";
import type { HostedAppDependencies } from "./appContracts";
import type { EvaluateActionResponse } from "./evaluate/evaluationContracts";

function createDependencies(): HostedAppDependencies {
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
				decision: "confirm",
				riskLevel: "medium",
				reasons: ["TRANSFER_UNKNOWN_RECIPIENT"],
				suggestedAction: "Request explicit user confirmation before execution.",
				auditRef: "aud_route_1",
			} satisfies EvaluateActionResponse),
		},
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
			decision: "confirm",
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
					decision: "confirm",
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
					decision: "confirm",
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
});
