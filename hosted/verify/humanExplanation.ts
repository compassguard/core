import type { HostedDecision } from "@shared/evaluationContracts";
import { POLICY_REASON_CODES } from "@shared/policyContracts";
import { TRUST_REASON_CODES } from "@shared/trustContracts";

/**
 * Operator-readable sentence per known policy reason code. Keyed on the
 * POLICY_REASON_CODES constants (not string literals) so a renamed code fails
 * to compile rather than silently dropping to the fallback.
 */
const REASON_SENTENCES: Partial<Record<string, string>> = {
	[POLICY_REASON_CODES.READ_ONLY_BY_POLICY]:
		"Read-only action — no funds move.",
	[POLICY_REASON_CODES.TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT]:
		"Transfer is within the cap and the recipient is known.",
	[POLICY_REASON_CODES.TRANSFER_EXCEEDS_LIMIT]:
		"Transfer amount exceeds the approval-free cap.",
	[POLICY_REASON_CODES.TRANSFER_UNKNOWN_RECIPIENT]:
		"Recipient is not on the allowlist.",
	[POLICY_REASON_CODES.TRANSFER_BLOCKED_RECIPIENT]:
		"Recipient is on the denylist.",
	[POLICY_REASON_CODES.BLOCKED_AUTHORITY_CHANGE]:
		"The transaction changes an account authority.",
	[POLICY_REASON_CODES.BLOCKED_UNLIMITED_DELEGATE]:
		"The transaction grants an unlimited spend delegation.",
	[POLICY_REASON_CODES.BLOCKED_SUSPICIOUS_RECIPIENT]:
		"The recipient is flagged as suspicious.",
	[POLICY_REASON_CODES.BLOCKED_UNKNOWN_PROGRAM]:
		"The transaction calls an unrecognized program.",
	[POLICY_REASON_CODES.SWAP_EXCEEDS_LIMIT]:
		"Swap amount exceeds the approval-free cap.",
	[POLICY_REASON_CODES.SWAP_SLIPPAGE_EXCEEDS_LIMIT]:
		"Swap slippage exceeds the allowed limit.",
	[POLICY_REASON_CODES.SWAP_UNALLOWED_PROTOCOL]:
		"Swap routes through a protocol that is not allowlisted.",
	[POLICY_REASON_CODES.UNKNOWN_MUTATING_TOOL_DENIED]:
		"Unknown state-changing tool — denied by default.",
	[POLICY_REASON_CODES.UNKNOWN_TOOL_NEEDS_CONTEXT]:
		"Unknown tool — more context is needed before allowing it.",

	// Counterparty screening. These only ever accompany a decision the trust layer
	// made stricter — no screening result can produce an approving sentence.
	[TRUST_REASON_CODES.COUNTERPARTY_SANCTIONED]:
		"The recipient appears on a sanctions list.",
	[TRUST_REASON_CODES.COUNTERPARTY_MALICIOUS]:
		"The recipient is a known scam, phishing or drainer address.",
	[TRUST_REASON_CODES.COUNTERPARTY_REPUTATION_REVOKED]:
		"The recipient's on-chain reputation has been revoked.",
	[TRUST_REASON_CODES.COUNTERPARTY_INSUFFICIENT_EVIDENCE]:
		"There is too little on-chain evidence about the recipient to judge it.",
};

const DECISION_FALLBACK: Record<HostedDecision, string> = {
	allow: "Allowed by policy.",
	deny: "Denied by policy.",
	review: "Needs human review before proceeding.",
};

/**
 * Turn a decision + its policy reason codes into a single human-readable
 * explanation. Recognized codes are rendered as sentences; if none are
 * recognized, falls back to a decision-keyed sentence (never empty).
 */
export function buildHumanExplanation(
	decision: HostedDecision,
	reasonCodes: string[],
): string {
	const sentences = reasonCodes
		.map((code) => REASON_SENTENCES[code])
		.filter((sentence): sentence is string => sentence !== undefined);

	if (sentences.length > 0) {
		return sentences.join(" ");
	}

	return DECISION_FALLBACK[decision];
}
