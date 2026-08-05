/**
 * Boundary validation for the judge's raw reply. These cases exist because the verdict store
 * reads judge_reason_codes back through a STRICT string[] guard (verdictStorePg parseJsonbArray):
 * anything this validator lets through is persisted, and a wrong-typed element makes the row
 * unreadable afterwards — getByCorrelationId and list() both throw, which would take confirm
 * and the metrics dashboard with them. The designed failure is rejection here, which degrades
 * the request to judge_unavailable. Found by external review (gpt-5.5), 2026-08-05.
 */
import { describe, expect, it } from "vitest";

import { validateLlmGuardOutput } from "./llmDecisionAdapter";

const VALID = {
	decision: "DENY",
	confidence: 0.8,
	reasonCodes: ["OFF_MANDATE_RECIPIENT"],
	rationale: "Recipient is not on the mandate.",
};

describe("validateLlmGuardOutput", () => {
	it("accepts a well-formed reply", () => {
		expect(validateLlmGuardOutput(VALID)).toEqual(VALID);
	});

	it("accepts an empty reasonCodes array (a judge may cite none)", () => {
		expect(validateLlmGuardOutput({ ...VALID, reasonCodes: [] })?.reasonCodes).toEqual([]);
	});

	it("rejects non-string reasonCodes elements (would persist an unreadable row)", () => {
		expect(validateLlmGuardOutput({ ...VALID, reasonCodes: [123] })).toBeUndefined();
		expect(validateLlmGuardOutput({ ...VALID, reasonCodes: ["OK", null] })).toBeUndefined();
		expect(validateLlmGuardOutput({ ...VALID, reasonCodes: [{ code: "X" }] })).toBeUndefined();
	});

	it("rejects reasonCodes that is not an array at all", () => {
		expect(validateLlmGuardOutput({ ...VALID, reasonCodes: { code: "X" } })).toBeUndefined();
		expect(validateLlmGuardOutput({ ...VALID, reasonCodes: "OFF_MANDATE" })).toBeUndefined();
	});

	it("rejects confidence outside 0..1 (persisted verbatim, read as a probability)", () => {
		expect(validateLlmGuardOutput({ ...VALID, confidence: 87 })).toBeUndefined();
		expect(validateLlmGuardOutput({ ...VALID, confidence: -0.1 })).toBeUndefined();
		expect(validateLlmGuardOutput({ ...VALID, confidence: Number.NaN })).toBeUndefined();
	});

	it("accepts the 0 and 1 boundaries", () => {
		expect(validateLlmGuardOutput({ ...VALID, confidence: 0 })?.confidence).toBe(0);
		expect(validateLlmGuardOutput({ ...VALID, confidence: 1 })?.confidence).toBe(1);
	});

	it("rejects an unknown decision, a non-string rationale, and non-objects", () => {
		expect(validateLlmGuardOutput({ ...VALID, decision: "MAYBE" })).toBeUndefined();
		expect(validateLlmGuardOutput({ ...VALID, rationale: 5 })).toBeUndefined();
		expect(validateLlmGuardOutput(null)).toBeUndefined();
		expect(validateLlmGuardOutput("DENY")).toBeUndefined();
	});
});
