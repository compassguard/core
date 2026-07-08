import type { HostedDecision } from "@shared/evaluationContracts";
import type { Discrepancy, IntendedEffect } from "@shared/verdictContracts";

export type VerdictStatus = "DECIDED" | "CONFIRMED_MATCH" | "CONFIRMED_MISMATCH";

export type ConfirmOutcome = "match" | "mismatch";

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
	txSignature?: string;
	discrepancies?: Discrepancy[];
	confirmedAt?: string;
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

/**
 * In-memory verdict store keyed by correlationId (single-process / demo / tests).
 * The durable backing (Postgres) is a drop-in swap — see createPgVerdictStore.
 *
 * A verdict has three states: DECIDED (recorded, not yet confirmed), then one terminal
 * CONFIRMED_MATCH or CONFIRMED_MISMATCH. closeOutcome is the sole state transition and is
 * atomic + idempotent — the first close wins and every later caller reads that outcome —
 * so concurrent confirms need no lease.
 */
export function createInMemoryVerdictStore(
	options: VerdictStoreOptions = {},
): VerdictStore {
	const isoNow = options.isoNow ?? (() => new Date().toISOString());
	const records = new Map<string, VerdictRecord>();

	return {
		async putDecided(input: DecidedInput): Promise<void> {
			// Existence guard: the first put for an id wins; a replayed put is inert and never
			// resurrects an already-progressed record (e.g. a CONFIRMED_* one) back to DECIDED.
			if (records.has(input.correlationId)) return;
			records.set(input.correlationId, {
				...input,
				status: "DECIDED",
			});
		},

		async getByCorrelationId(id: string): Promise<VerdictRecord | undefined> {
			return records.get(id);
		},

		async closeOutcome(
			id: string,
			outcome: ConfirmOutcome,
			discrepancies: Discrepancy[],
			txSignature?: string,
		): Promise<VerdictRecord | undefined> {
			const record = records.get(id);
			if (!record) {
				return undefined;
			}
			// Idempotent: an already-closed record returns its cached outcome unchanged.
			if (
				record.status === "CONFIRMED_MATCH" ||
				record.status === "CONFIRMED_MISMATCH"
			) {
				return record;
			}
			const closed: VerdictRecord = {
				...record,
				status: outcome === "match" ? "CONFIRMED_MATCH" : "CONFIRMED_MISMATCH",
				discrepancies,
				confirmedAt: isoNow(),
				// Persist the confirming tx link (#14a); only overwrite when provided so a
				// caller omitting it never clobbers an already-set signature.
				txSignature: txSignature ?? record.txSignature,
			};
			records.set(id, closed);
			return closed;
		},

		async list(limit?: number): Promise<VerdictRecord[]> {
			const all = [...records.values()];
			return limit === undefined ? all : limit <= 0 ? [] : all.slice(-limit);
		},
	};
}
