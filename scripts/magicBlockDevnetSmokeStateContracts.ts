export const MAGICBLOCK_SMOKE_STATE_SCHEMA =
	"compass.magicblock-devnet-smoke-state/v2" as const;
export const MAGICBLOCK_SMOKE_STATE_SCHEMA_V1 =
	"compass.magicblock-devnet-smoke-state/v1" as const;
export const MAGICBLOCK_LEGACY_EVIDENCE_RISK_ACKNOWLEDGEMENT =
	"I acknowledge this exceptional import only enriches legacy evidence and cannot by itself authorize, submit, reset, or close the pending transaction." as const;

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
	readonly authorizationNonce: string;
	readonly auditEventId: string;
	readonly observationId: string;
	readonly signer: string;
	readonly signature: string;
	readonly commitmentDigest: string;
	readonly memo: string;
	readonly recentBlockhash: string;
	readonly lastValidBlockHeight: number;
	readonly preparedAt: string;
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
	readonly sourceSchemaVersion: typeof MAGICBLOCK_SMOKE_STATE_SCHEMA_V1;
	readonly originalEvidence?: {
		readonly authorizationNonce?: string;
		readonly auditEventId?: string;
		readonly observationId?: string;
		readonly commitmentDigest?: string;
		readonly memo?: string;
		readonly preparedAt?: string;
	};
	readonly evidenceImport?: MagicBlockSmokeLegacyEvidenceImport;
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
