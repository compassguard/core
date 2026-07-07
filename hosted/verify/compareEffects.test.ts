import { describe, expect, it } from "vitest";

import type { IntendedEffect } from "@shared/verdictContracts";
import { compareEffects } from "./compareEffects";
import { deriveActualEffectUnavailable } from "./deriveActualEffect.unavailable";

const INTENDED: IntendedEffect = {
	actionKind: "transfer",
	recipient: "RcpT111",
	lamports: 25_000_000,
};

const SPL_INTENDED: IntendedEffect = {
	actionKind: "transfer",
	recipient: "RcpT111",
	tokenAmount: "1000",
	mint: "MintAAA",
};

describe("compareEffects", () => {
	it("matches when every declared dimension agrees and no extra instructions", () => {
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

	it("flags a diverged tokenAmount", () => {
		const result = compareEffects(SPL_INTENDED, {
			unavailable: false,
			recipient: "RcpT111",
			tokenAmount: "9999",
			mint: "MintAAA",
			extraInstructions: [],
		});
		expect(result.outcome).toBe("mismatch");
		expect(result.discrepancies).toEqual([
			{ field: "amount", expected: "1000", actual: "9999" },
		]);
	});

	it("flags a diverged mint (same recipient, same base-unit amount, different mint)", () => {
		const result = compareEffects(SPL_INTENDED, {
			unavailable: false,
			recipient: "RcpT111",
			tokenAmount: "1000",
			mint: "MintBBB",
			extraInstructions: [],
		});
		expect(result.outcome).toBe("mismatch");
		expect(result.discrepancies).toEqual([
			{ field: "mint", expected: "MintAAA", actual: "MintBBB" },
		]);
	});

	it("fails closed when the intent declares lamports the actual effect cannot confirm", () => {
		const result = compareEffects(INTENDED, {
			unavailable: false,
			recipient: "RcpT111",
			// lamports undefined: the decoder could not affirmatively confirm the amount
			extraInstructions: [],
		});
		expect(result.outcome).toBe("mismatch");
		expect(result.discrepancies).toHaveLength(1);
		expect(result.discrepancies[0]).toMatchObject({
			field: "amount",
			expected: "25000000",
		});
		expect(result.discrepancies[0]?.actual).toBeUndefined();
	});

	it("fails closed on an undeclared-but-executed amount (the over-amount-to-approved-recipient exploit)", () => {
		const intendedNoAmount: IntendedEffect = {
			actionKind: "transfer",
			recipient: "RcpT111",
			// lamports undefined: the intent never declared an amount
		};
		const result = compareEffects(intendedNoAmount, {
			unavailable: false,
			recipient: "RcpT111",
			lamports: 90_000_000,
			extraInstructions: [],
		});
		expect(result.outcome).toBe("mismatch");
		expect(result.discrepancies).toHaveLength(1);
		expect(result.discrepancies[0]).toMatchObject({
			field: "amount",
			actual: "90000000",
		});
		expect(result.discrepancies[0]?.expected).toBeUndefined();
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

	it("does not flag a dimension left undefined on both sides", () => {
		// INTENDED declares no mint/tokenAmount; the actual effect confirms none either.
		const result = compareEffects(INTENDED, {
			unavailable: false,
			recipient: "RcpT111",
			lamports: 25_000_000,
			extraInstructions: [],
		});
		expect(result.outcome).toBe("match");
		expect(
			result.discrepancies.some((d) => d.field === "mint" || d.field === "amount"),
		).toBe(false);
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
