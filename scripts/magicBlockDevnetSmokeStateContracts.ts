export const MAGICBLOCK_SMOKE_STATE_SCHEMA =
	"compass.magicblock-devnet-smoke-state/v1" as const;

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
	readonly preparedAt: string;
};

export type MagicBlockSmokeLegacyPendingState = MagicBlockSmokeStateBase & {
	readonly status: "legacy_pending";
	readonly signer: string;
	readonly signature: string;
	readonly importedAt: string;
};

export type MagicBlockSmokeReconciledState = MagicBlockSmokeStateBase & {
	readonly status: "reconciled";
	readonly outcome: "confirmed" | "failed" | "not_submitted";
	readonly signature?: string;
	readonly reconciledAt: string;
};

export type MagicBlockSmokeState =
	| MagicBlockSmokeAuthorizedState
	| MagicBlockSmokeActiveState
	| MagicBlockSmokePendingState
	| MagicBlockSmokeLegacyPendingState
	| MagicBlockSmokeReconciledState;
