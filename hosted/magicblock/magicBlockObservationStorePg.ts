import {
	canonicalJson,
	hasExactKeys,
	isCanonicalSolanaPublicKey,
	isCanonicalTimestamp,
	isDigest,
	isOpaqueIdentifier,
} from "@back/services/magicBlockDevnetPreflightCanonical";
import {
	MAGICBLOCK_OBSERVATION_RESULT_SCHEMA,
	type MagicBlockDevnetObservationResultV1,
	type MagicBlockObservationStore,
} from "@back/services/magicBlockDevnetObservationContracts";

import type { SqlExecutor } from "../verdict/verdictStorePg";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS magicblock_devnet_observations (
	observation_id text PRIMARY KEY,
	request_digest text NOT NULL,
	status text NOT NULL CHECK (status IN ('pending', 'completed')),
	result jsonb,
	received_at text NOT NULL,
	claimed_at text NOT NULL,
	claim_attempts integer NOT NULL DEFAULT 1,
	completed_at text
)`;
const MIGRATIONS = [
	`ALTER TABLE magicblock_devnet_observations ADD COLUMN IF NOT EXISTS claimed_at text`,
	`ALTER TABLE magicblock_devnet_observations ADD COLUMN IF NOT EXISTS claim_attempts integer NOT NULL DEFAULT 1`,
];

export function createPgMagicBlockObservationStore(input: {
	readonly sql: SqlExecutor;
}): MagicBlockObservationStore {
	const { sql } = input;
	let ensured: Promise<void> | undefined;

	function ensureSchema(): Promise<void> {
		if (ensured) return ensured;
		const pending = doEnsure();
		ensured = pending;
		pending.catch(() => {
			if (ensured === pending) ensured = undefined;
		});
		return pending;
	}
	async function doEnsure(): Promise<void> {
		try {
			await sql(CREATE_TABLE, []);
		} catch (error) {
			const probe = await sql(
				`SELECT to_regclass('magicblock_devnet_observations') AS t`,
				[],
			);
			if (probe[0]?.t == null) throw error;
		}
		for (const migration of MIGRATIONS) await sql(migration, []);
	}

	async function run(text: string, params: unknown[]) {
		await ensureSchema();
		return sql(text, params);
	}

	return {
		async claim(claimInput) {
			validateClaimInput(claimInput);
			const inserted = await run(
				`INSERT INTO magicblock_devnet_observations
					(observation_id, request_digest, status, received_at, claimed_at)
				VALUES ($1, $2, 'pending', $3, $3)
				ON CONFLICT (observation_id) DO UPDATE SET
					claimed_at = EXCLUDED.claimed_at,
					claim_attempts = magicblock_devnet_observations.claim_attempts + 1
				WHERE magicblock_devnet_observations.request_digest = EXCLUDED.request_digest
					AND magicblock_devnet_observations.status = 'pending'
					AND COALESCE(
						magicblock_devnet_observations.claimed_at,
						magicblock_devnet_observations.received_at
					) <= $4
				RETURNING observation_id, claim_attempts`,
				[
					claimInput.observationId,
					claimInput.requestDigest,
					claimInput.receivedAt,
					claimInput.staleBefore,
				],
			);
			if (inserted.length === 1) {
				const claimAttempt = Number(inserted[0]?.claim_attempts);
				validateClaimAttempt(claimAttempt);
				return { status: "claimed", claimAttempt };
			}

			const rows = await sql(
				`SELECT request_digest, status, result
				FROM magicblock_devnet_observations
				WHERE observation_id = $1`,
				[claimInput.observationId],
			);
			const row = rows[0];
			if (!row) {
				throw new Error("observation unavailable");
			}
			if (row.request_digest !== claimInput.requestDigest) {
				return { status: "conflict" };
			}
			if (row.status === "pending" && row.result == null) return { status: "pending" };
			if (row.status !== "completed" || row.result == null) {
				throw new Error("observation unavailable");
			}
			return {
				status: "completed",
				result: validateStoredResult(parseJsonb(row.result), claimInput.observationId),
			};
		},

		async complete(completeInput) {
			validateClaimAttempt(completeInput.claimAttempt);
			validateClaimInput({
				observationId: completeInput.observationId,
				requestDigest: completeInput.requestDigest,
				receivedAt: completeInput.completedAt,
				staleBefore: completeInput.completedAt,
			});
			const result = validateStoredResult(
				completeInput.result,
				completeInput.observationId,
			);
			const updated = await run(
				`UPDATE magicblock_devnet_observations
				SET status = 'completed', result = $3::jsonb, completed_at = $4
				WHERE observation_id = $1
					AND request_digest = $2
					AND claim_attempts = $5
					AND status = 'pending'
					AND result IS NULL
				RETURNING observation_id`,
				[
					completeInput.observationId,
					completeInput.requestDigest,
					result,
					completeInput.completedAt,
					completeInput.claimAttempt,
				],
			);
			if (updated.length === 1) return;

			const rows = await sql(
				`SELECT request_digest, claim_attempts, status, result
				FROM magicblock_devnet_observations
				WHERE observation_id = $1`,
				[completeInput.observationId],
			);
			const row = rows[0];
			if (
				!row ||
				row.request_digest !== completeInput.requestDigest ||
				Number(row.claim_attempts) !== completeInput.claimAttempt ||
				row.status !== "completed" ||
				row.result == null ||
				canonicalJson(
					validateStoredResult(parseJsonb(row.result), completeInput.observationId),
				) !== canonicalJson(result)
			) {
				throw new Error("observation unavailable");
			}
		},
	};
}

function validateClaimAttempt(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error("observation unavailable");
	}
}

function validateClaimInput(input: {
	readonly observationId: string;
	readonly requestDigest: string;
	readonly receivedAt: string;
	readonly staleBefore: string;
}): void {
	if (
		!isOpaqueIdentifier(input.observationId) ||
		!isDigest(input.requestDigest) ||
		!isCanonicalTimestamp(input.receivedAt) ||
		!isCanonicalTimestamp(input.staleBefore) ||
		input.staleBefore > input.receivedAt
	) {
		throw new Error("observation unavailable");
	}
}

function validateStoredResult(
	value: unknown,
	observationId: string,
): MagicBlockDevnetObservationResultV1 {
	if (
		!hasExactKeys(value, ["schemaVersion", "observationId", "outcome"]) &&
		!hasExactKeys(value, ["schemaVersion", "observationId", "outcome", "audit"])
	) {
		throw new Error("observation unavailable");
	}
	if (
		value.schemaVersion !== MAGICBLOCK_OBSERVATION_RESULT_SCHEMA ||
		value.observationId !== observationId
	) {
		throw new Error("observation unavailable");
	}
	if (value.outcome === "unavailable") {
		if (!hasExactKeys(value, ["schemaVersion", "observationId", "outcome"])) {
			throw new Error("observation unavailable");
		}
		return value as MagicBlockDevnetObservationResultV1;
	}
	if (
		!["review_required", "incompatible"].includes(value.outcome as string) ||
		!hasExactKeys(value.audit, [
			"auditEventId",
			"attestationDigest",
			"resultDigest",
			"previousLedgerDigest",
			"ledgerDigest",
			"registration",
		]) ||
		!isOpaqueIdentifier(value.audit.auditEventId) ||
		!isDigest(value.audit.attestationDigest) ||
		!isDigest(value.audit.resultDigest) ||
		!isDigest(value.audit.previousLedgerDigest) ||
		!isDigest(value.audit.ledgerDigest) ||
		!hasExactKeys(value.audit.registration, [
			"status",
			"cluster",
			"routerUrl",
			"signature",
			"signer",
			"slot",
			"commitmentDigest",
			"memo",
			"verifiedAt",
		]) ||
		!isStoredConfirmedRegistration(
			value.audit.registration,
			value.audit.auditEventId,
			value.audit.previousLedgerDigest,
			value.audit.ledgerDigest,
			value.outcome as "review_required" | "incompatible",
		)
	) {
		throw new Error("observation unavailable");
	}
	return value as MagicBlockDevnetObservationResultV1;
}

function isStoredConfirmedRegistration(
	value: Record<string, unknown>,
	auditEventId: string,
	previousLedgerDigest: string,
	ledgerDigest: string,
	outcome: "review_required" | "incompatible",
): boolean {
	if (
		value.status !== "confirmed" ||
		value.cluster !== "devnet" ||
		value.routerUrl !== "https://devnet-router.magicblock.app/" ||
		typeof value.signature !== "string" ||
		!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.signature) ||
		!isCanonicalSolanaPublicKey(value.signer) ||
		!Number.isSafeInteger(value.slot) ||
		Number(value.slot) < 0 ||
		!isDigest(value.commitmentDigest) ||
		typeof value.memo !== "string" ||
		!isCanonicalTimestamp(value.verifiedAt) ||
		!value.memo.startsWith("compass:audit:v1:")
	) {
		return false;
	}
	try {
		const encoded = value.memo.slice("compass:audit:v1:".length);
		const memo = JSON.parse(encoded) as Record<string, unknown>;
		return (
			canonicalJson(memo) === encoded &&
			hasExactKeys(memo, ["a", "c", "l", "o", "p", "v"]) &&
			memo.a === auditEventId &&
			memo.c === value.commitmentDigest &&
			memo.l === ledgerDigest &&
			memo.p === previousLedgerDigest &&
			memo.o ===
				(outcome === "review_required" ? "review" : "incompatible") &&
			memo.v === 1
		);
	} catch {
		return false;
	}
}

function parseJsonb(value: unknown): unknown {
	return typeof value === "string" ? JSON.parse(value) : value;
}
