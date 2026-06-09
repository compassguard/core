import type {
	ActionCandidate,
	CompassDecision,
	ToolClassification,
} from "../executionGatewayContracts";

export const POLICY_OUTCOMES = {
	ALLOW: "allow",
	DENY: "deny",
	REQUIRE_APPROVAL: "require_approval",
	REQUIRE_SIMULATION: "require_simulation",
	REQUIRE_POLICY_UPDATE: "require_policy_update",
	REQUIRE_ADDITIONAL_CONTEXT: "require_additional_context",
	DENY_UNLESS_COMPASS_BUILT: "deny_unless_compass_built",
} as const;

export const POLICY_REASON_CODES = {
	READ_ONLY_BY_POLICY: "READ_ONLY_BY_POLICY",
	TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT:
		"TRANSFER_WITHIN_LIMIT_KNOWN_RECIPIENT",
	TRANSFER_EXCEEDS_LIMIT: "TRANSFER_EXCEEDS_LIMIT",
	TRANSFER_UNKNOWN_RECIPIENT: "TRANSFER_UNKNOWN_RECIPIENT",
	TRANSFER_BLOCKED_RECIPIENT: "TRANSFER_BLOCKED_RECIPIENT",
	TRANSFER_MISSING_AMOUNT: "TRANSFER_MISSING_AMOUNT",
	TRANSFER_INVALID_AMOUNT: "TRANSFER_INVALID_AMOUNT",
	TRANSFER_MISSING_RECIPIENT: "TRANSFER_MISSING_RECIPIENT",
	SWAP_WITHIN_POLICY: "SWAP_WITHIN_POLICY",
	SWAP_SLIPPAGE_EXCEEDS_LIMIT: "SWAP_SLIPPAGE_EXCEEDS_LIMIT",
	SWAP_UNKNOWN_TOKEN: "SWAP_UNKNOWN_TOKEN",
	SWAP_UNALLOWED_PROTOCOL: "SWAP_UNALLOWED_PROTOCOL",
	SWAP_EXCEEDS_LIMIT: "SWAP_EXCEEDS_LIMIT",
	SWAP_MISSING_CONTEXT: "SWAP_MISSING_CONTEXT",
	SWAP_INVALID_CONTEXT: "SWAP_INVALID_CONTEXT",
	CONDITIONAL_DEFAULT_REQUIRES_APPROVAL:
		"CONDITIONAL_DEFAULT_REQUIRES_APPROVAL",
	CONDITIONAL_MISSING_CONTEXT: "CONDITIONAL_MISSING_CONTEXT",
	CONDITIONAL_INVALID_CONTEXT: "CONDITIONAL_INVALID_CONTEXT",
	CONDITIONAL_EXPIRED: "CONDITIONAL_EXPIRED",
	CONDITIONAL_ORACLE_UNSAFE: "CONDITIONAL_ORACLE_UNSAFE",
	CONDITIONAL_SLIPPAGE_EXCEEDS_LIMIT:
		"CONDITIONAL_SLIPPAGE_EXCEEDS_LIMIT",
	SIGN_MESSAGE_REQUIRES_APPROVAL: "SIGN_MESSAGE_REQUIRES_APPROVAL",
	SIGN_TRANSACTION_REQUIRES_SIMULATION: "SIGN_TRANSACTION_REQUIRES_SIMULATION",
	DIRECT_SIGN_AND_SEND_BLOCKED: "DIRECT_SIGN_AND_SEND_BLOCKED",
	SIGN_AND_SEND_COMPASS_BUILT_REQUIRES_APPROVAL:
		"SIGN_AND_SEND_COMPASS_BUILT_REQUIRES_APPROVAL",
	BLOCKED_UNKNOWN_PROGRAM: "BLOCKED_UNKNOWN_PROGRAM",
	BLOCKED_UNLIMITED_DELEGATE: "BLOCKED_UNLIMITED_DELEGATE",
	BLOCKED_AUTHORITY_CHANGE: "BLOCKED_AUTHORITY_CHANGE",
	BLOCKED_SUSPICIOUS_RECIPIENT: "BLOCKED_SUSPICIOUS_RECIPIENT",
	UNKNOWN_MUTATING_TOOL_DENIED: "UNKNOWN_MUTATING_TOOL_DENIED",
	UNKNOWN_TOOL_NEEDS_CONTEXT: "UNKNOWN_TOOL_NEEDS_CONTEXT",
	POLICY_DEFAULT: "POLICY_DEFAULT",
	CLASSIFICATION_DECISION_PRESERVED: "CLASSIFICATION_DECISION_PRESERVED",
} as const;

export type PolicyOutcome =
	(typeof POLICY_OUTCOMES)[keyof typeof POLICY_OUTCOMES];

export type PolicyReasonCode =
	(typeof POLICY_REASON_CODES)[keyof typeof POLICY_REASON_CODES];

export type ReadOnlyRules = {
	default: PolicyOutcome;
};

export type TransfersRules = {
	max_usd_without_approval: number;
	require_approval_for_unknown_recipient: boolean;
	blocked_recipients: string[];
};

export type SwapsRules = {
	max_usd_without_approval: number;
	max_slippage_bps: number;
	require_approval_for_unknown_token: boolean;
	allowed_protocols: string[];
};

export type ConditionalBuyRules = {
	default: PolicyOutcome;
	max_slippage_bps: number;
	max_oracle_age_seconds: number;
	max_confidence_bps: number;
};

export type BridgesRules = {
	default: PolicyOutcome;
	max_usd_per_day: number;
	allowed_chains: string[];
};

export type SigningRules = {
	sign_message: PolicyOutcome;
	sign_transaction: PolicyOutcome;
	sign_and_send_transaction: PolicyOutcome;
};

export type BlockedPatterns = {
	unknown_program: PolicyOutcome;
	unlimited_delegate: PolicyOutcome;
	authority_change: PolicyOutcome;
	suspicious_recipient: PolicyOutcome;
};

export type CompassPolicy = {
	policy_id: string;
	version: string;
	default: PolicyOutcome;
	read_only: ReadOnlyRules;
	transfers: TransfersRules;
	swaps: SwapsRules;
	conditional_buys: ConditionalBuyRules;
	bridges: BridgesRules;
	signing: SigningRules;
	blocked: BlockedPatterns;
};

export type PolicyEvaluationContext = {
	amount_usd?: number;
	recipient_address?: string;
	recipient_known?: boolean;
	token_mint?: string;
	token_known?: boolean;
	protocol?: string;
	slippage_bps?: number;
	target_price_usd?: number;
	oracle_feed_pubkey?: string;
	oracle_price_usd?: number;
	oracle_age_seconds?: number;
	max_oracle_age_seconds?: number;
	oracle_confidence_bps?: number;
	max_confidence_bps?: number;
	expires_at_unix?: number;
	current_unix_timestamp?: number;
	compass_built?: boolean;
	flags?: {
		unknown_program?: boolean;
		unlimited_delegate?: boolean;
		authority_change?: boolean;
		suspicious_recipient?: boolean;
	};
};

export type PolicyEvaluation = {
	decision: CompassDecision;
	policyId: string;
	reasonCodes: string[];
	evaluatedRules: string[];
};

export type EvaluateActionInput = {
	candidate: ActionCandidate;
	classification: ToolClassification;
	context: PolicyEvaluationContext;
	policy: CompassPolicy;
};

export type PolicyValidationError = {
	path: string;
	message: string;
};

export type PolicyValidationResult =
	| { ok: true; policy: CompassPolicy }
	| { ok: false; errors: PolicyValidationError[] };
