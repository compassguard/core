import type { DeriveActualEffect } from "@shared/verdictContracts";

import type { VerdictStore } from "../verdict/verdictStore";
import { compareEffects } from "./compareEffects";
import type { GetConfirmedTx } from "./getConfirmedTx";
import type {
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
				return {
					correlationId,
					outcome:
						record?.status === "CONFIRMED_MATCH" ? "match" : "mismatch",
					discrepancies: record?.discrepancies ?? [],
				};
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

				const actual = deriveActualEffect(tx, record.intendedEffect);
				if (actual.unavailable) {
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
				await verdictStore.closeOutcome(correlationId, outcome, discrepancies);
				return { correlationId, outcome, discrepancies };
			} catch (error) {
				await verdictStore.release(correlationId);
				throw error;
			}
		},
	};
}
