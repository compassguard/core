export const MAGICBLOCK_ROUTER_URL = "https://devnet-router.magicblock.app/" as const;
export const MAGICBLOCK_ROUTER_HOST = "devnet-router.magicblock.app" as const;
export const MAGICBLOCK_METHOD = "getDelegationStatus" as const;
export const MAGICBLOCK_MAX_RESPONSE_BYTES = 16_384 as const;
export const MAGICBLOCK_MAX_CANDIDATE_ACCOUNTS = 8 as const;
export const MAGICBLOCK_MAX_PROVIDER_CONCURRENCY = 4 as const;
export const MAGICBLOCK_PROVIDER_TIMEOUT_MS = 2_000 as const;
export const MAGICBLOCK_ROUTE_DEADLINE_MS = 8_000 as const;

export type MagicBlockAccountFlags = {
	readonly isSigner: boolean;
	readonly isWritable: boolean;
	readonly isProgram: boolean;
	readonly isPayer: boolean;
};

export type MagicBlockCandidateAccount = MagicBlockAccountFlags & {
	readonly publicKey: string;
};

export type MagicBlockDecodedPlan = {
	readonly schemaVersion: "compass.decoded-action-plan/v1";
	readonly actionKind: "account_delegation_review";
	readonly accountIndexes: readonly string[];
};

export type InternalImmutableMagicBlockCandidate = {
	readonly schemaVersion: "compass.magicblock-candidate/v1";
	readonly cluster: "devnet";
	readonly decodedPlan: MagicBlockDecodedPlan;
	readonly accounts: readonly MagicBlockCandidateAccount[];
};

export type InternalMagicBlockCandidateRef = {
	readonly schemaVersion: "compass.internal-magicblock-candidate-ref/v1";
	readonly opaqueRef: string;
};

export interface InternalMagicBlockCandidateSource {
	resolveImmutable(
		opaqueRef: string,
	): Promise<InternalImmutableMagicBlockCandidate | null>;
}

export type MagicBlockAccountProjection = MagicBlockAccountFlags & {
	readonly accountIndex: string;
	readonly publicKey: string;
};

export type TrustedDecodedPlanRef = {
	readonly schemaVersion: "compass.trusted-decoded-plan-ref/v1";
	readonly opaqueRef: string;
};

export type TrustedMagicBlockAccountBinding = MagicBlockAccountProjection & {
	readonly accountDigest: string;
};

export type TrustedDecodedActionPlan = {
	readonly schemaVersion: "compass.trusted-decoded-action-plan/v1";
	readonly planId: string;
	readonly candidateId: string;
	readonly candidateDigest: string;
	readonly decodedPlanDigest: string;
	readonly cluster: "devnet";
	readonly accountDigests: readonly string[];
};

export type TrustedMagicBlockPlanSnapshot = {
	readonly schemaVersion: "compass.trusted-decoded-plan-snapshot/v1";
	readonly plan: TrustedDecodedActionPlan;
	readonly candidate: {
		readonly schemaVersion: "compass.magicblock-candidate/v1";
		readonly candidateId: string;
		readonly cluster: "devnet";
		readonly decodedPlan: MagicBlockDecodedPlan;
		readonly accounts: readonly MagicBlockAccountProjection[];
	};
	readonly accountBindings: readonly TrustedMagicBlockAccountBinding[];
};

export type ResolvedTrustedMagicBlockPlan = {
	readonly snapshot: TrustedMagicBlockPlanSnapshot;
};

export interface TrustedMagicBlockPlanStore {
	insertImmutable(snapshot: TrustedMagicBlockPlanSnapshot): Promise<void>;
	resolveImmutable(opaqueRef: string): Promise<TrustedMagicBlockPlanSnapshot | null>;
}

export type MagicBlockDelegationRecord = {
	readonly authority: string;
	readonly owner: string;
	readonly delegationSlot: number;
	readonly lamports: number;
};

export type MagicBlockDelegationStatus = {
	readonly isDelegated: boolean;
	readonly fqdn?: string;
	readonly delegationRecord?: MagicBlockDelegationRecord;
};

export type MagicBlockPostRequest = {
	readonly url: typeof MAGICBLOCK_ROUTER_URL;
	readonly method: "POST";
	readonly redirect: "error";
	readonly headers: Readonly<Record<"content-type", "application/json">>;
	readonly body: string;
	/** The transport MUST enforce this limit while streaming, before buffering. */
	readonly maxResponseBytes: typeof MAGICBLOCK_MAX_RESPONSE_BYTES;
	/** Absolute caller deadline; the transport uses the smaller of this and its fixed timeout. */
	readonly deadlineAtEpochMs: number;
};

export type MagicBlockPostResponse = {
	readonly status: number;
	readonly url: string;
	readonly redirected: boolean;
	/** Already streaming-capped by the transport; the adapter rechecks UTF-8 bytes. */
	readonly body: string;
};

export type MagicBlockPost = (
	request: MagicBlockPostRequest,
) => Promise<MagicBlockPostResponse>;

export type ValidatedMagicBlockEvidence = {
	readonly schemaVersion: "magicblock.devnet-evidence/v1";
	readonly endpointHost: typeof MAGICBLOCK_ROUTER_HOST;
	readonly method: typeof MAGICBLOCK_METHOD;
	readonly observedAt: string;
	readonly accountDigests: readonly string[];
	readonly classifications: readonly ("delegated" | "base_layer")[];
	readonly delegationStatuses: readonly MagicBlockDelegationStatus[];
};

export type MagicBlockAuditOutcome =
	| "review_required"
	| "incompatible"
	| "unavailable";

export type MagicBlockPersistedAuditOutcome = Exclude<
	MagicBlockAuditOutcome,
	"unavailable"
>;

export type MagicBlockAuditRationale =
	| "DELEGATION_STATUS_CONFIRMED"
	| "DELEGATION_STATUS_INCOMPATIBLE"
	| "EVIDENCE_UNAVAILABLE";

export type MagicBlockPersistedAuditRationale = Exclude<
	MagicBlockAuditRationale,
	"EVIDENCE_UNAVAILABLE"
>;

export type MagicBlockDevnetAuditPayloadV1 = {
	readonly schemaVersion: "magicblock-devnet-attestation/v1";
	readonly eventType: "magicblock_devnet_audit_attestation";
	readonly auditEventId: string;
	readonly observationId?: string;
	readonly occurredAt: string;
	readonly cluster: "devnet";
	readonly transactionDigest?: string;
	readonly requestDigest?: string;
	readonly resultDigest?: string;
	readonly candidateDigest: string;
	readonly decodedPlanDigest: string;
	readonly evidence: {
		readonly endpointHost: typeof MAGICBLOCK_ROUTER_HOST;
		readonly method: typeof MAGICBLOCK_METHOD;
		readonly observedAt: string;
		readonly accountDigests: readonly string[];
		readonly classifications: readonly ("delegated" | "base_layer")[];
	};
	readonly outcome: MagicBlockPersistedAuditOutcome;
	readonly rationaleCode: MagicBlockPersistedAuditRationale;
	readonly registration: "required";
};

export type MaterializedMagicBlockAuditEvent = {
	readonly payload: MagicBlockDevnetAuditPayloadV1;
	readonly canonicalPayload: string;
	readonly attestationDigest: string;
};

export interface MagicBlockAppendOnlyAuditLedger {
	appendAtomic(input: {
		readonly schemaVersion: "magicblock-devnet-attestation/v1";
		readonly materialize: (auditEventId: string) => MaterializedMagicBlockAuditEvent;
	}): Promise<{
		readonly auditEventId: string;
		readonly attestationDigest: string;
		readonly previousLedgerDigest?: string;
		readonly ledgerDigest?: string;
		readonly canonicalPayload?: string;
		readonly reused?: true;
	}>;
}

export type MagicBlockAuditWriteResult = {
	readonly auditEventId: string;
	readonly attestationDigest: string;
	readonly resultDigest?: string;
	readonly previousLedgerDigest?: string;
	readonly ledgerDigest?: string;
	readonly persistedOutcome?: MagicBlockPersistedAuditOutcome;
};

export type MagicBlockDevnetPreflightResult =
	| {
			readonly outcome: "review_required" | "incompatible";
			readonly audit: MagicBlockAuditWriteResult;
	  }
	| {
			readonly outcome: "unavailable";
	  };
