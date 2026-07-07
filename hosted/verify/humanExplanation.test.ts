import { describe, expect, it } from "vitest";

import { buildHumanExplanation } from "./humanExplanation";

describe("buildHumanExplanation", () => {
	it("renders distinct sentences for known reason codes", () => {
		const cap = buildHumanExplanation("review", ["TRANSFER_EXCEEDS_LIMIT"]);
		const authority = buildHumanExplanation("deny", ["BLOCKED_AUTHORITY_CHANGE"]);
		const recipient = buildHumanExplanation("review", ["TRANSFER_UNKNOWN_RECIPIENT"]);
		const unknownTool = buildHumanExplanation("deny", ["UNKNOWN_MUTATING_TOOL_DENIED"]);
		const readOnly = buildHumanExplanation("allow", ["READ_ONLY_BY_POLICY"]);

		const all = [cap, authority, recipient, unknownTool, readOnly];
		expect(new Set(all).size).toBe(all.length); // all distinct
		expect(cap).toMatch(/cap/i);
		expect(authority).toMatch(/authority/i);
	});

	it("joins multiple recognized codes", () => {
		const explanation = buildHumanExplanation("deny", [
			"TRANSFER_EXCEEDS_LIMIT",
			"BLOCKED_AUTHORITY_CHANGE",
		]);
		expect(explanation).toMatch(/cap/i);
		expect(explanation).toMatch(/authority/i);
	});

	it("falls back to a decision-keyed sentence for unknown codes", () => {
		expect(buildHumanExplanation("deny", ["SOME_FUTURE_CODE"])).toBe(
			"Denied by policy.",
		);
		expect(buildHumanExplanation("allow", [])).toBe("Allowed by policy.");
		expect(buildHumanExplanation("review", ["NOPE"])).toBe(
			"Needs human review before proceeding.",
		);
	});
});
