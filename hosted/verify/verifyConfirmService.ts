import type {
	ActualEffect,
	DeriveActualEffect,
	Discrepancy,
} from "@shared/verdictContracts";

import type { VerdictRecord, VerdictStore } from "../verdict/verdictStore";
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
 * Map a (possibly absent) verdict record to its API outcome + discrepancies (D19).
 * Pure and lease-independent — the leaseless confirm reuses it verbatim for both the
 * already-closed cached read and the post-close response. Fail-closed: a missing record
 * OR any non-terminal status yields `error`, never a fabricated verdict.
 */
function outcomeFromRecord(record: VerdictRecord | undefined): {
	outcome: VerifyConfirmOutcome;
	discrepancies: Discrepancy[];
} {
	if (record?.status === "CONFIRMED_MATCH") {
		return { outcome: "match", discrepancies: record.discrepancies ?? [] };
	}
	if (record?.status === "CONFIRMED_MISMATCH") {
		return { outcome: "mismatch", discrepancies: record.discrepancies ?? [] };
	}
	return { outcome: "error", discrepancies: [] };
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

			// Already closed → #14b signature check, then the cached outcome.
			if (
				record.status === "CONFIRMED_MATCH" ||
				record.status === "CONFIRMED_MISMATCH"
			) {
				// #14b: one correlationId = one execution. A repeat confirm carrying a
				// DIFFERENT signature than the one this record was closed with is not the
				// transaction we verified — surface it, don't return the cached verdict for
				// another tx. (Same signature → cached outcome, idempotent, unchanged.)
				if (
					record.txSignature !== undefined &&
					record.txSignature !== txSignature
				) {
					return {
						correlationId,
						outcome: "signature_mismatch",
						discrepancies: [],
					};
				}
				return { correlationId, ...outcomeFromRecord(record) };
			}

			// Still open (DECIDED, or a legacy durable CONFIRMING row) — retryable, no lease.
			const tx = await getConfirmedTx(txSignature);
			if (!tx) {
				// Leaves the record DECIDED so a later confirm can retry.
				return { correlationId, outcome: "unconfirmed", discrepancies: [] };
			}
			if (tx.meta?.err) {
				// Confirmed but FAILED on-chain (D5-v2/D9-v2): the intended action did not
				// execute. Terminal close (fail-closed), NOT re-poll. The record closes
				// CONFIRMED_MISMATCH; this detecting call returns the precise signal.
				await verdictStore.closeOutcome(
					correlationId,
					"mismatch",
					[],
					request.txSignature,
				);
				return { correlationId, outcome: "execution_failed", discrepancies: [] };
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
			// and txSignature is stored (#14a).
			const closed = await verdictStore.closeOutcome(
				correlationId,
				outcome,
				discrepancies,
				request.txSignature,
			);
			// #14b under concurrency: if we lost the close race to a DIFFERENT-signature
			// confirm, the returned winner is bound to another tx — surface it, don't return
			// its verdict for a signature we did not verify.
			if (
				closed?.txSignature !== undefined &&
				closed.txSignature !== request.txSignature
			) {
				return {
					correlationId,
					outcome: "signature_mismatch",
					discrepancies: [],
				};
			}
			return { correlationId, ...outcomeFromRecord(closed) };
		},
	};
}
