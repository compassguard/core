export const MAGICBLOCK_AUDIT_COMMITMENT_SCHEMA =
	"compass.magicblock-audit-commitment/v1" as const;
export const MAGICBLOCK_MEMO_PROGRAM_ID =
	"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as const;
export const MAGICBLOCK_AUDIT_COMMITMENT_PREFIX = "compass:audit:v1:" as const;
export const SOLANA_DEVNET_RPC_URL = "https://api.devnet.solana.com/" as const;

export type MagicBlockAuditCommitmentDetails = {
	readonly schemaVersion: typeof MAGICBLOCK_AUDIT_COMMITMENT_SCHEMA;
	readonly cluster: "devnet";
	readonly observationId: string;
	readonly auditEventId: string;
	readonly transactionDigest: string;
	readonly requestDigest: string;
	readonly resultDigest: string;
	readonly attestationDigest: string;
	readonly previousLedgerDigest: string;
	readonly ledgerDigest: string;
	readonly outcome: "review_required" | "incompatible";
};

export type MagicBlockConfirmedAuditProof = {
	readonly status: "confirmed";
	readonly cluster: "devnet";
	readonly routerUrl: "https://devnet-router.magicblock.app/";
	readonly signature: string;
	readonly signer: string;
	readonly slot: number;
	readonly commitmentDigest: string;
	readonly memo: string;
	readonly verifiedAt: string;
};

export type MagicBlockRetryableAuditFailure = {
	readonly status: "retryable_failure";
	readonly retryable: true;
	readonly code:
		| "SIGNER_UNAVAILABLE"
		| "ROUTER_UNAVAILABLE"
		| "SUBMISSION_UNCONFIRMED"
		| "TRANSACTION_VERIFICATION_FAILED";
	readonly signature?: string;
	readonly commitmentDigest?: string;
	readonly memo?: string;
};

export type MagicBlockOnchainAuditRegistration =
	| MagicBlockConfirmedAuditProof
	| MagicBlockRetryableAuditFailure;

export interface MagicBlockOnchainAuditSubmitter {
	register(
		details: MagicBlockAuditCommitmentDetails,
		onPrepared?: (
			prepared: MagicBlockRetryableAuditFailure,
		) => Promise<MagicBlockRetryableAuditFailure>,
	): Promise<MagicBlockOnchainAuditRegistration>;
	verify(input: {
		readonly signature: string;
		readonly expectedCommitmentDigest?: string;
		readonly expectedMemo?: string;
	}): Promise<MagicBlockOnchainAuditRegistration>;
}

export type MagicBlockAuditRecord = {
	readonly details: MagicBlockAuditCommitmentDetails;
	readonly canonicalDetails: string;
	readonly registration: MagicBlockOnchainAuditRegistration;
};

export interface MagicBlockAuditRecordStore {
	save(record: MagicBlockAuditRecord): Promise<void>;
	reservePrepared(input: {
		readonly record: MagicBlockAuditRecord;
		readonly requestDigest: string;
		readonly claimAttempt: number;
	}): Promise<MagicBlockAuditRecord>;
	findByAuditEventId(auditEventId: string): Promise<MagicBlockAuditRecord | null>;
	findByObservationId(observationId: string): Promise<MagicBlockAuditRecord | null>;
	findBySignature(signature: string): Promise<MagicBlockAuditRecord | null>;
}
