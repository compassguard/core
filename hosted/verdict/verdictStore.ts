import type { Discrepancy } from "@shared/verdictContracts";

import type {
	ConfirmOutcome,
	DecidedInput,
	VerdictRecord,
	VerdictStore,
	VerdictStoreOptions,
} from "./verdictStoreTypes";

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
				// execution_failed and mismatch share the CONFIRMED_MISMATCH status; confirmOutcome
				// keeps them distinct.
				status: outcome === "match" ? "CONFIRMED_MATCH" : "CONFIRMED_MISMATCH",
				confirmOutcome: outcome,
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
