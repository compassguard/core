import type {
	MagicBlockAuditCommitmentDetails,
	MagicBlockFinalizedAuditProofVerifier,
	MagicBlockReadProofResult,
} from "./magicBlockAuditProofVerificationContracts";

export const MAGICBLOCK_AUDIT_PROOF_IMPORT_SCHEMA =
	"compass.magicblock-audit-proof-import/v1" as const;
export const MAGICBLOCK_AUDIT_PROOF_IMPORT_MAX_REQUEST_BYTES = 8_192;
export const MAGICBLOCK_AUDIT_PROOF_IMPORT_BODY_TIMEOUT_MS = 5_000;

export type MagicBlockAuditProofImportV1 = {
	readonly schemaVersion: typeof MAGICBLOCK_AUDIT_PROOF_IMPORT_SCHEMA;
	readonly cluster: "devnet";
	readonly details: MagicBlockAuditCommitmentDetails;
	readonly canonicalDetails: string;
	readonly commitmentDigest: string;
	readonly memo: string;
	readonly signature: string;
};

export type MagicBlockAuditProofRecord = {
	readonly details: MagicBlockAuditCommitmentDetails;
	readonly canonicalDetails: string;
	readonly registration: MagicBlockReadProofResult | ({ readonly status: "retryable_failure"; readonly signature?: string } & Readonly<Record<string, unknown>>);
};

export interface MagicBlockAuditProofRecordStore {
	save(record: MagicBlockAuditProofRecord): Promise<void>;
	findByAuditEventId(id: string): Promise<MagicBlockAuditProofRecord | null>;
	findByObservationId(id: string): Promise<MagicBlockAuditProofRecord | null>;
	findBySignature(signature: string): Promise<MagicBlockAuditProofRecord | null>;
}

export type MagicBlockAuditProofImportRuntime = {
	readonly expectedSigner: string;
	readonly verifier: MagicBlockFinalizedAuditProofVerifier;
	readonly auditRecords: MagicBlockAuditProofRecordStore;
};

export type MagicBlockAuditProofImportIngress = {
	handle(request: Request): Promise<Response>;
};

export type MagicBlockAuditProofImportResult = {
	readonly record: MagicBlockAuditProofRecord;
	readonly replayed: boolean;
};
