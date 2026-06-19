import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpHostedClient } from "./mcpHostedClient";

describe("mcpHostedClient", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("posts evaluation requests with auth and idempotency headers", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				correlationId: "corr_success",
				decision: "allow",
				riskLevel: "low",
				reasons: ["ROUTER_SKIP_ALLOW"],
				auditRef: "aud_success",
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const client = createMcpHostedClient({
			url: "https://hosted.example.com",
			apiKey: "top-secret",
			timeoutMs: 750,
		});

		const response = await client.evaluateAction({
			correlationId: "corr_success",
			idempotencyKey: "idem_success",
			toolName: "transfer_sol",
			arguments: { amountSol: 1 },
			localFindings: [],
			requestedAt: "2026-06-18T00:00:00.000Z",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://hosted.example.com/v1/evaluate",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer top-secret",
					"Content-Type": "application/json",
					"Idempotency-Key": "idem_success",
				}),
			}),
		);
		expect(response).toEqual({
			correlationId: "corr_success",
			decision: "allow",
			riskLevel: "low",
			reasons: ["ROUTER_SKIP_ALLOW"],
			auditRef: "aud_success",
		});
	});

	it("fails closed when the hosted request times out", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(
			(_input: unknown, init?: { signal?: AbortSignal }) =>
				new Promise((_, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const client = createMcpHostedClient({
			url: "https://hosted.example.com/",
			apiKey: "top-secret",
			timeoutMs: 25,
		});

		const responsePromise = client.evaluateAction({
			correlationId: "corr_timeout",
			idempotencyKey: "idem_timeout",
			toolName: "transfer_sol",
			arguments: { amountSol: 1 },
			localFindings: [],
			requestedAt: "2026-06-18T00:00:00.000Z",
		});

		await vi.advanceTimersByTimeAsync(30);

		await expect(responsePromise).resolves.toMatchObject({
			correlationId: "corr_timeout",
			decision: "deny",
			riskLevel: "high",
			reasons: ["HOSTED_TIMEOUT"],
			auditRef: "local_fail_closed_corr_timeout",
		});
	});

	it("fails closed when hosted credentials are rejected", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
			}),
		);

		const client = createMcpHostedClient({
			url: "https://hosted.example.com",
			apiKey: "top-secret",
			timeoutMs: 750,
		});

		await expect(
			client.evaluateAction({
				correlationId: "corr_unauthorized",
				idempotencyKey: "idem_unauthorized",
				toolName: "transfer_sol",
				arguments: { amountSol: 1 },
				localFindings: [],
				requestedAt: "2026-06-18T00:00:00.000Z",
			}),
		).resolves.toMatchObject({
			decision: "deny",
			reasons: ["HOSTED_UNAUTHORIZED"],
		});
	});

	it("fails closed when hosted JSON parsing fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => {
					throw new SyntaxError("Unexpected token < in JSON");
				},
			}),
		);

		const client = createMcpHostedClient({
			url: "https://hosted.example.com",
			apiKey: "top-secret",
			timeoutMs: 750,
		});

		await expect(
			client.evaluateAction({
				correlationId: "corr_invalid_json",
				idempotencyKey: "idem_invalid_json",
				toolName: "transfer_sol",
				arguments: { amountSol: 1 },
				localFindings: [],
				requestedAt: "2026-06-18T00:00:00.000Z",
			}),
		).resolves.toMatchObject({
			decision: "deny",
			reasons: ["HOSTED_INVALID_JSON"],
		});
	});

	it("fails closed when the hosted response is missing auditRef", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					correlationId: "corr_bad",
					decision: "allow",
					riskLevel: "low",
					reasons: ["READ_ONLY_BY_POLICY"],
				}),
			}),
		);

		const client = createMcpHostedClient({
			url: "https://hosted.example.com",
			apiKey: "top-secret",
			timeoutMs: 750,
		});

		await expect(
			client.evaluateAction({
				correlationId: "corr_bad",
				idempotencyKey: "idem_bad",
				toolName: "transfer_sol",
				arguments: { amountSol: 1 },
				localFindings: [],
				requestedAt: "2026-06-18T00:00:00.000Z",
			}),
		).resolves.toMatchObject({
			decision: "deny",
			reasons: ["HOSTED_MALFORMED_RESPONSE"],
		});
	});

	it("fails closed on network errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("socket hang up")),
		);

		const client = createMcpHostedClient({
			url: "https://hosted.example.com",
			apiKey: "top-secret",
			timeoutMs: 750,
		});

		await expect(
			client.evaluateAction({
				correlationId: "corr_network_error",
				idempotencyKey: "idem_network_error",
				toolName: "transfer_sol",
				arguments: { amountSol: 1 },
				localFindings: [],
				requestedAt: "2026-06-18T00:00:00.000Z",
			}),
		).resolves.toMatchObject({
			decision: "deny",
			reasons: ["HOSTED_NETWORK_ERROR"],
		});
	});
});
