export const MAGICBLOCK_AUDIT_COMMITMENT_SCHEMA = "compass.magicblock-audit-commitment/v1" as const;
export const MAGICBLOCK_AUDIT_COMMITMENT_PREFIX = "compass:audit:v1:" as const;
export const MAGICBLOCK_MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as const;
export const SOLANA_DEVNET_RPC_URL = "https://api.devnet.solana.com/" as const;
export const MAGICBLOCK_DEVNET_ROUTER_URL = "https://devnet-router.magicblock.app/" as const;
export const MAGICBLOCK_READ_RPC_METHODS = ["getSignatureStatuses", "getTransaction"] as const;
export const MAGICBLOCK_READ_RPC_TIMEOUT_MS = 5_000;
export const MAGICBLOCK_READ_RPC_MAX_RESPONSE_BYTES = 64 * 1_024;

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

export type MagicBlockReadRpcMethod = (typeof MAGICBLOCK_READ_RPC_METHODS)[number];
export type MagicBlockReadRpc = (method: MagicBlockReadRpcMethod, params: readonly unknown[]) => Promise<unknown>;
export type MagicBlockReadEndpoint = "solana_devnet" | "magic_router";

export type MagicBlockConfirmedAuditProof = {
	readonly status: "confirmed";
	readonly cluster: "devnet";
	readonly routerUrl: typeof MAGICBLOCK_DEVNET_ROUTER_URL;
	readonly signature: string;
	readonly signer: string;
	readonly slot: number;
	readonly commitmentDigest: string;
	readonly memo: string;
	readonly verifiedAt: string;
};

export type MagicBlockReadProofFailure = {
	readonly status: "retryable_failure";
	readonly retryable: true;
	readonly code: "ROUTER_UNAVAILABLE" | "SUBMISSION_UNCONFIRMED" | "TRANSACTION_EXECUTION_FAILED" | "TRANSACTION_VERIFICATION_FAILED";
	readonly endpoint?: MagicBlockReadEndpoint;
};

export type MagicBlockReadProofResult = MagicBlockConfirmedAuditProof | MagicBlockReadProofFailure;
export type MagicBlockAuditProofVerificationRequest = {
	readonly signature: string;
	readonly expectedSigner: string;
	readonly expectedCommitmentDigest?: string;
	readonly expectedMemo?: string;
};

export interface MagicBlockFinalizedAuditProofVerifier {
	verify(input: MagicBlockAuditProofVerificationRequest): Promise<MagicBlockReadProofResult>;
}
