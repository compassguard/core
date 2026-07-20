import { describe, expect, it } from "vitest";

import { validateVerifyActionRequest } from "./verifyValidators";

describe("validateVerifyActionRequest — requestedAt (D11 / #12)", () => {
	it("accepts a provided valid ISO-8601 requestedAt and preserves it", () => {
		const result = validateVerifyActionRequest({
			toolName: "transfer_sol",
			requestedAt: "2026-07-07T00:00:00.000Z",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.requestedAt).toBe("2026-07-07T00:00:00.000Z");
	});

	it("rejects a provided non-ISO / unparseable requestedAt", () => {
		const result = validateVerifyActionRequest({
			toolName: "transfer_sol",
			requestedAt: "not-a-date",
		});

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.message).toBe("requestedAt must be an ISO-8601 timestamp.");
		}
	});

	it("rejects an empty-string requestedAt", () => {
		const result = validateVerifyActionRequest({
			toolName: "transfer_sol",
			requestedAt: "   ",
		});

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.message).toBe("requestedAt must be an ISO-8601 timestamp.");
		}
	});

	it("accepts an omitted requestedAt and leaves it undefined for server-stamping", () => {
		const result = validateVerifyActionRequest({ toolName: "transfer_sol" });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.requestedAt).toBeUndefined();
	});
});

describe("validateVerifyActionRequest — attribution (userId / sessionId)", () => {
	it("rejects a non-string userId instead of silently dropping it", () => {
		const result = validateVerifyActionRequest({
			toolName: "transfer_sol",
			userId: 12345,
		});

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.message).toBe("userId must be a non-empty string when provided.");
		}
	});

	it("rejects an empty-string sessionId instead of silently dropping it", () => {
		const result = validateVerifyActionRequest({
			toolName: "transfer_sol",
			sessionId: "   ",
		});

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.message).toBe(
				"sessionId must be a non-empty string when provided.",
			);
		}
	});

	it("accepts valid userId / sessionId and preserves them", () => {
		const result = validateVerifyActionRequest({
			toolName: "transfer_sol",
			userId: "user_1",
			sessionId: "sess_1",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.userId).toBe("user_1");
		expect(result.request.sessionId).toBe("sess_1");
	});

	it("accepts omitted attribution and leaves both undefined", () => {
		const result = validateVerifyActionRequest({ toolName: "transfer_sol" });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.userId).toBeUndefined();
		expect(result.request.sessionId).toBeUndefined();
	});
});

describe("validateVerifyActionRequest — intent.statedPurpose", () => {
	it("accepts intent.statedPurpose and carries it through", () => {
		const result = validateVerifyActionRequest({
			toolName: "transfer_sol",
			intent: { kind: "transfer", statedPurpose: "pay vendor Acme for invoice #42" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.request.intent).toEqual({
				kind: "transfer",
				statedPurpose: "pay vendor Acme for invoice #42",
			});
		}
	});

	it("rejects a malformed or oversized intent.statedPurpose", () => {
		expect(
			validateVerifyActionRequest({
				toolName: "transfer_sol",
				intent: { kind: "transfer", statedPurpose: "  " },
			}).ok,
		).toBe(false);
		expect(
			validateVerifyActionRequest({
				toolName: "transfer_sol",
				intent: { kind: "transfer", statedPurpose: 42 },
			}).ok,
		).toBe(false);
		expect(
			validateVerifyActionRequest({
				toolName: "transfer_sol",
				intent: { kind: "transfer", statedPurpose: "x".repeat(501) },
			}).ok,
		).toBe(false);
	});

	it("an intent without statedPurpose keeps the field absent", () => {
		const result = validateVerifyActionRequest({
			toolName: "transfer_sol",
			intent: { kind: "transfer" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.request.intent).toEqual({ kind: "transfer" });
		}
	});
});
