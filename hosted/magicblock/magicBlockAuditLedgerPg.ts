import { randomUUID } from "node:crypto";

import {
	canonicalJson,
	hasExactKeys,
	isCanonicalTimestamp,
	isDigest,
	isOpaqueIdentifier,
	sha256Hex,
} from "@back/services/magicBlockDevnetPreflightCanonical";
import type {
	MagicBlockAppendOnlyAuditLedger,
} from "@back/services/magicBlockDevnetPreflightTypes";

import type { SqlExecutor } from "../verdict/verdictStorePg";

const ATTESTATION_DOMAIN = "compass.magicblock-devnet-attestation/v1\0";
const CREATE_LEDGER_TABLE = `CREATE TABLE IF NOT EXISTS magicblock_devnet_audit_ledger (
	sequence bigint PRIMARY KEY,
	audit_event_id text UNIQUE NOT NULL,
	observation_id text UNIQUE NOT NULL,
	request_digest text NOT NULL,
	schema_version text NOT NULL,
	canonical_payload text NOT NULL,
	attestation_digest text UNIQUE NOT NULL,
	previous_event_digest text,
	ledger_event_digest text UNIQUE NOT NULL,
	created_at text NOT NULL
)`;
const CREATE_TIP_TABLE = `CREATE TABLE IF NOT EXISTS magicblock_devnet_audit_tip (
	singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
	sequence bigint NOT NULL,
	previous_event_digest text,
	ledger_event_digest text
)`;
const INSERT_TIP = `INSERT INTO magicblock_devnet_audit_tip
	(singleton, sequence, previous_event_digest, ledger_event_digest)
VALUES (
	true,
	COALESCE((
		SELECT sequence FROM magicblock_devnet_audit_ledger
		ORDER BY sequence DESC LIMIT 1
	), 0),
	NULL,
	(
		SELECT ledger_event_digest FROM magicblock_devnet_audit_ledger
		ORDER BY sequence DESC LIMIT 1
	)
)
ON CONFLICT (singleton) DO NOTHING`;
const MIGRATIONS = [
	`ALTER TABLE magicblock_devnet_audit_ledger ADD COLUMN IF NOT EXISTS observation_id text`,
	`ALTER TABLE magicblock_devnet_audit_ledger ADD COLUMN IF NOT EXISTS request_digest text`,
	`CREATE UNIQUE INDEX IF NOT EXISTS magicblock_devnet_audit_ledger_observation_id_idx
		ON magicblock_devnet_audit_ledger (observation_id)
		WHERE observation_id IS NOT NULL`,
];
const APPEND_SQL = `WITH locked_observation AS MATERIALIZED (
	SELECT observation_id, claim_attempts
	FROM magicblock_devnet_observations
	WHERE observation_id = $6
		AND request_digest = $7
		AND claim_attempts = $8
		AND status = 'pending'
	FOR UPDATE
), advanced_tip AS MATERIALIZED (
	UPDATE magicblock_devnet_audit_tip AS tip
	SET sequence = tip.sequence + 1,
		previous_event_digest = tip.ledger_event_digest,
		ledger_event_digest = encode(sha256(
			convert_to('compass.magicblock-audit-ledger/v1/event', 'UTF8')
			|| decode('00', 'hex')
			|| decode(COALESCE(tip.ledger_event_digest, repeat('0', 64)), 'hex')
			|| decode('00', 'hex')
			|| convert_to($1, 'UTF8')
			|| decode('00', 'hex')
			|| decode($4, 'hex')
		), 'hex')
	FROM locked_observation
	WHERE tip.singleton = true
	RETURNING tip.sequence, tip.previous_event_digest, tip.ledger_event_digest
), inserted AS MATERIALIZED (
	INSERT INTO magicblock_devnet_audit_ledger (
		sequence,
		audit_event_id,
		observation_id,
		request_digest,
		schema_version,
		canonical_payload,
		attestation_digest,
		previous_event_digest,
		ledger_event_digest,
		created_at
	)
	SELECT
		advanced_tip.sequence,
		$1,
		$6,
		$7,
		$2,
		$3,
		$4,
		advanced_tip.previous_event_digest,
		advanced_tip.ledger_event_digest,
		$5
	FROM advanced_tip
	RETURNING sequence, audit_event_id, attestation_digest, previous_event_digest, ledger_event_digest
), transition_counts AS MATERIALIZED (
	SELECT
		(SELECT count(*) FROM locked_observation) AS locked_count,
		(SELECT count(*) FROM advanced_tip) AS tip_count,
		(SELECT count(*) FROM inserted) AS inserted_count
)
SELECT
	(SELECT audit_event_id FROM inserted) AS audit_event_id,
	(SELECT attestation_digest FROM inserted) AS attestation_digest,
	(SELECT previous_event_digest FROM inserted) AS previous_event_digest,
	(SELECT ledger_event_digest FROM inserted) AS ledger_event_digest,
	1 / CASE
		WHEN locked_count = 1
			AND tip_count = 1
			AND inserted_count = 1
		THEN 1
		ELSE 0
	END AS transition_guard
FROM transition_counts`;

export function createPgMagicBlockAppendOnlyAuditLedger(input: {
	readonly sql: SqlExecutor;
	readonly observationId: string;
	readonly requestDigest: string;
	readonly claimAttempt: number;
	readonly createAuditEventId?: () => string;
	readonly now?: () => string;
}): MagicBlockAppendOnlyAuditLedger {
	if (
		!isOpaqueIdentifier(input.observationId) ||
		!isDigest(input.requestDigest) ||
		!Number.isSafeInteger(input.claimAttempt) ||
		input.claimAttempt < 1
	) {
		throw new Error("audit unavailable");
	}
	const createAuditEventId =
		input.createAuditEventId ?? (() => `aud_${randomUUID()}`);
	const now = input.now ?? (() => new Date().toISOString());
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
			await input.sql(CREATE_LEDGER_TABLE, []);
		} catch (error) {
			const probe = await input.sql(
				`SELECT to_regclass('magicblock_devnet_audit_ledger') AS t`,
				[],
			);
			if (probe[0]?.t == null) throw error;
		}
		for (const migration of MIGRATIONS) await input.sql(migration, []);
		await input.sql(CREATE_TIP_TABLE, []);
		await input.sql(
			`ALTER TABLE magicblock_devnet_audit_tip
				ADD COLUMN IF NOT EXISTS previous_event_digest text`,
			[],
		);
		await input.sql(INSERT_TIP, []);
	}

	return {
		async appendAtomic(appendInput) {
			await ensureSchema();
			if (
				!hasExactKeys(appendInput, ["schemaVersion", "materialize"]) ||
				appendInput.schemaVersion !== "magicblock-devnet-attestation/v1" ||
				typeof appendInput.materialize !== "function"
			) {
				throw new Error("audit unavailable");
			}
			const existingRows = await input.sql(
				`SELECT audit_event_id, attestation_digest, previous_event_digest,
					ledger_event_digest, canonical_payload
				FROM magicblock_devnet_audit_ledger
				WHERE observation_id = $1 AND request_digest = $2`,
				[input.observationId, input.requestDigest],
			);
			const existing = existingRows[0];
			const auditEventId =
				existing?.audit_event_id === undefined
					? createAuditEventId()
					: String(existing.audit_event_id);
			if (!/^aud_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/.test(auditEventId)) {
				throw new Error("audit unavailable");
			}
			if (existing !== undefined) {
				if (
					!isDigest(existing.attestation_digest) ||
					(existing.previous_event_digest !== null &&
						!isDigest(existing.previous_event_digest)) ||
					!isDigest(existing.ledger_event_digest) ||
					typeof existing.canonical_payload !== "string"
				) {
					throw new Error("audit unavailable");
				}
				return {
					auditEventId,
					attestationDigest: String(existing.attestation_digest),
					previousLedgerDigest:
						existing.previous_event_digest === null
							? "0".repeat(64)
							: String(existing.previous_event_digest),
					ledgerDigest: String(existing.ledger_event_digest),
					canonicalPayload: existing.canonical_payload,
					reused: true as const,
				};
			}
			const materialized = appendInput.materialize(auditEventId);
			if (
				!hasExactKeys(materialized, [
					"payload",
					"canonicalPayload",
					"attestationDigest",
				]) ||
				materialized.payload.auditEventId !== auditEventId ||
				materialized.canonicalPayload !== canonicalJson(materialized.payload) ||
				materialized.attestationDigest !==
					sha256Hex(ATTESTATION_DOMAIN, materialized.canonicalPayload) ||
				!isDigest(materialized.attestationDigest)
			) {
				throw new Error("audit unavailable");
			}
			const createdAt = now();
			if (!isCanonicalTimestamp(createdAt)) throw new Error("audit unavailable");
			const rows = await input.sql(APPEND_SQL, [
				auditEventId,
				appendInput.schemaVersion,
				materialized.canonicalPayload,
				materialized.attestationDigest,
				createdAt,
				input.observationId,
				input.requestDigest,
				input.claimAttempt,
			]);
			const row = rows[0];
			if (
				rows.length !== 1 ||
				row?.audit_event_id !== auditEventId ||
				row.attestation_digest !== materialized.attestationDigest ||
				Number(row.transition_guard) !== 1 ||
				(row.previous_event_digest !== null &&
					!isDigest(row.previous_event_digest)) ||
				!isDigest(row.ledger_event_digest)
			) {
				throw new Error("audit unavailable");
			}
			return {
				auditEventId,
				attestationDigest: materialized.attestationDigest,
				previousLedgerDigest:
					row.previous_event_digest === null
						? "0".repeat(64)
						: String(row.previous_event_digest),
				ledgerDigest: String(row.ledger_event_digest),
				canonicalPayload: materialized.canonicalPayload,
			};
		},
	};
}
