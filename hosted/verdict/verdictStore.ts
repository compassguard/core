import type { HostedDecision } from "@shared/evaluationContracts";
import type { Discrepancy, IntendedEffect } from "@shared/verdictContracts";

export type VerdictStatus =
	| "DECIDED"
	| "CONFIRMING"
	| "CONFIRMED_MATCH"
	| "CONFIRMED_MISMATCH";

export type ConfirmOutcome = "match" | "mismatch";

export type VerdictRecord = {
	correlationId: string;
	decision: HostedDecision;
	reasons: string[];
	humanExplanation: string;
	intendedEffect: IntendedEffect;
	status: VerdictStatus;
	decidedAt: string;
	txSignature?: string;
	discrepancies?: Discrepancy[];
	confirmedAt?: string;
	/** Lease timestamp (epoch ms) set when a confirm claims the record. */
	claimedAt?: number;
};

export type DecidedInput = {
	correlationId: string;
	decision: HostedDecision;
	reasons: string[];
	humanExplanation: string;
	intendedEffect: IntendedEffect;
	decidedAt: string;
};

/**
 * claim() outcomes:
 * - "claimed"        — the caller now holds the lease; proceed to fetch+derive+close.
 * - "in_progress"    — a fresh lease is held by a concurrent confirm; do not double-fetch.
 * - "already_closed" — the record already has a CONFIRMED_* outcome; return it cached.
 * - "unknown"        — no record for this correlationId.
 */
export type ClaimResult = "claimed" | "already_closed" | "in_progress" | "unknown";

export type VerdictStore = {
	putDecided(input: DecidedInput): Promise<void>;
	getByCorrelationId(id: string): Promise<VerdictRecord | undefined>;
	claim(id: string): Promise<ClaimResult>;
	release(id: string): Promise<void>;
	closeOutcome(
		id: string,
		outcome: ConfirmOutcome,
		discrepancies: Discrepancy[],
		txSignature?: string,
	): Promise<VerdictRecord | undefined>;
	list(limit?: number): Promise<VerdictRecord[]>;
};

export type VerdictStoreOptions = {
	/** Injectable clock (epoch ms) for testable lease expiry. Defaults to Date.now. */
	now?: () => number;
	/** A CONFIRMING lease older than this is reclaimable (self-healing). */
	leaseTtlMs?: number;
	/** ISO timestamp source for confirmedAt. Defaults to new Date().toISOString(). */
	isoNow?: () => string;
};

/**
 * In-memory verdict store keyed by correlationId (single-process / demo / tests).
 * The durable backing (SQLite / KV) is the WS1 swap — see D15/D25 in the run tracker.
 *
 * The claim/release/closeOutcome lifecycle keeps CONFIRMING transient: a confirm that
 * dies mid-flight leaves a stale lease that the next confirm reclaims after leaseTtlMs,
 * so a record never strands (D15-v3 / F45).
 */
export function createInMemoryVerdictStore(
	options: VerdictStoreOptions = {},
): VerdictStore {
	const now = options.now ?? (() => Date.now());
	const isoNow = options.isoNow ?? (() => new Date().toISOString());
	const leaseTtlMs = options.leaseTtlMs ?? 20_000;
	const records = new Map<string, VerdictRecord>();

	function isLeaseStale(record: VerdictRecord): boolean {
		return (
			record.claimedAt === undefined || now() - record.claimedAt >= leaseTtlMs
		);
	}

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

		// Synchronous read-and-set (no await between read and write) → atomic under the
		// single-threaded event loop, so concurrent confirms cannot both take the lease.
		async claim(id: string): Promise<ClaimResult> {
			const record = records.get(id);
			if (!record) {
				return "unknown";
			}
			if (
				record.status === "CONFIRMED_MATCH" ||
				record.status === "CONFIRMED_MISMATCH"
			) {
				return "already_closed";
			}
			if (record.status === "CONFIRMING" && !isLeaseStale(record)) {
				return "in_progress";
			}
			// DECIDED, or a CONFIRMING record whose lease has gone stale → (re)claim it.
			records.set(id, { ...record, status: "CONFIRMING", claimedAt: now() });
			return "claimed";
		},

		async release(id: string): Promise<void> {
			const record = records.get(id);
			if (!record || record.status !== "CONFIRMING") {
				return;
			}
			const { claimedAt: _claimedAt, ...rest } = record;
			records.set(id, { ...rest, status: "DECIDED" });
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
			const { claimedAt: _claimedAt, ...rest } = record;
			const closed: VerdictRecord = {
				...rest,
				status: outcome === "match" ? "CONFIRMED_MATCH" : "CONFIRMED_MISMATCH",
				discrepancies,
				confirmedAt: isoNow(),
				// Persist the confirming tx link (#14a); only overwrite when provided so a
				// caller omitting it never clobbers an already-set signature.
				txSignature: txSignature ?? rest.txSignature,
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
