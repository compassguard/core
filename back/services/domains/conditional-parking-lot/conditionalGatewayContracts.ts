import type {
	ActionCandidate,
	CompassDecision,
	ToolClassification,
} from "@shared/executionGatewayContracts";
import type {
	CompassPolicy,
	PolicyEvaluation,
	PolicyEvaluationContext,
} from "@shared/policyContracts";

export const CONDITIONAL_FAIL_CLOSED_REASONS = {
	POLICY_DENIED: "policy_denied",
	POLICY_REQUIRES_ADDITIONAL_CONTEXT: "policy_requires_additional_context",
	POLICY_REQUIRES_SIMULATION: "policy_requires_simulation",
	POLICY_REQUIRES_POLICY_UPDATE: "policy_requires_policy_update",
} as const;

export type ConditionalFailClosedReason =
	(typeof CONDITIONAL_FAIL_CLOSED_REASONS)[keyof typeof CONDITIONAL_FAIL_CLOSED_REASONS];

export type EvaluateConditionalGatewayInput = {
	id?: string;
	network: string;
	toolName?: string;
	actorWallet?: string;
	inputToken: "USDC";
	inputAmountUsdc?: number;
	targetPriceUsd?: number;
	desiredSolLamports?: number;
	maxSlippageBps?: number;
	oracleFeedPubkey?: string;
	oraclePriceUsd?: number;
	oracleAgeSeconds?: number;
	maxOracleAgeSeconds?: number;
	oracleConfidenceBps?: number;
	maxConfidenceBps?: number;
	recipient?: string;
	expiresAtUnix?: number;
	currentUnixTimestamp?: number;
	createdAt?: string;
	policy?: CompassPolicy;
};

export type ConditionalGatewayDecisionMetadata = {
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

export type ConditionalGatewayGate = {
	proposalEligible: boolean;
	requiresApprovalCard: boolean;
	failClosedReason?: ConditionalFailClosedReason;
};

export type ConditionalGatewayEvaluation = ConditionalGatewayGate & {
	classification: ToolClassification;
	candidate: ActionCandidate;
	policyContext: PolicyEvaluationContext;
	policyEvaluation: PolicyEvaluation;
	metadata: ConditionalGatewayDecisionMetadata;
};
