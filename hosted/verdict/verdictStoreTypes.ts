import type { HostedDecision } from "@shared/evaluationContracts";
import type { IntentSource } from "@shared/mandateContracts";
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
