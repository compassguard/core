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
