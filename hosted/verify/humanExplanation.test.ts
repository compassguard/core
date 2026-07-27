import { describe, expect, it } from "vitest";

import {
	buildHumanExplanation,
	composeVerdictExplanation,
	mergeJudgeReasons,
} from "./humanExplanation";

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

describe("mergeJudgeReasons", () => {
	it("collapses an echoed deterministic code to a single occurrence", () => {
		const merged = mergeJudgeReasons(
			["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
			["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"],
		);
		expect(merged).toEqual(["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"]);
	});

	it("collapses a judge-internal duplicate", () => {
		const merged = mergeJudgeReasons(
			["TRANSFER_EXCEEDS_LIMIT"],
			["JUDGE_CODE", "JUDGE_CODE"],
		);
		expect(merged).toEqual(["TRANSFER_EXCEEDS_LIMIT", "JUDGE_CODE"]);
	});

	it("preserves deterministic order and appends judge additions in first-occurrence order", () => {
		const merged = mergeJudgeReasons(
			["A", "B"],
			["B", "C", "A", "D"],
		);
		expect(merged).toEqual(["A", "B", "C", "D"]);
	});

	it("returns the deterministic codes unchanged when the judge adds nothing new", () => {
		expect(mergeJudgeReasons(["A", "B"], [])).toEqual(["A", "B"]);
	});
});

describe("composeVerdictExplanation", () => {
	it("composes the decision-keyed sentence plus the rationale when the judge tightened with a rationale", () => {
		const explanation = composeVerdictExplanation("deny", ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"], {
			changedDecision: true,
			rationale: "Amount exceeds the mandate's approved ceiling.",
		});
		expect(explanation).toBe(
			"Denied by policy. Mandate judge: Amount exceeds the mandate's approved ceiling.",
		);
	});

	it("composes the decision-keyed sentence plus the fixed attribution when the judge tightened without a rationale", () => {
		const explanation = composeVerdictExplanation("review", ["TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT"], {
			changedDecision: true,
		});
		expect(explanation).toBe(
			"Needs human review before proceeding. Tightened by the mandate judge.",
		);
	});

	it("passes through to buildHumanExplanation when the judge kept the deterministic floor", () => {
		const reasons = ["TRANSFER_EXCEEDS_LIMIT", "BLOCKED_AUTHORITY_CHANGE"];
		const explanation = composeVerdictExplanation("deny", reasons, {
			changedDecision: false,
			rationale: "Kept the deterministic floor.",
		});
		expect(explanation).toBe(buildHumanExplanation("deny", reasons));
	});

	it("passes through to buildHumanExplanation when no judge ran", () => {
		const reasons = ["READ_ONLY_BY_POLICY"];
		expect(composeVerdictExplanation("allow", reasons)).toBe(
			buildHumanExplanation("allow", reasons),
		);
	});
});
