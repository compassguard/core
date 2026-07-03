import type {
	ActualEffect,
	Discrepancy,
	IntendedEffect,
} from "@shared/verdictContracts";

export type CompareResult = {
	outcome: "match" | "mismatch";
	discrepancies: Discrepancy[];
};

/** Only the resolved (decoded) form of ActualEffect can be compared. */
type ResolvedActualEffect = Extract<ActualEffect, { unavailable: false }>;

/**
 * Native-unit tolerance for lamport amounts (fees/rounding). Amounts are compared
 * in native units (lamports / token base units) — no price oracle, no slippage noise.
 */
const DEFAULT_LAMPORT_TOLERANCE = 0;

export type CompareOptions = {
	lamportTolerance?: number;
};

/**
 * Deterministically compare the intended effect (what /verify recorded) against the
 * actual on-chain effect (what executed). Flags a diverged recipient, a diverged
 * amount beyond tolerance, and every instruction the executed tx added that the intent
 * did not imply. Empty discrepancies → match. Implements D21-v2.
 */
export function compareEffects(
	intended: IntendedEffect,
	actual: ResolvedActualEffect,
	options: CompareOptions = {},
): CompareResult {
	const lamportTolerance = options.lamportTolerance ?? DEFAULT_LAMPORT_TOLERANCE;
	const discrepancies: Discrepancy[] = [];

	if (
		intended.recipient !== undefined &&
		actual.recipient !== undefined &&
		intended.recipient !== actual.recipient
	) {
		discrepancies.push({
			field: "recipient",
			expected: intended.recipient,
			actual: actual.recipient,
		});
	}

	if (
		intended.lamports !== undefined &&
		actual.lamports !== undefined &&
		Math.abs(intended.lamports - actual.lamports) > lamportTolerance
	) {
		discrepancies.push({
			field: "amount",
			expected: String(intended.lamports),
			actual: String(actual.lamports),
		});
	}

	if (
		intended.tokenAmount !== undefined &&
		actual.tokenAmount !== undefined &&
		intended.tokenAmount !== actual.tokenAmount
	) {
		discrepancies.push({
			field: "amount",
			expected: intended.tokenAmount,
			actual: actual.tokenAmount,
		});
	}

	for (const instruction of actual.extraInstructions) {
		discrepancies.push({ field: "extra_instruction", actual: instruction });
	}

	return {
		outcome: discrepancies.length === 0 ? "match" : "mismatch",
		discrepancies,
	};
}
