import type {
	InternalImmutableMagicBlockCandidate,
	MagicBlockAppendOnlyAuditLedger,
	MagicBlockDevnetPreflightResult,
	MagicBlockPost,
	TrustedMagicBlockPlanStore,
} from "./magicBlockDevnetPreflightTypes";
import type {
	MagicBlockAuditRecordStore,
	MagicBlockOnchainAuditRegistration,
	MagicBlockOnchainAuditSubmitter,
} from "./magicBlockOnchainAuditContracts";

export const MAGICBLOCK_OBSERVATION_SCHEMA =
	"compass.magicblock-devnet-observation/v1" as const;
export const MAGICBLOCK_OBSERVATION_RESULT_SCHEMA =
	"compass.magicblock-devnet-observation-result/v1" as const;
export const MAGICBLOCK_OBSERVATION_MAX_REQUEST_BYTES = 16_384 as const;
export const MAGICBLOCK_MAX_TRANSACTION_BYTES = 1_232 as const;
export const MAGICBLOCK_OBSERVATION_CLAIM_LEASE_MS = 55_000 as const;

export type MagicBlockDevnetObservationV1 = {
	readonly schemaVersion: typeof MAGICBLOCK_OBSERVATION_SCHEMA;
	readonly observationId: string;
	readonly unsignedTransactionBase64: string;
};

export type MagicBlockDevnetObservationResultV1 =
	| {
			readonly schemaVersion: typeof MAGICBLOCK_OBSERVATION_RESULT_SCHEMA;
			readonly observationId: string;
			readonly outcome: "review_required" | "incompatible";
			readonly audit: {
				readonly auditEventId: string;
				readonly attestationDigest: string;
				readonly resultDigest?: string;
				readonly previousLedgerDigest?: string;
				readonly ledgerDigest?: string;
				readonly registration?: MagicBlockOnchainAuditRegistration;
			};
	  }
	| {
			readonly schemaVersion: typeof MAGICBLOCK_OBSERVATION_RESULT_SCHEMA;
			readonly observationId: string;
			readonly outcome: "unavailable";
	  };

export type MagicBlockObservationClaim =
	| { readonly status: "claimed"; readonly claimAttempt: number }
	| { readonly status: "pending" }
	| { readonly status: "conflict" }
	| {
			readonly status: "completed";
			readonly result: MagicBlockDevnetObservationResultV1;
	  };

export interface MagicBlockObservationStore {
	claim(input: {
		readonly observationId: string;
		readonly requestDigest: string;
		readonly receivedAt: string;
		readonly staleBefore: string;
	}): Promise<MagicBlockObservationClaim>;
	complete(input: {
		readonly observationId: string;
		readonly requestDigest: string;
		readonly claimAttempt: number;
		readonly result: MagicBlockDevnetObservationResultV1;
		readonly completedAt: string;
	}): Promise<void>;
}

export type DecodedUnsignedMagicBlockCandidate = {
	readonly candidate: InternalImmutableMagicBlockCandidate;
};

export type RequestScopedMagicBlockDependencies = {
	readonly candidateSource: {
		readonly reference: {
			readonly schemaVersion: "compass.internal-magicblock-candidate-ref/v1";
			readonly opaqueRef: string;
		};
		readonly source: {
			resolveImmutable(
				opaqueRef: string,
			): Promise<InternalImmutableMagicBlockCandidate | null>;
		};
	};
	readonly planStore: TrustedMagicBlockPlanStore;
};

export type MagicBlockAuditIngressRuntimeDependencies = {
	readonly observations: MagicBlockObservationStore;
	readonly createLedger: (binding: {
		readonly observationId: string;
		readonly requestDigest: string;
		readonly claimAttempt: number;
	}) => MagicBlockAppendOnlyAuditLedger;
	readonly post: MagicBlockPost;
	readonly onchainAudit?: MagicBlockOnchainAuditSubmitter;
	readonly auditRecords?: MagicBlockAuditRecordStore;
	readonly createOpaqueId?: (kind: "candidate" | "plan") => string;
	readonly now?: () => string;
	readonly nowEpochMs?: () => number;
};

export type MagicBlockAuditIngress = {
	handle(request: Request): Promise<Response>;
};

export type MagicBlockPreflightResult = MagicBlockDevnetPreflightResult;

export type MagicBlockReadableStreamReader = {
	read(): Promise<
		| { readonly done: false; readonly value: Uint8Array }
		| { readonly done: true; readonly value?: undefined }
	>;
	cancel(reason?: unknown): Promise<void>;
	releaseLock(): void;
};

export type MagicBlockFetchResponse = {
	readonly status: number;
	readonly url: string;
	readonly redirected: boolean;
	readonly body: {
		getReader(): MagicBlockReadableStreamReader;
	} | null;
};

export type MagicBlockFetch = (
	url: string,
	init: {
		readonly method: "POST";
		readonly redirect: "error";
		readonly headers: Readonly<Record<"content-type", "application/json">>;
		readonly body: string;
		readonly signal: AbortSignal;
	},
) => Promise<MagicBlockFetchResponse>;
