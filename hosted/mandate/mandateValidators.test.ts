import { describe, expect, it } from "vitest";

import { MANDATE_TEXT_MAX_LENGTH } from "@shared/mandateContracts";

import { validateMandatePutRequest } from "./mandateValidators";

describe("validateMandatePutRequest", () => {
	it("accepts a minimal valid body", () => {
		const result = validateMandatePutRequest({ mandateText: "Vendors only." });
		expect(result).toEqual({
			ok: true,
			request: {
				userId: undefined,
				mandateText: "Vendors only.",
				allowedRecipients: undefined,
				maxAmountUsd: undefined,
			},
		});
	});

	it("accepts optional fields when well-formed", () => {
		const result = validateMandatePutRequest({
			userId: "user-1",
			mandateText: "Vendors only.",
			allowedRecipients: ["VendorA111"],
			maxAmountUsd: 200,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a non-object body, a missing/empty/oversized mandateText", () => {
		expect(validateMandatePutRequest(undefined).ok).toBe(false);
		expect(validateMandatePutRequest({}).ok).toBe(false);
		expect(validateMandatePutRequest({ mandateText: "  " }).ok).toBe(false);
		expect(
			validateMandatePutRequest({ mandateText: "x".repeat(MANDATE_TEXT_MAX_LENGTH + 1) }).ok,
		).toBe(false);
	});

	it("rejects malformed optional fields instead of silently dropping them", () => {
		expect(validateMandatePutRequest({ mandateText: "ok", userId: 7 }).ok).toBe(false);
		expect(
			validateMandatePutRequest({ mandateText: "ok", allowedRecipients: ["a", ""] }).ok,
		).toBe(false);
		expect(
			validateMandatePutRequest({ mandateText: "ok", allowedRecipients: "VendorA111" }).ok,
		).toBe(false);
		expect(validateMandatePutRequest({ mandateText: "ok", maxAmountUsd: -5 }).ok).toBe(false);
		expect(validateMandatePutRequest({ mandateText: "ok", maxAmountUsd: "200" }).ok).toBe(
			false,
		);
	});

	it("rejects an oversized allowedRecipients list", () => {
		const result = validateMandatePutRequest({
			mandateText: "ok",
			allowedRecipients: Array.from({ length: 51 }, (_, i) => `R${i}`),
		});
		expect(result.ok).toBe(false);
	});
});
