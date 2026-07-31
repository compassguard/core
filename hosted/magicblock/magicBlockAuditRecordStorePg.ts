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
import {
	isValidMagicBlockPreparedAuditTransaction,
	materializeMagicBlockAuditCommitment,
} from "@back/services/magicBlockOnchainAudit";
import { isMagicBlockRouterDiagnostics } from "@back/services/magicBlockRouterDiagnostics";

import type { SqlExecutor } from "../verdict/verdictStorePg";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS magicblock_devnet_onchain_audit (
	audit_event_id text PRIMARY KEY,
	observation_id text UNIQUE NOT NULL,
	signature text UNIQUE,
	commitment_digest text NOT NULL,
	canonical_details text NOT NULL,
	registration jsonb NOT NULL,
	prepared_transaction jsonb,
	updated_at timestamptz NOT NULL DEFAULT now()
)`;
const MIGRATIONS = [
	`ALTER TABLE magicblock_devnet_onchain_audit
		ADD COLUMN IF NOT EXISTS observation_id text`,
	`CREATE UNIQUE INDEX IF NOT EXISTS magicblock_devnet_onchain_audit_observation_id_idx
		ON magicblock_devnet_onchain_audit (observation_id)
		WHERE observation_id IS NOT NULL`,
	`ALTER TABLE magicblock_devnet_onchain_audit
		ADD COLUMN IF NOT EXISTS prepared_transaction jsonb`,
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
					(audit_event_id, observation_id, signature, commitment_digest, canonical_details, registration, prepared_transaction)
				VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
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
					prepared_transaction = COALESCE(
						magicblock_devnet_onchain_audit.prepared_transaction,
						EXCLUDED.prepared_transaction
					),
					updated_at = now()
				WHERE magicblock_devnet_onchain_audit.canonical_details = EXCLUDED.canonical_details
					AND (
						magicblock_devnet_onchain_audit.prepared_transaction IS NULL
						OR EXCLUDED.prepared_transaction IS NULL
						OR magicblock_devnet_onchain_audit.prepared_transaction = EXCLUDED.prepared_transaction
					)
				RETURNING canonical_details, registration, prepared_transaction`,
				[
					record.details.auditEventId,
					record.details.observationId,
					signature,
					commitmentDigest,
					record.canonicalDetails,
					record.registration,
					record.preparedTransaction ?? null,
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
				!record.preparedTransaction ||
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
						 canonical_details, registration, prepared_transaction)
					SELECT $1, active_claim.observation_id, $3, $4, $5, $6::jsonb, $9::jsonb
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
						prepared_transaction = CASE
							WHEN magicblock_devnet_onchain_audit.signature IS NULL
							THEN COALESCE(
								magicblock_devnet_onchain_audit.prepared_transaction,
								EXCLUDED.prepared_transaction
							)
							ELSE magicblock_devnet_onchain_audit.prepared_transaction
						END,
						updated_at = now()
					WHERE magicblock_devnet_onchain_audit.canonical_details =
						EXCLUDED.canonical_details
					RETURNING canonical_details, registration, prepared_transaction
				)
				SELECT canonical_details, registration, prepared_transaction FROM reserved`,
				[
					record.details.auditEventId,
					record.details.observationId,
					record.registration.signature,
					record.registration.commitmentDigest,
					record.canonicalDetails,
					record.registration,
					requestDigest,
					claimAttempt,
					record.preparedTransaction,
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
					`SELECT canonical_details, registration, prepared_transaction
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
					`SELECT canonical_details, registration, prepared_transaction
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
					`SELECT canonical_details, registration, prepared_transaction
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
	const preparedTransaction =
		row.prepared_transaction === null || row.prepared_transaction === undefined
			? undefined
			: typeof row.prepared_transaction === "string"
				? JSON.parse(row.prepared_transaction)
				: row.prepared_transaction;
	const record = {
		details,
		canonicalDetails: String(row.canonical_details),
		registration,
		...(preparedTransaction ? { preparedTransaction } : {}),
	} as MagicBlockAuditRecord;
	validateRecord(record);
	return record;
}

function validateRecord(record: MagicBlockAuditRecord): void {
	const materialized = materializeMagicBlockAuditCommitment(record.details);
	if (
		record.preparedTransaction !== undefined &&
		(!isValidMagicBlockPreparedAuditTransaction(record.preparedTransaction, {
			commitmentDigest: materialized.commitmentDigest,
			memo: materialized.memo,
		}) ||
			("signature" in record.registration &&
				record.registration.signature !== undefined &&
				record.registration.signature !==
					record.preparedTransaction.signature) ||
			(record.registration.status === "confirmed" &&
				record.registration.signer !== record.preparedTransaction.signer))
	) {
		throw new Error("audit record unavailable");
	}
	if (
		record.registration.status === "retryable_failure" &&
		record.registration.code === "BLOCKHASH_VALIDITY_UNCONFIRMED" &&
		record.preparedTransaction !== undefined
	) {
		throw new Error("audit record unavailable");
	}
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
				"lastValidBlockHeight",
				"memo",
				"recentBlockhash",
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
				"BLOCKHASH_VALIDITY_UNCONFIRMED",
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
				record.registration.memo !== materialized.memo) ||
			(record.registration.recentBlockhash === undefined) !==
				(record.registration.lastValidBlockHeight === undefined) ||
			(record.registration.recentBlockhash !== undefined &&
				!isCanonicalSolanaPublicKey(
					record.registration.recentBlockhash,
				)) ||
			(record.registration.lastValidBlockHeight !== undefined &&
				(!Number.isSafeInteger(
					record.registration.lastValidBlockHeight,
				) ||
					record.registration.lastValidBlockHeight < 0)) ||
			(record.registration.code === "BLOCKHASH_VALIDITY_UNCONFIRMED" &&
				(record.registration.signature !== undefined ||
					record.registration.commitmentDigest === undefined ||
					record.registration.memo === undefined ||
					record.registration.recentBlockhash === undefined ||
					record.registration.lastValidBlockHeight === undefined)))
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
