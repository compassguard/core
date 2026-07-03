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

export const SWAP_FAIL_CLOSED_REASONS = {
	POLICY_DENIED: "policy_denied",
	POLICY_REQUIRES_ADDITIONAL_CONTEXT: "policy_requires_additional_context",
	POLICY_REQUIRES_SIMULATION: "policy_requires_simulation",
	POLICY_REQUIRES_POLICY_UPDATE: "policy_requires_policy_update",
} as const;

export type SwapFailClosedReason =
	(typeof SWAP_FAIL_CLOSED_REASONS)[keyof typeof SWAP_FAIL_CLOSED_REASONS];

export type SwapQuoteResult = {
	amountUsd: number;
	source: string;
};

export type EvaluateSwapGatewayInput = {
	id?: string;
	network: string;
	toolName?: string;
	actorWallet?: string;
	inputToken: string;
	outputToken: string;
	inputAmount: number;
	slippageBps?: number;
	protocol?: string;
	tokenKnown?: boolean;
	tokenMint?: string;
	createdAt?: string;
	quoteUsd?: () => Promise<SwapQuoteResult | undefined>;
	policy?: CompassPolicy;
};

export type SwapGatewayDecisionMetadata = {
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

export type SwapGatewayGate = {
	proposalEligible: boolean;
	requiresApprovalCard: boolean;
	failClosedReason?: SwapFailClosedReason;
};

export type SwapGatewayEvaluation = SwapGatewayGate & {
	classification: ToolClassification;
	candidate: ActionCandidate;
	policyContext: PolicyEvaluationContext;
	policyEvaluation: PolicyEvaluation;
	metadata: SwapGatewayDecisionMetadata;
};
