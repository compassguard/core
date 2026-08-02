import { canonicalJson, isCanonicalSolanaPublicKey, isCanonicalTimestamp, isDigest, isOpaqueIdentifier } from "@back/services/magicBlockDevnetPreflightCanonical";
import { materializeMagicBlockAuditCommitment } from "@back/services/magicBlockAuditCommitment";
import type { MagicBlockAuditProofRecord, MagicBlockAuditProofRecordStore } from "@back/services/magicBlockAuditProofImportContracts";

import type { SqlExecutor } from "../db/sqlContracts";

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

const COMPATIBILITY_MIGRATIONS = [
	`ALTER TABLE magicblock_devnet_onchain_audit
		ADD COLUMN IF NOT EXISTS observation_id text`,
	`CREATE UNIQUE INDEX IF NOT EXISTS magicblock_devnet_onchain_audit_observation_id_idx
		ON magicblock_devnet_onchain_audit (observation_id)
		WHERE observation_id IS NOT NULL`,
	`ALTER TABLE magicblock_devnet_onchain_audit
		ADD COLUMN IF NOT EXISTS prepared_transaction jsonb`,
] as const;

export function createPgMagicBlockAuditProofRecordStore(input: { readonly sql: SqlExecutor }): MagicBlockAuditProofRecordStore {
	let ensured: Promise<void> | undefined;
	const ensure = () => (ensured ??= ensureSchema(input.sql).catch((error) => { ensured = undefined; throw error; }));
	return {
		async save(record) {
			await ensure();
			validate(record);
			if (record.registration.status !== "confirmed") throw new Error("audit proof record unavailable");
			const rows = await input.sql(
				`INSERT INTO magicblock_devnet_onchain_audit
					(audit_event_id, observation_id, signature, commitment_digest, canonical_details, registration, prepared_transaction)
				 VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL)
				 ON CONFLICT (audit_event_id) DO UPDATE SET
					signature = COALESCE(magicblock_devnet_onchain_audit.signature, EXCLUDED.signature),
					commitment_digest = EXCLUDED.commitment_digest,
					registration = CASE WHEN magicblock_devnet_onchain_audit.registration->>'status' = 'confirmed' THEN magicblock_devnet_onchain_audit.registration ELSE EXCLUDED.registration END,
					updated_at = now()
				 WHERE magicblock_devnet_onchain_audit.canonical_details = EXCLUDED.canonical_details
					AND (magicblock_devnet_onchain_audit.signature IS NULL OR magicblock_devnet_onchain_audit.signature = EXCLUDED.signature)
				 RETURNING canonical_details, registration`,
				[record.details.auditEventId, record.details.observationId, record.registration.signature, record.registration.commitmentDigest, record.canonicalDetails, record.registration],
			);
			if (rows.length !== 1 || !read(rows)) throw new Error("audit proof record unavailable");
		},
		async findByAuditEventId(id) { if (!isOpaqueIdentifier(id)) return null; await ensure(); return read(await input.sql("SELECT canonical_details, registration FROM magicblock_devnet_onchain_audit WHERE audit_event_id = $1", [id])); },
		async findByObservationId(id) { if (!isOpaqueIdentifier(id)) return null; await ensure(); return read(await input.sql("SELECT canonical_details, registration FROM magicblock_devnet_onchain_audit WHERE observation_id = $1", [id])); },
		async findBySignature(signature) { if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return null; await ensure(); return read(await input.sql("SELECT canonical_details, registration FROM magicblock_devnet_onchain_audit WHERE signature = $1", [signature])); },
	};
}

async function ensureSchema(sql: SqlExecutor): Promise<void> {
	await sql(CREATE_TABLE, []);
	for (const migration of COMPATIBILITY_MIGRATIONS) await sql(migration, []);
}

function read(rows: readonly Record<string, unknown>[]): MagicBlockAuditProofRecord | null {
	const row = rows[0];
	if (!row) return null;
	const record = {
		details: JSON.parse(String(row.canonical_details)),
		canonicalDetails: String(row.canonical_details),
		registration: typeof row.registration === "string" ? JSON.parse(row.registration) : row.registration,
	} as MagicBlockAuditProofRecord;
	validate(record);
	return record;
}

function validate(record: MagicBlockAuditProofRecord): void {
	const commitment = materializeMagicBlockAuditCommitment(record.details);
	if (record.canonicalDetails !== canonicalJson(record.details) || record.details.schemaVersion !== "compass.magicblock-audit-commitment/v1" || record.details.cluster !== "devnet" || !isOpaqueIdentifier(record.details.auditEventId) || !isOpaqueIdentifier(record.details.observationId) || ![record.details.transactionDigest, record.details.requestDigest, record.details.resultDigest, record.details.attestationDigest, record.details.previousLedgerDigest, record.details.ledgerDigest].every(isDigest)) throw new Error("audit proof record unavailable");
	if (record.registration.status === "confirmed") {
		if (record.registration.cluster !== "devnet" || record.registration.routerUrl !== "https://devnet-router.magicblock.app/" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(record.registration.signature) || !isCanonicalSolanaPublicKey(record.registration.signer) || !Number.isSafeInteger(record.registration.slot) || record.registration.slot < 0 || record.registration.commitmentDigest !== commitment.commitmentDigest || record.registration.memo !== commitment.memo || !isCanonicalTimestamp(record.registration.verifiedAt)) throw new Error("audit proof record unavailable");
	} else if (record.registration.status !== "retryable_failure") throw new Error("audit proof record unavailable");
}
