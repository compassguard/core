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
 * Fail-closed per-dimension comparison. For a single value dimension, a dimension the
 * intent declares but the actual effect cannot affirmatively confirm — or an actual
 * dimension the intent never declared — is a discrepancy, never a silent match:
 * - both defined & equal → no discrepancy.
 * - both defined & differ (per the injected `differ` test) → a discrepancy.
 * - intended defined, actual undefined (declared but unconfirmable) → a discrepancy
 *   (expected = the intended value, actual undefined).
 * - intended undefined, actual defined (undeclared but executed) → a discrepancy
 *   (expected undefined, actual = the actual value).
 * - both undefined → no discrepancy.
 */
function compareDimension<T extends string | number>(
	field: Discrepancy["field"],
	intended: T | undefined,
	actual: T | undefined,
	differ: (intended: T, actual: T) => boolean,
): Discrepancy | undefined {
	if (intended !== undefined && actual !== undefined) {
		return differ(intended, actual)
			? { field, expected: String(intended), actual: String(actual) }
			: undefined;
	}
	if (intended !== undefined) {
		return { field, expected: String(intended), actual: undefined };
	}
	if (actual !== undefined) {
		return { field, expected: undefined, actual: String(actual) };
	}
	return undefined;
}

/**
 * Deterministically compare the intended effect (what /verify recorded) against the
 * actual on-chain effect (what executed). Fail-closed: for each value dimension
 * (recipient, lamports, tokenAmount, mint), a dimension the intent declares but the
 * actual effect cannot affirmatively confirm — or an actual dimension the intent never
 * declared — is a discrepancy, never a silent match. Flags a diverged recipient, a
 * diverged amount beyond tolerance, a diverged mint, and every instruction the executed
 * tx added that the intent did not imply. Empty discrepancies → match. Implements
 * D2-v2 / D3-v2.
 */
export function compareEffects(
	intended: IntendedEffect,
	actual: ResolvedActualEffect,
	options: CompareOptions = {},
): CompareResult {
	const lamportTolerance = options.lamportTolerance ?? DEFAULT_LAMPORT_TOLERANCE;
	const discrepancies: Discrepancy[] = [];

	const dimensions: Array<Discrepancy | undefined> = [
		compareDimension(
			"recipient",
			intended.recipient,
			actual.recipient,
			(i, a) => i !== a,
		),
		compareDimension(
			"amount",
			intended.lamports,
			actual.lamports,
			(i, a) => Math.abs(i - a) > lamportTolerance,
		),
		compareDimension(
			"amount",
			intended.tokenAmount,
			actual.tokenAmount,
			(i, a) => i !== a,
		),
		compareDimension("mint", intended.mint, actual.mint, (i, a) => i !== a),
	];

	for (const dimension of dimensions) {
		if (dimension !== undefined) discrepancies.push(dimension);
	}

	for (const instruction of actual.extraInstructions) {
		discrepancies.push({ field: "extra_instruction", actual: instruction });
	}

	return {
		outcome: discrepancies.length === 0 ? "match" : "mismatch",
		discrepancies,
	};
}
