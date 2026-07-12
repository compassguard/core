import type {
	ActualEffect,
	DeriveActualEffect,
	Discrepancy,
} from "@shared/verdictContracts";

import type {
	ConfirmOutcome,
	VerdictRecord,
	VerdictStore,
} from "../verdict/verdictStoreTypes";
import { compareEffects } from "./compareEffects";
import type { GetConfirmedTx } from "./getConfirmedTx";
import type {
	VerifyConfirmOutcome,
	VerifyConfirmRequest,
	VerifyConfirmResponse,
	VerifyConfirmService,
} from "./verifyConfirmContracts";

export type VerifyConfirmServiceDependencies = {
	verdictStore: VerdictStore;
	getConfirmedTx: GetConfirmedTx;
	deriveActualEffect: DeriveActualEffect;
};

/**
 * The confirm outcome of a terminal record, inferring it from status for a legacy row closed
 * before confirmOutcome was persisted. execution_failed is indistinguishable from mismatch at
 * the status level, so a legacy CONFIRMED_MISMATCH degrades to `mismatch` — the safe reading
 * (never fabricates the stronger execution_failed signal). A non-terminal record → undefined.
 */
function confirmOutcomeOf(record: VerdictRecord): ConfirmOutcome | undefined {
	if (record.confirmOutcome !== undefined) return record.confirmOutcome;
	if (record.status === "CONFIRMED_MATCH") return "match";
	if (record.status === "CONFIRMED_MISMATCH") return "mismatch";
	return undefined;
}

/**
 * Map a (possibly absent) verdict record to its API outcome + discrepancies (D19), reading the
 * persisted confirmOutcome so execution_failed survives an idempotent re-confirm instead of
 * degrading to mismatch (#2). Fail-closed: a missing record OR a non-terminal one yields
 * `error`, never a fabricated verdict.
 */
function outcomeFromRecord(record: VerdictRecord | undefined): {
	outcome: VerifyConfirmOutcome;
	discrepancies: Discrepancy[];
} {
	if (!record) return { outcome: "error", discrepancies: [] };
	switch (confirmOutcomeOf(record)) {
		case "match":
			return { outcome: "match", discrepancies: record.discrepancies ?? [] };
		case "mismatch":
			return { outcome: "mismatch", discrepancies: record.discrepancies ?? [] };
		case "execution_failed":
			return { outcome: "execution_failed", discrepancies: [] };
		default:
			return { outcome: "error", discrepancies: [] };
	}
}

/**
 * Build the API response from the record a close (or cached read) resolved to. Because
 * closeOutcome is first-writer-wins, the resolved record may be a CONCURRENT confirm's winner,
 * so every closed-record response must, in one place (#1/#5):
 *   (a) fail closed to `error` when the record is absent (store inconsistency),
 *   (b) surface `signature_mismatch` (#14b) when the winning record is bound to a DIFFERENT
 *       signature than this request verified — we must not speak for another tx's verdict,
 *   (c) otherwise report the persisted confirm outcome.
 * Shared by the already-closed, normal-close, and failed-tx paths so the invariant cannot drift.
 */
function respondFromClosedRecord(
	correlationId: string,
	record: VerdictRecord | undefined,
	requestTxSignature: string,
): VerifyConfirmResponse {
	if (!record) {
		return { correlationId, outcome: "error", discrepancies: [] };
	}
	if (
		record.txSignature !== undefined &&
		record.txSignature !== requestTxSignature
	) {
		return { correlationId, outcome: "signature_mismatch", discrepancies: [] };
	}
	return { correlationId, ...outcomeFromRecord(record) };
}

/** Narrow the ActualEffect union to its unavailable variant (D13, clears TS2345). */
function isEffectUnavailable(e: ActualEffect): e is { unavailable: true } {
	return e.unavailable === true;
}

/**
 * Phase-2 outcome verification, leaseless: read the record, and while it is still open
 * fetch + derive + compare, then close it with an atomic first-writer-wins closeOutcome —
 * the sole concurrency guarantee, with no claim/release lease and no CONFIRMING state.
 * unconfirmed and unverified_no_decoder leave the record DECIDED (retryable); an error
 * mid-confirm simply propagates, and the record stays DECIDED-retryable.
 */
export function createVerifyConfirmService(
	deps: VerifyConfirmServiceDependencies,
): VerifyConfirmService {
	const { verdictStore, getConfirmedTx, deriveActualEffect } = deps;

	return {
		async verifyConfirm(
			request: VerifyConfirmRequest,
		): Promise<VerifyConfirmResponse> {
			const { correlationId, txSignature } = request;

			const record = await verdictStore.getByCorrelationId(correlationId);
			if (!record) {
				return { correlationId, outcome: "unknown_correlation", discrepancies: [] };
			}

			// Already closed → shared closed-record response (#14b signature check + cached
			// outcome). Same signature → cached outcome (idempotent, unchanged).
			if (
				record.status === "CONFIRMED_MATCH" ||
				record.status === "CONFIRMED_MISMATCH"
			) {
				return respondFromClosedRecord(correlationId, record, txSignature);
			}

			// Still open (DECIDED, or a legacy durable CONFIRMING row) — retryable, no lease. A
			// CONFIRMING row is treated as open and closed here; this leaseless code does NOT honor
			// an ACTIVE lease, so a rollback to a lease-bearing version MUST be non-overlapping
			// (drain leaseless instances first). Overlap only costs a duplicate fetch+close race,
			// never a wrong verdict (the atomic first-writer-wins close is the guarantee) — the
			// constraint just keeps that waste out of the rollback window. See proposal.md registry.
			const tx = await getConfirmedTx(txSignature);
			if (!tx) {
				// Leaves the record DECIDED so a later confirm can retry.
				return { correlationId, outcome: "unconfirmed", discrepancies: [] };
			}
			if (tx.meta?.err) {
				// Confirmed but FAILED on-chain (D5-v2/D9-v2): the intended action did not
				// execute. Terminal close (fail-closed), NOT re-poll. Persisted as the distinct
				// execution_failed outcome so an idempotent retry stays execution_failed (#2).
				// Routed through the shared responder so a lost close-race to a different-signature
				// confirm surfaces as signature_mismatch — not this signal for a tx we didn't win (#1).
				const closed = await verdictStore.closeOutcome(
					correlationId,
					"execution_failed",
					[],
					request.txSignature,
				);
				return respondFromClosedRecord(correlationId, closed, request.txSignature);
			}

			const actual = deriveActualEffect(tx, record.intendedEffect);
			if (isEffectUnavailable(actual)) {
				// Leaves the record DECIDED so a decoder-equipped retry can still verify.
				return {
					correlationId,
					outcome: "unverified_no_decoder",
					discrepancies: [],
				};
			}

			const { outcome, discrepancies } = compareEffects(
				record.intendedEffect,
				actual,
			);
			// Atomic first-writer-wins close; the response derives from the record the store
			// returns (D7/D8), so the HTTP outcome can never diverge from what was persisted
			// and txSignature is stored (#14a). The shared responder applies the #14b guard.
			const closed = await verdictStore.closeOutcome(
				correlationId,
				outcome,
				discrepancies,
				request.txSignature,
			);
			return respondFromClosedRecord(correlationId, closed, request.txSignature);
		},
	};
}
