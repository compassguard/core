export const MAGICBLOCK_SMOKE_STATE_SCHEMA =
	"compass.magicblock-devnet-smoke-state/v3" as const;
export const MAGICBLOCK_SMOKE_STATE_SCHEMA_V2 =
	"compass.magicblock-devnet-smoke-state/v2" as const;
export const MAGICBLOCK_SMOKE_STATE_SCHEMA_V1 =
	"compass.magicblock-devnet-smoke-state/v1" as const;
export const MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT =
	"I acknowledge this exceptional import only enriches legacy evidence and cannot by itself authorize, submit, reset, or close the pending transaction." as const;
export const MAGICBLOCK_LEGACY_QUARANTINE_ACKNOWLEDGEMENT =
	"I acknowledge this quarantine does not determine or terminalize the historical transaction, prohibits retrying its signature, preserves its evidence, releases only the Compass devnet audit Memo smoke lane for one newly authorized run, and does not release any payment or generic execution fence." as const;
export const MAGICBLOCK_LEGACY_TERMINALIZATION_IMPOSSIBLE_REASON =
	"Verified serialized transaction bytes are unavailable; a signature alone does not reveal the signed message, recent blockhash, or instructions, and null read-only RPC results are non-terminal." as const;

type MagicBlockSmokeStateBase = {
	readonly schemaVersion: typeof MAGICBLOCK_SMOKE_STATE_SCHEMA;
};

export type MagicBlockSmokeAuthorizedState = MagicBlockSmokeStateBase & {
	readonly status: "authorized";
	readonly authorizationNonce: string;
	readonly createdAt: string;
};

export type MagicBlockSmokeActiveState = MagicBlockSmokeStateBase & {
	readonly status: "active";
	readonly authorizationNonce: string;
	readonly auditEventId: string;
	readonly observationId: string;
	readonly startedAt: string;
};

export type MagicBlockSmokePendingState = MagicBlockSmokeStateBase & {
	readonly status: "pending";
	readonly cluster: "devnet";
	readonly lane: "magicblock_devnet_audit_memo";
	readonly valueTransferLamports: 0;
	readonly authorizationNonce: string;
	readonly auditEventId: string;
	readonly observationId: string;
	readonly signer: string;
	readonly signature: string;
	readonly commitmentDigest: string;
	readonly memo: string;
	readonly recentBlockhash: string;
	readonly lastValidBlockHeight: number;
	readonly serializedTransactionBase64: string;
	readonly serializedTransactionDigest: string;
	readonly blockhashValidityEvidence: MagicBlockSmokeBlockhashValidityEvidence;
	readonly preparedAt: string;
};

export type MagicBlockSmokeBlockhashValidityObservation = {
	readonly endpoint: "solana_devnet" | "magic_router";
	readonly recentBlockhash: string;
	readonly commitment: "confirmed";
	readonly contextSlot: number;
	readonly validity: "valid";
	readonly observedAt: string;
};

export type MagicBlockSmokeBlockhashValidityEvidence = {
	readonly solana: MagicBlockSmokeBlockhashValidityObservation;
	readonly magicRouter: MagicBlockSmokeBlockhashValidityObservation;
};

export type MagicBlockSmokeLegacyEvidenceImport = {
	readonly schemaVersion: "compass.magicblock-legacy-evidence/v1";
	readonly authorizationId: string;
	readonly operator: string;
	readonly reason: string;
	readonly authorizedAt: string;
	readonly riskAcknowledgement:
		typeof MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT;
	readonly transactionDigest: string;
	readonly recentBlockhash: string;
	readonly importedAt: string;
};

export type MagicBlockSmokeLegacyPendingState = MagicBlockSmokeStateBase & {
	readonly status: "legacy_pending";
	readonly signer: string;
	readonly signature: string;
	readonly importedAt: string;
	readonly sourceSchemaVersion:
		| typeof MAGICBLOCK_SMOKE_STATE_SCHEMA_V1
		| typeof MAGICBLOCK_SMOKE_STATE_SCHEMA_V2;
	readonly originalEvidence?: {
		readonly authorizationNonce?: string;
		readonly auditEventId?: string;
		readonly observationId?: string;
		readonly commitmentDigest?: string;
		readonly memo?: string;
		readonly preparedAt?: string;
		readonly recentBlockhash?: string;
		readonly lastValidBlockHeight?: number;
	};
	readonly evidenceImport?: MagicBlockSmokeLegacyEvidenceImport;
};

export type MagicBlockSmokeQuarantineEndpointObservation = {
	readonly endpoint: "solana_devnet" | "magic_router";
	readonly signature: string;
	readonly status: "confirmed" | "execution_failed" | "not_found" | "ambiguous" | "unavailable";
	readonly observedAt: string;
};

export type MagicBlockSmokeQuarantinedState = MagicBlockSmokeStateBase & {
	readonly status: "quarantined";
	readonly historicalOutcome: "unknown";
	readonly terminalizationImpossibleReason:
		typeof MAGICBLOCK_LEGACY_TERMINALIZATION_IMPOSSIBLE_REASON;
	readonly scope: {
		readonly cluster: "devnet";
		readonly lane: "magicblock_devnet_audit_memo";
		readonly valueTransferLamports: 0;
		readonly noPaymentExecution: true;
		readonly oldSignatureRetryProhibited: true;
		readonly genericExecutionFenceReleased: false;
	};
	readonly legacyEvidence: MagicBlockSmokeLegacyPendingState;
	readonly administration: {
		readonly schemaVersion: "compass.magicblock-legacy-quarantine/v1";
		readonly authorizationId: string;
		readonly incidentReference: string;
		readonly operator: string;
		readonly reason: string;
		readonly authorizedAt: string;
		readonly quarantinedAt: string;
		readonly acknowledgement:
			typeof MAGICBLOCK_LEGACY_QUARANTINE_ACKNOWLEDGEMENT;
		readonly verifiedSerializedTransactionAvailable: false;
		readonly endpointObservations?: {
			readonly solana: MagicBlockSmokeQuarantineEndpointObservation;
			readonly magicRouter: MagicBlockSmokeQuarantineEndpointObservation;
		};
		readonly observationUnavailableReason?: {
			readonly code: "READ_ONLY_RECONCILIATION_UNAVAILABLE";
			readonly observedAt: string;
		};
	};
};

export type MagicBlockSmokeReconciledState = MagicBlockSmokeStateBase & {
	readonly status: "reconciled";
	readonly outcome:
		| "confirmed"
		| "failed"
		| "expired_not_landed"
		| "not_submitted";
	readonly signature?: string;
	readonly reconciledAt: string;
	readonly preparedEvidence?:
		| MagicBlockSmokePendingState
		| MagicBlockSmokeLegacyPendingState;
	readonly expiryEvidence?: {
		readonly solana: MagicBlockSmokeEndpointExpiryEvidence;
		readonly magicRouter: MagicBlockSmokeEndpointExpiryEvidence;
	};
};

export type MagicBlockSmokeState =
	| MagicBlockSmokeAuthorizedState
	| MagicBlockSmokeActiveState
	| MagicBlockSmokePendingState
	| MagicBlockSmokeLegacyPendingState
	| MagicBlockSmokeQuarantinedState
	| MagicBlockSmokeReconciledState;

export type MagicBlockSmokeEndpointExpiryEvidence = {
	readonly endpoint: "solana_devnet" | "magic_router";
	readonly signature: string;
	readonly recentBlockhash: string;
	readonly commitment: "finalized";
	readonly signatureStatus: "not_found" | "present" | "ambiguous";
	readonly blockhashValidity: "invalid" | "valid" | "ambiguous";
	readonly expiryContextSlot?: number;
	readonly signatureContextSlot?: number;
	readonly blockHeight?: number;
	readonly observedAt: string;
};
