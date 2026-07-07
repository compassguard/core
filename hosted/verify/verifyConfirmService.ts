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
 * Pure and lease-independent, so workstream A's simplified getByCorrelationId-based
 * confirm can reuse it verbatim once the claim-switch is deleted. Fail-closed: a
 * missing record OR any non-terminal status yields `error`, never a fabricated verdict.
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
 * Phase-2 outcome verification (D16-v3). Every exit disposes the claimed record —
 * close on a real outcome, release on unconfirmed/unverified/error — so a CONFIRMING
 * record is always transient (the store's lease covers process death mid-flight).
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

			const claim = await verdictStore.claim(correlationId);

			if (claim === "unknown") {
				return { correlationId, outcome: "unknown_correlation", discrepancies: [] };
			}
			if (claim === "already_closed") {
				const record = await verdictStore.getByCorrelationId(correlationId);
				// #14b: one correlationId = one execution. A repeat confirm carrying a
				// DIFFERENT signature than the one this record was closed with is not the
				// transaction we verified — surface it, don't return the cached verdict for
				// another tx. (Same signature → cached outcome, idempotent, unchanged.)
				if (
					record?.txSignature !== undefined &&
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
			if (claim === "in_progress") {
				return { correlationId, outcome: "pending", discrepancies: [] };
			}

			// claim === "claimed": we hold the lease; every path below closes or releases.
			try {
				const record = await verdictStore.getByCorrelationId(correlationId);
				if (!record) {
					await verdictStore.release(correlationId);
					return {
						correlationId,
						outcome: "unknown_correlation",
						discrepancies: [],
					};
				}

				const tx = await getConfirmedTx(txSignature);
				if (!tx) {
					await verdictStore.release(correlationId);
					return { correlationId, outcome: "unconfirmed", discrepancies: [] };
				}
				if (tx.meta?.err) {
					// Confirmed but FAILED on-chain (D5-v2/D9-v2): the intended action did not
					// execute. Terminal close (fail-closed), NOT release, NOT re-poll. The record
					// closes CONFIRMED_MISMATCH; this detecting call returns the precise signal.
					await verdictStore.closeOutcome(
						correlationId,
						"mismatch",
						[],
						request.txSignature,
					);
					return {
						correlationId,
						outcome: "execution_failed",
						discrepancies: [],
					};
				}

				const actual = deriveActualEffect(tx, record.intendedEffect);
				if (isEffectUnavailable(actual)) {
					await verdictStore.release(correlationId);
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
				// Derive the response from the record the store returns (D7/D8): the HTTP
				// outcome can never diverge from what was persisted, and txSignature is stored.
				const closed = await verdictStore.closeOutcome(
					correlationId,
					outcome,
					discrepancies,
					request.txSignature,
				);
				return { correlationId, ...outcomeFromRecord(closed) };
			} catch (error) {
				await verdictStore.release(correlationId);
				throw error;
			}
		},
	};
}
