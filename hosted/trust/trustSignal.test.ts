import { describe, expect, it } from "vitest";

import {
	HOSTED_DECISIONS,
	type HostedDecision,
} from "@shared/evaluationContracts";
import {
	TRUST_REASON_CODES,
	TRUST_VERDICTS,
	type TrustPolicy,
	type TrustSignal,
	type TrustVerdict,
} from "@shared/trustContracts";

import { DEFAULT_TRUST_POLICY, applyTrustSignal } from "./trustSignal";

const STRICTNESS: Record<HostedDecision, number> = {
	[HOSTED_DECISIONS.ALLOW]: 0,
	[HOSTED_DECISIONS.REVIEW]: 1,
	[HOSTED_DECISIONS.DENY]: 2,
};

const ALL_DECISIONS: HostedDecision[] = [
	HOSTED_DECISIONS.ALLOW,
	HOSTED_DECISIONS.REVIEW,
	HOSTED_DECISIONS.DENY,
];

const ALL_VERDICTS: TrustVerdict[] = Object.values(TRUST_VERDICTS);

const signalOf = (verdict: TrustVerdict): TrustSignal => ({
	verdict,
	reasons: [],
});

describe("applyTrustSignal — the invariant", () => {
	it("never makes a decision more permissive, for any base × any verdict", () => {
		for (const base of ALL_DECISIONS) {
			for (const verdict of ALL_VERDICTS) {
				const { decision } = applyTrustSignal(base, signalOf(verdict));

				expect(
					STRICTNESS[decision],
					`base=${base} verdict=${verdict} produced ${decision}`,
				).toBeGreaterThanOrEqual(STRICTNESS[base]);
			}
		}
	});

	it("holds even when the trust policy is misconfigured to be permissive", () => {
		// Every negative verdict wired to "allow" — the worst config anyone could
		// write. max() on strictness must still refuse to relax anything.
		const sabotaged: TrustPolicy = {
			on_sanctioned: HOSTED_DECISIONS.ALLOW,
			on_malicious: HOSTED_DECISIONS.ALLOW,
			on_revoked: HOSTED_DECISIONS.ALLOW,
			on_insufficient_evidence: HOSTED_DECISIONS.ALLOW,
			on_suspicious: HOSTED_DECISIONS.ALLOW,
			on_unavailable: HOSTED_DECISIONS.ALLOW,
		};

		for (const base of ALL_DECISIONS) {
			for (const verdict of ALL_VERDICTS) {
				const { decision } = applyTrustSignal(base, signalOf(verdict), sabotaged);

				expect(STRICTNESS[decision]).toBeGreaterThanOrEqual(STRICTNESS[base]);
			}
		}
	});

	it("a clean counterparty cannot upgrade a review to an allow", () => {
		const { decision, addedReasons } = applyTrustSignal(
			HOSTED_DECISIONS.REVIEW,
			signalOf(TRUST_VERDICTS.CLEAN),
		);

		expect(decision).toBe(HOSTED_DECISIONS.REVIEW);
		expect(addedReasons).toEqual([]);
	});
});

describe("applyTrustSignal — negative evidence is applied", () => {
	it("denies an otherwise-allowed payment to a sanctioned address", () => {
		const { decision, addedReasons } = applyTrustSignal(
			HOSTED_DECISIONS.ALLOW,
			signalOf(TRUST_VERDICTS.SANCTIONED),
		);

		expect(decision).toBe(HOSTED_DECISIONS.DENY);
		expect(addedReasons).toContain(TRUST_REASON_CODES.COUNTERPARTY_SANCTIONED);
	});

	it("denies an otherwise-allowed payment to a revoked counterparty", () => {
		const { decision, addedReasons } = applyTrustSignal(
			HOSTED_DECISIONS.ALLOW,
			signalOf(TRUST_VERDICTS.REVOKED),
		);

		expect(decision).toBe(HOSTED_DECISIONS.DENY);
		expect(addedReasons).toContain(
			TRUST_REASON_CODES.COUNTERPARTY_REPUTATION_REVOKED,
		);
	});

	it("routes an otherwise-allowed payment to a malicious address into review", () => {
		// The valuable catch: the deterministic engine was happy (small amount,
		// known recipient) but the address is a known drainer.
		const { decision, addedReasons } = applyTrustSignal(
			HOSTED_DECISIONS.ALLOW,
			signalOf(TRUST_VERDICTS.MALICIOUS),
		);

		expect(decision).toBe(HOSTED_DECISIONS.REVIEW);
		expect(addedReasons).toContain(TRUST_REASON_CODES.COUNTERPARTY_MALICIOUS);
	});

	it("escalates malicious to deny when the policy is tightened", () => {
		const strict: TrustPolicy = {
			...DEFAULT_TRUST_POLICY,
			on_malicious: HOSTED_DECISIONS.DENY,
		};

		const { decision } = applyTrustSignal(
			HOSTED_DECISIONS.ALLOW,
			signalOf(TRUST_VERDICTS.MALICIOUS),
			strict,
		);

		expect(decision).toBe(HOSTED_DECISIONS.DENY);
	});

	it("leaves an existing deny untouched", () => {
		for (const verdict of ALL_VERDICTS) {
			const { decision } = applyTrustSignal(
				HOSTED_DECISIONS.DENY,
				signalOf(verdict),
			);

			expect(decision).toBe(HOSTED_DECISIONS.DENY);
		}
	});
});

describe("applyTrustSignal — absent signal is a no-op", () => {
	it("NO_SIGNAL leaves every decision exactly as the engine left it", () => {
		for (const base of ALL_DECISIONS) {
			const { decision, addedReasons } = applyTrustSignal(
				base,
				signalOf(TRUST_VERDICTS.NO_SIGNAL),
			);

			expect(decision).toBe(base);
			expect(addedReasons).toEqual([]);
		}
	});
});

describe("applyTrustSignal — screening unavailable is caution, recorded distinctly", () => {
	it("escalates an otherwise-allowed payment to review, distinct from a clean pass", () => {
		const { decision, addedReasons } = applyTrustSignal(
			HOSTED_DECISIONS.ALLOW,
			signalOf(TRUST_VERDICTS.UNAVAILABLE),
		);

		// An outage must not read as "screened clean": it moves ALLOW → REVIEW and
		// carries its own reason, unlike NO_SIGNAL/CLEAN which leave ALLOW untouched.
		expect(decision).toBe(HOSTED_DECISIONS.REVIEW);
		expect(addedReasons).toContain(
			TRUST_REASON_CODES.COUNTERPARTY_SCREENING_UNAVAILABLE,
		);
	});

	it("never permits: UNAVAILABLE cannot relax a review or a deny", () => {
		expect(
			applyTrustSignal(HOSTED_DECISIONS.REVIEW, signalOf(TRUST_VERDICTS.UNAVAILABLE))
				.decision,
		).toBe(HOSTED_DECISIONS.REVIEW);
		expect(
			applyTrustSignal(HOSTED_DECISIONS.DENY, signalOf(TRUST_VERDICTS.UNAVAILABLE))
				.decision,
		).toBe(HOSTED_DECISIONS.DENY);
	});

	it("routes a soft/suspicious flag to review", () => {
		const { decision, addedReasons } = applyTrustSignal(
			HOSTED_DECISIONS.ALLOW,
			signalOf(TRUST_VERDICTS.SUSPICIOUS),
		);

		expect(decision).toBe(HOSTED_DECISIONS.REVIEW);
		expect(addedReasons).toContain(TRUST_REASON_CODES.COUNTERPARTY_SUSPICIOUS);
	});
});
