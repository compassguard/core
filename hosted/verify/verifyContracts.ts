import type {
	HostedDecision,
	HostedRiskLevel,
} from "@shared/evaluationContracts";

export type VerifyIntent = {
	kind: "transfer" | "swap";
};

export type VerifyActionRequest = {
	toolName: string;
	arguments?: Record<string, unknown>;
	/** Declared intent kind; drives the deterministic policy path (no LLM router). */
	intent?: VerifyIntent;
	/** ISO timestamp; defaults to server time when omitted. */
	requestedAt?: string;
	userId?: string;
	sessionId?: string;
};

export type VerifyActionResponse = {
	/** Server-generated; the caller passes this to POST /v1/verify/confirm. */
	correlationId: string;
	decision: HostedDecision;
	riskLevel: HostedRiskLevel;
	reasons: string[];
	humanExplanation: string;
};

export type VerifyActionRequestValidationResult =
	| { ok: true; request: VerifyActionRequest }
	| { ok: false; message: string };

/** Server-derived caller context, kept separate from the validated request body (D11). */
export type VerifyCaller = { authenticatedEmail?: string };

export type VerifyService = {
	verifyAction(
		request: VerifyActionRequest,
		caller?: VerifyCaller,
	): Promise<VerifyActionResponse>;
};
