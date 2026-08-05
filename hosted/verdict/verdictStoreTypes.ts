import type { HostedDecision } from "@shared/evaluationContracts";
import type { ToolClassification } from "@shared/executionGatewayContracts";
import type { IntentSource, Mandate } from "@shared/mandateContracts";
import type { CompassPolicy, PolicyEvaluationContext } from "@shared/policyContracts";
import type { Discrepancy, IntendedEffect } from "@shared/verdictContracts";

/**
 * Canonical VerdictStore contracts (type-only). Kept separate from the in-memory
 * implementation (verdictStore.ts) and the durable one (verdictStorePg.ts) so every backing
 * and every consumer depends on the shape, not on a concrete store.
 */

export type VerdictStatus = "DECIDED" | "CONFIRMED_MATCH" | "CONFIRMED_MISMATCH";

/**
 * The terminal result of a confirm. `execution_failed` (tx confirmed but reverted on-chain)
 * and `mismatch` (executed but effect diverged) are DIFFERENT real-world states that both map
 * to the CONFIRMED_MISMATCH status — so status alone cannot tell them apart. closeOutcome
 * persists this value so the distinction survives restarts and idempotent re-confirms.
 */
export type ConfirmOutcome = "match" | "mismatch" | "execution_failed";

export type VerdictRecord = {
	correlationId: string;
	decision: HostedDecision;
	reasons: string[];
	humanExplanation: string;
	intendedEffect: IntendedEffect;
	status: VerdictStatus;
	decidedAt: string;
	/** Attribution carried from the /verify request, so a verdict is groupable by who/which session. */
	userId?: string;
	sessionId?: string;
	/** Credential-derived caller identity (trustworthy); distinct from self-reported userId. */
	authenticatedEmail?: string;
	txSignature?: string;
	discrepancies?: Discrepancy[];
	confirmedAt?: string;
	/**
	 * The persisted confirm outcome. Preserves `execution_failed` vs `mismatch`, which the
	 * CONFIRMED_MISMATCH status collapses. Absent on legacy rows closed before this field
	 * existed; readers infer it from status (CONFIRMED_MISMATCH → mismatch) in that case.
	 */
	confirmOutcome?: ConfirmOutcome;
	/** Which check ran for this decision (seam-doc degraded modes). Absent on legacy
	    records ⇒ readers treat as "none". */
	intentSource?: IntentSource;
	/** The mandate judge's rationale, when it ran (audit/flywheel value). */
	judgeRationale?: string;
	/** The tool name the caller invoked — the classification input for deterministic replay. */
	toolName?: string;
	/**
	 * The derived PolicyEvaluationContext the rules evaluated (typed, bounded — never raw
	 * args). With toolName + policyId/policyVersion this makes the deterministic leg of the
	 * verdict replayable from the row alone.
	 */
	policyContext?: PolicyEvaluationContext;
	/** The caller's untrusted stated purpose, verbatim from the /verify request. */
	statedPurpose?: string;
	/**
	 * The mandate as it read at decision time. The mandate store overwrites in place
	 * (latest-wins upsert), so without this snapshot a verdict judged under an
	 * since-edited mandate is unreconstructable. Present whenever a mandate was found —
	 * including the judge_unavailable path (what the judge SHOULD have judged against).
	 */
	mandateSnapshot?: Mandate;
	/** Identity of the policy that evaluated this verdict (CompassPolicy.policy_id). */
	policyId?: string;
	/** CompassPolicy.version at decision time. */
	policyVersion?: string;
	/**
	 * The policy CONTENT as it read at decision time — the thresholds and rule values the
	 * engine actually compared against, not just its identity. policyId/policyVersion name
	 * the rulebook; only this snapshot carries what was written in it. The default policy is
	 * a compiled-in constant (hosted/policy/defaultPolicy.ts) that can be edited without a
	 * version bump, so identity alone cannot detect drift: an edited threshold under an
	 * unchanged version replays a verdict that never happened. Same principle as
	 * mandateSnapshot (plan D1: an audit row records what the decider saw).
	 */
	policySnapshot?: CompassPolicy;
	/**
	 * The ToolClassification the engine evaluated — riskClass, defaultDecision, auditRequired
	 * and its reason codes, as they read at decision time. classifyToolCall() derives these
	 * from compiled-in tool sets (back/guardrail/execution/executionGateway.ts
	 * SENSITIVE_EXECUTION_TOOLS / SIGNING_TOOLS), so re-deriving from toolName alone reads
	 * TODAY's sets: dropping a tool from SENSITIVE_EXECUTION_TOOLS silently reclassifies every
	 * past verdict for it. Same drift class as policySnapshot (D4a) — the second compiled-in
	 * input to a decision.
	 */
	toolClassification?: ToolClassification;
	/** The rule paths the policy engine actually evaluated for this decision. */
	evaluatedRules?: string[];
	/**
	 * The policy engine's pre-judge CompassDecision (e.g. REQUIRE_HUMAN_APPROVAL), before
	 * collapse and before any judge input. With the final `decision`, this attributes the
	 * outcome: rules-only when they match, judge-tightened when they differ.
	 */
	deterministicDecision?: string;
	/** Concrete LLM model id the judge call used, when it ran. */
	judgeModel?: string;
	/**
	 * The judge's UNCLAMPED decision, verbatim from the model. The stored `decision` is
	 * post-clamp and hosted-collapsed (REQUIRE_* states merge into "review"), so this is
	 * the only record of what the model actually said — e.g. a loosening ALLOW the
	 * strictness clamp discarded.
	 */
	judgeRawDecision?: string;
	/**
	 * True when the judge's raw decision diverged from the deterministic one — a tighten
	 * that was honored, or a loosening the strictness clamp discarded (compare
	 * judgeRawDecision against deterministicDecision to tell which).
	 */
	judgeClamped?: boolean;
	/** The judge's self-reported confidence (0..1), when it ran. */
	judgeConfidence?: number;
	/**
	 * The judge's own reason codes — its contribution to the merged `reasons`.
	 * judgeReasonCodes is the judge's verbatim output; codes it shares with the
	 * deterministic set appear once in the merged reasons (deduped at the merge point).
	 */
	judgeReasonCodes?: string[];
};

export type DecidedInput = {
	correlationId: string;
	decision: HostedDecision;
	reasons: string[];
	humanExplanation: string;
	intendedEffect: IntendedEffect;
	decidedAt: string;
	/** Attribution from the /verify request (optional; omitted when the caller sends neither). */
	userId?: string;
	sessionId?: string;
	/** Credential-derived caller identity (trustworthy); distinct from self-reported userId. */
	authenticatedEmail?: string;
	/** Which check ran for this decision (seam-doc degraded modes). Absent on legacy
	    records ⇒ readers treat as "none". */
	intentSource?: IntentSource;
	/** The mandate judge's rationale, when it ran (audit/flywheel value). */
	judgeRationale?: string;
	/** The tool name the caller invoked (see VerdictRecord). */
	toolName?: string;
	/** The derived PolicyEvaluationContext the rules evaluated (see VerdictRecord). */
	policyContext?: PolicyEvaluationContext;
	/** The caller's untrusted stated purpose, verbatim from the /verify request. */
	statedPurpose?: string;
	/** The mandate as it read at decision time (see VerdictRecord.mandateSnapshot). */
	mandateSnapshot?: Mandate;
	/** Identity of the policy that evaluated this verdict (CompassPolicy.policy_id). */
	policyId?: string;
	/** CompassPolicy.version at decision time. */
	policyVersion?: string;
	/** The policy content as it read at decision time (see VerdictRecord.policySnapshot). */
	policySnapshot?: CompassPolicy;
	/** The ToolClassification evaluated at decision time (see VerdictRecord). */
	toolClassification?: ToolClassification;
	/** The rule paths the policy engine actually evaluated for this decision. */
	evaluatedRules?: string[];
	/** The policy engine's pre-judge CompassDecision (see VerdictRecord). */
	deterministicDecision?: string;
	/** Concrete LLM model id the judge call used, when it ran. */
	judgeModel?: string;
	/** The judge's unclamped decision, verbatim from the model (see VerdictRecord). */
	judgeRawDecision?: string;
	/** True when the judge's raw decision diverged from the deterministic one (see VerdictRecord). */
	judgeClamped?: boolean;
	/** The judge's self-reported confidence (0..1), when it ran. */
	judgeConfidence?: number;
	/** The judge's own reason codes — its contribution to the merged `reasons`. */
	judgeReasonCodes?: string[];
};

export type VerdictStore = {
	putDecided(input: DecidedInput): Promise<void>;
	getByCorrelationId(id: string): Promise<VerdictRecord | undefined>;
	closeOutcome(
		id: string,
		outcome: ConfirmOutcome,
		discrepancies: Discrepancy[],
		txSignature?: string,
	): Promise<VerdictRecord | undefined>;
	list(limit?: number): Promise<VerdictRecord[]>;
};

export type VerdictStoreOptions = {
	/** ISO timestamp source for confirmedAt. Defaults to new Date().toISOString(). */
	isoNow?: () => string;
};
