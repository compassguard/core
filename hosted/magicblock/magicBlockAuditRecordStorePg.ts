import {
	canonicalJson,
	hasExactKeys,
	isCanonicalSolanaPublicKey,
	isCanonicalTimestamp,
	isDigest,
	isOpaqueIdentifier,
} from "@back/services/magicBlockDevnetPreflightCanonical";
import type {
	MagicBlockAuditRecord,
	MagicBlockAuditRecordStore,
} from "@back/services/magicBlockOnchainAuditContracts";
import { materializeMagicBlockAuditCommitment } from "@back/services/magicBlockOnchainAudit";
import { isMagicBlockRouterDiagnostics } from "@back/services/magicBlockRouterDiagnostics";

import type { SqlExecutor } from "../verdict/verdictStorePg";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS magicblock_devnet_onchain_audit (
	audit_event_id text PRIMARY KEY,
	observation_id text UNIQUE NOT NULL,
	signature text UNIQUE,
	commitment_digest text NOT NULL,
	canonical_details text NOT NULL,
	registration jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
)`;
const MIGRATIONS = [
	`ALTER TABLE magicblock_devnet_onchain_audit
		ADD COLUMN IF NOT EXISTS observation_id text`,
	`CREATE UNIQUE INDEX IF NOT EXISTS magicblock_devnet_onchain_audit_observation_id_idx
		ON magicblock_devnet_onchain_audit (observation_id)
		WHERE observation_id IS NOT NULL`,
];

export function createPgMagicBlockAuditRecordStore(input: {
	readonly sql: SqlExecutor;
}): MagicBlockAuditRecordStore {
	let ensured: Promise<void> | undefined;
	const ensure = () =>
		(ensured ??= (async () => {
			await input.sql(CREATE_TABLE, []);
			for (const migration of MIGRATIONS) await input.sql(migration, []);
		})().catch((error) => {
			ensured = undefined;
			throw error;
		}));

	return {
		async save(record) {
			await ensure();
			validateRecord(record);
			const signature =
				"signature" in record.registration
					? record.registration.signature
					: null;
			const commitmentDigest =
				record.registration.status === "confirmed"
					? record.registration.commitmentDigest
					: materializeMagicBlockAuditCommitment(record.details).commitmentDigest;
			const rows = await input.sql(
				`INSERT INTO magicblock_devnet_onchain_audit
					(audit_event_id, observation_id, signature, commitment_digest, canonical_details, registration)
				VALUES ($1, $2, $3, $4, $5, $6::jsonb)
				ON CONFLICT (audit_event_id) DO UPDATE SET
					signature = COALESCE(
						magicblock_devnet_onchain_audit.signature,
						EXCLUDED.signature
					),
					commitment_digest = EXCLUDED.commitment_digest,
					registration = CASE
						WHEN magicblock_devnet_onchain_audit.registration->>'status' = 'confirmed'
						THEN magicblock_devnet_onchain_audit.registration
						WHEN EXCLUDED.registration->>'status' = 'retryable_failure'
							AND magicblock_devnet_onchain_audit.signature IS NOT NULL
						THEN EXCLUDED.registration || jsonb_build_object(
							'signature',
							magicblock_devnet_onchain_audit.signature,
							'commitmentDigest',
							magicblock_devnet_onchain_audit.commitment_digest,
							'memo',
							magicblock_devnet_onchain_audit.registration->>'memo'
						)
						ELSE EXCLUDED.registration
					END,
					updated_at = now()
				WHERE magicblock_devnet_onchain_audit.canonical_details = EXCLUDED.canonical_details
				RETURNING canonical_details, registration`,
				[
					record.details.auditEventId,
					record.details.observationId,
					signature,
					commitmentDigest,
					record.canonicalDetails,
					record.registration,
				],
			);
			if (rows.length !== 1 || !read(rows)) {
				throw new Error("audit record unavailable");
			}
		},
		async reservePrepared({ record, requestDigest, claimAttempt }) {
			await ensure();
			validateRecord(record);
			if (
				record.registration.status !== "retryable_failure" ||
				record.registration.code !== "SUBMISSION_UNCONFIRMED" ||
				!record.registration.signature ||
				!isDigest(requestDigest) ||
				record.details.requestDigest !== requestDigest ||
				!Number.isSafeInteger(claimAttempt) ||
				claimAttempt < 1
			) {
				throw new Error("audit record unavailable");
			}
			const rows = await input.sql(
				`WITH active_claim AS MATERIALIZED (
					SELECT observation_id
					FROM magicblock_devnet_observations
					WHERE observation_id = $2
						AND request_digest = $7
						AND claim_attempts = $8
						AND status = 'pending'
					FOR UPDATE
				), reserved AS (
					INSERT INTO magicblock_devnet_onchain_audit
						(audit_event_id, observation_id, signature, commitment_digest,
						 canonical_details, registration)
					SELECT $1, active_claim.observation_id, $3, $4, $5, $6::jsonb
					FROM active_claim
					ON CONFLICT (audit_event_id) DO UPDATE SET
						signature = COALESCE(
							magicblock_devnet_onchain_audit.signature,
							EXCLUDED.signature
						),
						registration = CASE
							WHEN magicblock_devnet_onchain_audit.registration->>'status' = 'confirmed'
							THEN magicblock_devnet_onchain_audit.registration
							WHEN magicblock_devnet_onchain_audit.signature IS NOT NULL
							THEN magicblock_devnet_onchain_audit.registration
							ELSE EXCLUDED.registration
						END,
						updated_at = now()
					WHERE magicblock_devnet_onchain_audit.canonical_details =
						EXCLUDED.canonical_details
					RETURNING canonical_details, registration
				)
				SELECT canonical_details, registration FROM reserved`,
				[
					record.details.auditEventId,
					record.details.observationId,
					record.registration.signature,
					record.registration.commitmentDigest,
					record.canonicalDetails,
					record.registration,
					requestDigest,
					claimAttempt,
				],
			);
			const reserved = read(rows);
			if (!reserved) throw new Error("audit reservation unavailable");
			return reserved;
		},
		async findByAuditEventId(auditEventId) {
			if (!isOpaqueIdentifier(auditEventId)) return null;
			await ensure();
			return read(
				await input.sql(
					`SELECT canonical_details, registration
					FROM magicblock_devnet_onchain_audit WHERE audit_event_id = $1`,
					[auditEventId],
				),
			);
		},
		async findByObservationId(observationId) {
			if (!isOpaqueIdentifier(observationId)) return null;
			await ensure();
			return read(
				await input.sql(
					`SELECT canonical_details, registration
					FROM magicblock_devnet_onchain_audit WHERE observation_id = $1`,
					[observationId],
				),
			);
		},
		async findBySignature(signature) {
			if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return null;
			await ensure();
			return read(
				await input.sql(
					`SELECT canonical_details, registration
					FROM magicblock_devnet_onchain_audit WHERE signature = $1`,
					[signature],
				),
			);
		},
	};
}

function read(rows: readonly Record<string, unknown>[]): MagicBlockAuditRecord | null {
	const row = rows[0];
	if (!row) return null;
	const details = JSON.parse(String(row.canonical_details));
	const registration =
		typeof row.registration === "string"
			? JSON.parse(row.registration)
			: row.registration;
	const record = {
		details,
		canonicalDetails: String(row.canonical_details),
		registration,
	} as MagicBlockAuditRecord;
	validateRecord(record);
	return record;
}

function validateRecord(record: MagicBlockAuditRecord): void {
	const materialized = materializeMagicBlockAuditCommitment(record.details);
	const retryableKeys =
		record.registration.status === "retryable_failure"
			? Object.keys(record.registration).sort()
			: [];
	const retryableShape =
		record.registration.status === "retryable_failure" &&
		["code", "retryable", "status"].every((key) =>
			retryableKeys.includes(key),
		) &&
		retryableKeys.every((key) =>
			[
				"code",
				"commitmentDigest",
				"memo",
				"retryable",
				"routerDiagnostics",
				"signature",
				"status",
			].includes(key),
		);
	if (
		record.canonicalDetails !== canonicalJson(record.details) ||
		record.details.schemaVersion !==
			"compass.magicblock-audit-commitment/v1" ||
		record.details.cluster !== "devnet" ||
		!isOpaqueIdentifier(record.details.auditEventId) ||
		!isOpaqueIdentifier(record.details.observationId) ||
		!isDigest(record.details.transactionDigest) ||
		!isDigest(record.details.requestDigest) ||
		!isDigest(record.details.resultDigest) ||
		!isDigest(record.details.attestationDigest) ||
		!isDigest(record.details.previousLedgerDigest) ||
		!isDigest(record.details.ledgerDigest) ||
		!["review_required", "incompatible"].includes(record.details.outcome) ||
		!retryableShape &&
			!hasExactKeys(record.registration, [
				"status",
				"cluster",
				"routerUrl",
				"signature",
				"signer",
				"slot",
				"commitmentDigest",
				"memo",
				"verifiedAt",
			])
	) {
		throw new Error("audit record unavailable");
	}
	if (
		record.registration.status === "retryable_failure" &&
		(record.registration.retryable !== true ||
			![
				"SIGNER_UNAVAILABLE",
				"ROUTER_UNAVAILABLE",
				"ROUTER_PREFLIGHT_REJECTED",
				"SUBMISSION_UNCONFIRMED",
				"TRANSACTION_EXECUTION_FAILED",
				"TRANSACTION_VERIFICATION_FAILED",
			].includes(record.registration.code) ||
			(record.registration.routerDiagnostics !== undefined &&
				!isMagicBlockRouterDiagnostics(
					record.registration.routerDiagnostics,
				)) ||
			(record.registration.signature !== undefined &&
				!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(
					record.registration.signature,
				)) ||
			(record.registration.commitmentDigest !== undefined &&
				record.registration.commitmentDigest !==
					materialized.commitmentDigest) ||
			(record.registration.memo !== undefined &&
				record.registration.memo !== materialized.memo))
	) {
		throw new Error("audit record unavailable");
	}
	if (
		record.registration.status === "confirmed" &&
		(record.registration.commitmentDigest !== materialized.commitmentDigest ||
			record.registration.memo !== materialized.memo ||
			record.registration.cluster !== "devnet" ||
			record.registration.routerUrl !==
				"https://devnet-router.magicblock.app/" ||
			!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(
				record.registration.signature,
			) ||
			!isCanonicalSolanaPublicKey(record.registration.signer) ||
			!Number.isSafeInteger(record.registration.slot) ||
			record.registration.slot < 0 ||
			!isCanonicalTimestamp(record.registration.verifiedAt))
	) {
		throw new Error("audit record unavailable");
	}
}
