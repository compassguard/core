import { describe, expect, it } from "vitest";

import type { IntendedEffect } from "@shared/verdictContracts";
import { compareEffects } from "./compareEffects";
import { deriveActualEffectUnavailable } from "./deriveActualEffect.unavailable";

const INTENDED: IntendedEffect = {
	actionKind: "transfer",
	recipient: "RcpT111",
	lamports: 25_000_000,
};

describe("compareEffects", () => {
	it("matches when recipient + amount agree and no extra instructions", () => {
		const result = compareEffects(INTENDED, {
			unavailable: false,
			recipient: "RcpT111",
			lamports: 25_000_000,
			extraInstructions: [],
		});
		expect(result.outcome).toBe("match");
		expect(result.discrepancies).toHaveLength(0);
	});

	it("flags a diverged recipient", () => {
		const result = compareEffects(INTENDED, {
			unavailable: false,
			recipient: "EvilAddr",
			lamports: 25_000_000,
			extraInstructions: [],
		});
		expect(result.outcome).toBe("mismatch");
		expect(result.discrepancies[0]).toMatchObject({
			field: "recipient",
			expected: "RcpT111",
			actual: "EvilAddr",
		});
	});

	it("flags a diverged amount", () => {
		const result = compareEffects(INTENDED, {
			unavailable: false,
			recipient: "RcpT111",
			lamports: 90_000_000,
			extraInstructions: [],
		});
		expect(result.outcome).toBe("mismatch");
		expect(result.discrepancies).toEqual([
			{ field: "amount", expected: "25000000", actual: "90000000" },
		]);
	});

	it("flags every extra instruction (the caught-mismatch beat)", () => {
		const result = compareEffects(INTENDED, {
			unavailable: false,
			recipient: "RcpT111",
			lamports: 25_000_000,
			extraInstructions: ["SetAuthority", "Approve"],
		});
		expect(result.outcome).toBe("mismatch");
		expect(result.discrepancies).toEqual([
			{ field: "extra_instruction", actual: "SetAuthority" },
			{ field: "extra_instruction", actual: "Approve" },
		]);
	});

	it("respects an injected lamport tolerance", () => {
		const result = compareEffects(
			INTENDED,
			{
				unavailable: false,
				recipient: "RcpT111",
				lamports: 25_000_005,
				extraInstructions: [],
			},
			{ lamportTolerance: 10 },
		);
		expect(result.outcome).toBe("match");
	});
});

describe("deriveActualEffectUnavailable", () => {
	it("always returns the unavailable sentinel, never a fake match", () => {
		const effect = deriveActualEffectUnavailable(
			{} as never,
			INTENDED,
		);
		expect(effect).toEqual({ unavailable: true });
	});
});
