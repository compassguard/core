import { canonicalJson, sha256Hex } from "./magicBlockDevnetPreflightCanonical";
import {
	MAGICBLOCK_AUDIT_COMMITMENT_PREFIX,
	type MagicBlockAuditCommitmentDetails,
} from "./magicBlockAuditProofVerificationContracts";

const COMMITMENT_DOMAIN = "compass.magicblock-audit-commitment/v1\0";

export function materializeMagicBlockAuditCommitment(details: MagicBlockAuditCommitmentDetails): {
	readonly canonicalDetails: string;
	readonly commitmentDigest: string;
	readonly memo: string;
} {
	const canonicalDetails = canonicalJson(details);
	const commitmentDigest = sha256Hex(COMMITMENT_DOMAIN, canonicalDetails);
	const publicCommitment = canonicalJson({
		a: details.auditEventId,
		c: commitmentDigest,
		l: details.ledgerDigest,
		o: details.outcome === "review_required" ? "review" : "incompatible",
		p: details.previousLedgerDigest,
		v: 1,
	});
	return { canonicalDetails, commitmentDigest, memo: `${MAGICBLOCK_AUDIT_COMMITMENT_PREFIX}${publicCommitment}` };
}
