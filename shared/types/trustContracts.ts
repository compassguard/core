import type { HostedDecision } from "./evaluationContracts";

/**
 * Verdicts an external trust / screening source can return about a counterparty.
 *
 * Deliberately absent: any "trusted" / "high score" verdict, and any score field
 * on TrustSignal. An external trust signal may only ever make a decision
 * STRICTER (see applyTrustSignal). A good reputation is not admissible as
 * permission, for two reasons that hold no matter how good the scoring gets:
 *
 *   - Reputation describes a counterparty's past; a stolen key is a present
 *     fact. An agent with a long, honestly-earned history still scores well the
 *     day after its key is compromised.
 *   - The only thing a high score could buy is the removal of a human review —
 *     and that review is worth far more to an attacker to delete than it is to a
 *     legitimate counterparty to skip. Whatever signal grants that bypass is
 *     therefore under more pressure from adversaries than from real users.
 *
 * CLEAN accordingly means "not on any blacklist", NOT "safe to allow". Keeping
 * the score out of this type makes "decide on the score" unrepresentable rather
 * than merely discouraged.
 */
export const TRUST_VERDICTS = {
	/** Sanctions (e.g. OFAC) hit. */
	SANCTIONED: "sanctioned",
	/** Known scam / phishing / drainer / exploit address. */
	MALICIOUS: "malicious",
	/** On-chain reputation was revoked. */
	REVOKED: "revoked",
	/** Registered, but too little evidence to conclude anything. */
	INSUFFICIENT_EVIDENCE: "insufficient_evidence",
	/** A soft negative flag (suspicious but not confirmed malicious). */
	SUSPICIOUS: "suspicious",
	/** No negative flags. Imposes nothing — explicitly not a vouch. */
	CLEAN: "clean",
	/**
	 * The screen was ATTEMPTED but could not be completed — provider down,
	 * timeout, non-2xx, unparseable body, or a response that failed signature
	 * verification. Distinct from NO_SIGNAL: "we could not check" is not "we
	 * checked and found nothing". Imposes REVIEW (see DEFAULT_TRUST_POLICY) so an
	 * outage never reads as a clean pass in the audit trail.
	 */
	UNAVAILABLE: "unavailable",
	/**
	 * Screening did not apply — there was no address to screen. Imposes nothing.
	 * This is the genuine no-op; a provider FAILURE is UNAVAILABLE, not this.
	 */
	NO_SIGNAL: "no_signal",
} as const;

export type TrustVerdict = (typeof TRUST_VERDICTS)[keyof typeof TRUST_VERDICTS];

export const TRUST_REASON_CODES = {
	COUNTERPARTY_SANCTIONED: "COUNTERPARTY_SANCTIONED",
	COUNTERPARTY_MALICIOUS: "COUNTERPARTY_MALICIOUS",
	COUNTERPARTY_REPUTATION_REVOKED: "COUNTERPARTY_REPUTATION_REVOKED",
	COUNTERPARTY_INSUFFICIENT_EVIDENCE: "COUNTERPARTY_INSUFFICIENT_EVIDENCE",
	COUNTERPARTY_SUSPICIOUS: "COUNTERPARTY_SUSPICIOUS",
	/** The screen could not be completed; the verdict was made stricter as a precaution. */
	COUNTERPARTY_SCREENING_UNAVAILABLE: "COUNTERPARTY_SCREENING_UNAVAILABLE",
} as const;

export type TrustSignal = {
	verdict: TrustVerdict;
	/** Extra reason codes to surface when the signal changes the decision. */
	reasons: string[];
	/**
	 * The raw (signed) provider response, retained as audit evidence for the
	 * decision. The policy layer never reads this.
	 */
	evidence?: unknown;
};

/**
 * Screens a counterparty address.
 *
 * Contract: implementations MUST NOT throw and MUST NOT hang. Bound your own
 * latency and return NO_SIGNAL on any failure. A screening outage must never
 * take a policy decision down — and, by construction, can never relax one.
 */
export type TrustProvider = {
	screen(counterpartyAddress: string): Promise<TrustSignal>;
};

/**
 * How strictly each negative verdict is treated. Tunable without weakening the
 * invariant: applyTrustSignal takes max() on strictness, so even a misconfigured
 * mapping cannot make a decision more permissive.
 */
export type TrustPolicy = {
	on_sanctioned: HostedDecision;
	on_malicious: HostedDecision;
	on_revoked: HostedDecision;
	on_insufficient_evidence: HostedDecision;
	on_suspicious: HostedDecision;
	/** What a screen we could not complete imposes. Never ALLOW — an outage must not permit. */
	on_unavailable: HostedDecision;
};
