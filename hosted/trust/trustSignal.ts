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

/**
 * Sanctions and revocations deny outright. A malicious-address hit routes to
 * human review with the flag surfaced rather than denying outright: a hit is
 * upstream data we do not control, and a false positive would block a real
 * payment. Tighten `on_malicious` to DENY once the upstream false-positive rate
 * is known.
 */
export const DEFAULT_TRUST_POLICY: TrustPolicy = {
	on_sanctioned: HOSTED_DECISIONS.DENY,
	on_malicious: HOSTED_DECISIONS.REVIEW,
	on_revoked: HOSTED_DECISIONS.DENY,
	on_insufficient_evidence: HOSTED_DECISIONS.REVIEW,
	on_suspicious: HOSTED_DECISIONS.REVIEW,
	// A screen we could not complete escalates an otherwise-allowed payment to
	// human review — never permits it. "Could not check" must not read as "clean".
	on_unavailable: HOSTED_DECISIONS.REVIEW,
};

/** allow < review < deny. Higher is stricter. */
const STRICTNESS: Record<HostedDecision, number> = {
	[HOSTED_DECISIONS.ALLOW]: 0,
	[HOSTED_DECISIONS.REVIEW]: 1,
	[HOSTED_DECISIONS.DENY]: 2,
};

const REASON_FOR: Partial<Record<TrustVerdict, string>> = {
	[TRUST_VERDICTS.SANCTIONED]: TRUST_REASON_CODES.COUNTERPARTY_SANCTIONED,
	[TRUST_VERDICTS.MALICIOUS]: TRUST_REASON_CODES.COUNTERPARTY_MALICIOUS,
	[TRUST_VERDICTS.REVOKED]: TRUST_REASON_CODES.COUNTERPARTY_REPUTATION_REVOKED,
	[TRUST_VERDICTS.INSUFFICIENT_EVIDENCE]:
		TRUST_REASON_CODES.COUNTERPARTY_INSUFFICIENT_EVIDENCE,
	[TRUST_VERDICTS.SUSPICIOUS]: TRUST_REASON_CODES.COUNTERPARTY_SUSPICIOUS,
	[TRUST_VERDICTS.UNAVAILABLE]:
		TRUST_REASON_CODES.COUNTERPARTY_SCREENING_UNAVAILABLE,
};

/** What a verdict imposes on its own. CLEAN and NO_SIGNAL impose nothing. */
function imposedBy(verdict: TrustVerdict, policy: TrustPolicy): HostedDecision {
	switch (verdict) {
		case TRUST_VERDICTS.SANCTIONED:
			return policy.on_sanctioned;
		case TRUST_VERDICTS.MALICIOUS:
			return policy.on_malicious;
		case TRUST_VERDICTS.REVOKED:
			return policy.on_revoked;
		case TRUST_VERDICTS.INSUFFICIENT_EVIDENCE:
			return policy.on_insufficient_evidence;
		case TRUST_VERDICTS.SUSPICIOUS:
			return policy.on_suspicious;
		case TRUST_VERDICTS.UNAVAILABLE:
			return policy.on_unavailable;
		case TRUST_VERDICTS.CLEAN:
		case TRUST_VERDICTS.NO_SIGNAL:
			return HOSTED_DECISIONS.ALLOW;
	}
}

export type TrustRefinement = {
	decision: HostedDecision;
	/** Empty when the signal did not change the decision. */
	addedReasons: string[];
};

/**
 * Fold an external trust signal into the decision the policy engine already
 * reached.
 *
 * INVARIANT — the reason this module exists: the result is `max(base, imposed)`
 * on strictness, so a trust signal can only ever make a decision stricter. It
 * cannot turn a review into an allow, cannot raise a spend cap, and cannot
 * override the denylist. It never even sees those — it only sees the verdict the
 * deterministic engine already produced, and may push it further toward deny.
 *
 * A corollary: even a misconfigured TrustPolicy (say `on_malicious: "allow"`)
 * cannot make us more permissive, because max() never selects a value less
 * strict than the base. The safety property is structural, not a convention.
 */
export function applyTrustSignal(
	base: HostedDecision,
	signal: TrustSignal,
	policy: TrustPolicy = DEFAULT_TRUST_POLICY,
): TrustRefinement {
	const imposed = imposedBy(signal.verdict, policy);

	if (STRICTNESS[imposed] <= STRICTNESS[base]) {
		return { decision: base, addedReasons: [] };
	}

	const reasonCode = REASON_FOR[signal.verdict];

	return {
		decision: imposed,
		addedReasons: [...(reasonCode ? [reasonCode] : []), ...signal.reasons],
	};
}
