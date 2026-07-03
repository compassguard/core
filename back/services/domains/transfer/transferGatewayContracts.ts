import type {
	ActionCandidate,
	AuditEvent,
	AuditEventInput,
	CompassDecision,
	ToolClassification,
} from "@shared/executionGatewayContracts";
import type {
	CompassPolicy,
	PolicyEvaluation,
	PolicyEvaluationContext,
} from "@shared/policyContracts";

export const TRANSFER_AUDIT_LIFECYCLES = {
	PROPOSAL_CREATED: "proposal_created",
	PROPOSAL_REJECTED: "proposal_rejected",
	APPROVAL_RECEIVED: "approval_received",
	UNSIGNED_TX_PREPARED: "unsigned_tx_prepared",
	USER_REJECTED: "user_rejected",
	RESULT_SUBMITTED: "result_submitted",
	RESULT_CONFIRMED: "result_confirmed",
	RESULT_FAILED: "result_failed",
} as const;

export type TransferAuditLifecycle =
	(typeof TRANSFER_AUDIT_LIFECYCLES)[keyof typeof TRANSFER_AUDIT_LIFECYCLES];

export const TRANSFER_FAIL_CLOSED_REASONS = {
	POLICY_DENIED: "policy_denied",
	POLICY_REQUIRES_ADDITIONAL_CONTEXT: "policy_requires_additional_context",
	POLICY_REQUIRES_SIMULATION: "policy_requires_simulation",
	POLICY_REQUIRES_POLICY_UPDATE: "policy_requires_policy_update",
	POLICY_UNHANDLED_DECISION: "policy_unhandled_decision",
} as const;

export type TransferFailClosedReason =
	(typeof TRANSFER_FAIL_CLOSED_REASONS)[keyof typeof TRANSFER_FAIL_CLOSED_REASONS];

export type TransferQuoteResult = {
	amountUsd: number;
	source: string;
};

export type TransferWalletSafetyEvidence = {
	status?: string;
	reasonCodes?: string[];
	flags?: {
		suspicious_recipient?: boolean;
		unknown_program?: boolean;
		unlimited_delegate?: boolean;
		authority_change?: boolean;
	};
};

export type EvaluateTransferGatewayInput = {
	id?: string;
	network: string;
	toolName?: string;
	actorWallet?: string;
	amountSol: number;
	recipientAddress: string;
	recipientKnown?: boolean;
	createdAt?: string;
	quoteUsd?: () => Promise<TransferQuoteResult | undefined>;
	policy?: CompassPolicy;
	walletSafety?: TransferWalletSafetyEvidence;
};

export type TransferGatewayDecisionMetadata = {
	candidateId: string;
	candidateFingerprint: string;
	policyId: string;
	decision: CompassDecision;
	reasonCodes: string[];
	evaluatedRules: string[];
	classificationReasonCodes: string[];
	contextFingerprint: string;
	evaluatedAt: string;
};

export type TransferGatewayGate = {
	proposalEligible: boolean;
	requiresApprovalCard: boolean;
	failClosedReason?: TransferFailClosedReason;
};

export type TransferGatewayEvaluation = TransferGatewayGate & {
	classification: ToolClassification;
	candidate: ActionCandidate;
	policyContext: PolicyEvaluationContext;
	policyEvaluation: PolicyEvaluation;
	metadata: TransferGatewayDecisionMetadata;
};

export type BuildTransferGatewayApprovalMetadataInput = {
	stored: TransferGatewayDecisionMetadata;
	candidateId: string;
	network: string;
	toolName?: string;
	actorWallet?: string;
	amountSol: number;
	recipientAddress: string;
	createdAt?: string;
	expectedPolicyId?: string;
};

export type VerifyTransferGatewayMetadataInput = {
	stored?: TransferGatewayDecisionMetadata;
	current?: TransferGatewayDecisionMetadata;
};

export type VerifyTransferGatewayMetadataResult =
	| { ok: true }
	| {
			ok: false;
			reason: "gateway_context_missing" | "gateway_metadata_mismatch";
			mismatchedFields?: (keyof TransferGatewayDecisionMetadata)[];
	  };

export type TransferAuditResult =
	| AuditEventInput["result"]
	| "submitted"
	| "confirmed";

export type BuildTransferAuditEventInput = {
	id?: string;
	occurredAt?: string;
	lifecycle: TransferAuditLifecycle;
	evaluation: TransferGatewayEvaluation;
	approvalStatus?: AuditEventInput["approvalStatus"];
	result?: TransferAuditResult;
	transactionSignature?: string;
	metadata?: Record<string, unknown>;
};

export type TransferAuditEvent = Omit<AuditEvent, "result"> & {
	result?: TransferAuditResult;
};
