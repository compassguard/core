import {
	hasExactKeys,
	isCanonicalSolanaPublicKey,
	isDigest,
	isOpaqueIdentifier,
	parseClosedJson,
} from "@back/services/magicBlockDevnetPreflightCanonical";
import {
	MAGICBLOCK_AUDIT_PROOF_IMPORT_MAX_REQUEST_BYTES,
	MAGICBLOCK_AUDIT_PROOF_IMPORT_BODY_TIMEOUT_MS,
	MAGICBLOCK_AUDIT_PROOF_IMPORT_SCHEMA,
	type MagicBlockAuditProofImportIngress,
	type MagicBlockAuditProofImportRuntime,
	type MagicBlockAuditProofImportV1,
	type MagicBlockAuditProofRecord,
} from "@back/services/magicBlockAuditProofImportContracts";
import { materializeMagicBlockAuditCommitment } from "@back/services/magicBlockAuditCommitment";

import { createMagicBlockBearerAuthorization } from "./magicBlockIngressAuth";

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export function createMagicBlockAuditProofImportIngress(
	input:
		| { readonly enabled?: false }
		| {
				readonly enabled: true;
				readonly apiKey: string;
				readonly runtime: MagicBlockAuditProofImportRuntime;
		  },
): MagicBlockAuditProofImportIngress {
	if (input.enabled !== true) {
		return { async handle() { return error(404, "NOT_FOUND", "Not found."); } };
	}
	const authorization = createMagicBlockBearerAuthorization(input.apiKey);
	if (!isCanonicalSolanaPublicKey(input.runtime.expectedSigner)) {
		throw new Error("audit proof import unavailable");
	}
	return {
		async handle(request) {
			if (!authorization.authorize(request.headers.get("authorization"))) {
				return error(401, "UNAUTHENTICATED", "Missing or invalid audit-ingress credentials.");
			}
			if (request.method !== "POST") {
				return error(405, "METHOD_NOT_ALLOWED", "POST is required.");
			}
			const contentType = request.headers.get("content-type");
			if (!contentType || !/^application\/json(?:\s*;[^\r\n]*)?$/i.test(contentType)) {
				return error(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type application/json is required.");
			}
			let proof: MagicBlockAuditProofImportV1;
			try {
				proof = validateProof(parseClosedJson(await readBoundedBody(request)));
			} catch {
				return error(400, "BAD_REQUEST", "Invalid finalized audit proof.");
			}
			const materialized = materializeMagicBlockAuditCommitment(proof.details);
			if (
				proof.canonicalDetails !== materialized.canonicalDetails ||
				proof.commitmentDigest !== materialized.commitmentDigest ||
				proof.memo !== materialized.memo
			) {
				return error(400, "BAD_REQUEST", "Invalid finalized audit proof.");
			}

			let existing: readonly (MagicBlockAuditProofRecord | null)[];
			try {
				existing = await Promise.all([
					input.runtime.auditRecords.findByAuditEventId(proof.details.auditEventId),
					input.runtime.auditRecords.findByObservationId(proof.details.observationId),
					input.runtime.auditRecords.findBySignature(proof.signature),
				]);
			} catch {
				return error(503, "UNAVAILABLE", "Audit persistence unavailable.");
			}
			const present = existing.filter((record): record is MagicBlockAuditProofRecord => record !== null);
			if (present.some((record) => !sameIdentity(record, proof))) {
				return error(409, "IDEMPOTENCY_CONFLICT", "Audit proof identity conflict.");
			}
			const durable = present.find((record) => exactConfirmed(record, proof, input.runtime.expectedSigner));
			if (durable) return Response.json({ record: publicRecord(durable), replayed: true });

			let verification;
			try {
				verification = await input.runtime.verifier.verify({
					signature: proof.signature,
					expectedSigner: input.runtime.expectedSigner,
					expectedCommitmentDigest: proof.commitmentDigest,
					expectedMemo: proof.memo,
				});
			} catch {
				return error(503, "PROOF_UNVERIFIED", "Finalized audit proof could not be verified.");
			}
			if (verification.status !== "confirmed") {
				return error(
					verification.code === "TRANSACTION_EXECUTION_FAILED" ? 422 : 503,
					"PROOF_UNVERIFIED",
					"Finalized audit proof could not be verified.",
				);
			}
			if (
				verification.cluster !== "devnet" ||
				verification.signature !== proof.signature ||
				verification.signer !== input.runtime.expectedSigner ||
				verification.commitmentDigest !== proof.commitmentDigest ||
				verification.memo !== proof.memo
			) {
				return error(503, "PROOF_UNVERIFIED", "Finalized audit proof could not be verified.");
			}
			const record: MagicBlockAuditProofRecord = {
				details: proof.details,
				canonicalDetails: proof.canonicalDetails,
				registration: verification,
			};
			try {
				await input.runtime.auditRecords.save(record);
			} catch {
				// The write may have committed before the caller lost its acknowledgement.
			}
			let reloaded: readonly (MagicBlockAuditProofRecord | null)[];
			try {
				reloaded = await Promise.all([
					input.runtime.auditRecords.findByAuditEventId(proof.details.auditEventId),
					input.runtime.auditRecords.findByObservationId(proof.details.observationId),
					input.runtime.auditRecords.findBySignature(proof.signature),
				]);
			} catch {
				return error(503, "UNAVAILABLE", "Audit persistence unavailable.");
			}
			if (reloaded.some((candidate) => candidate && !sameIdentity(candidate, proof))) {
				return error(409, "IDEMPOTENCY_CONFLICT", "Audit proof identity conflict.");
			}
			if (reloaded.some((candidate) => !candidate || !exactConfirmed(candidate, proof, input.runtime.expectedSigner))) {
				return error(503, "UNAVAILABLE", "Audit persistence unavailable.");
			}
			return Response.json({ record: publicRecord(reloaded[0] as MagicBlockAuditProofRecord), replayed: false });
		},
	};
}

function validateProof(value: unknown): MagicBlockAuditProofImportV1 {
	if (!hasExactKeys(value, ["canonicalDetails", "cluster", "commitmentDigest", "details", "memo", "schemaVersion", "signature"])) throw new Error("invalid");
	if (
		value.schemaVersion !== MAGICBLOCK_AUDIT_PROOF_IMPORT_SCHEMA ||
		value.cluster !== "devnet" ||
		!hasExactKeys(value.details, ["attestationDigest", "auditEventId", "cluster", "ledgerDigest", "observationId", "outcome", "previousLedgerDigest", "requestDigest", "resultDigest", "schemaVersion", "transactionDigest"]) ||
		value.details.schemaVersion !== "compass.magicblock-audit-commitment/v1" ||
		value.details.cluster !== "devnet" ||
		!isOpaqueIdentifier(value.details.auditEventId) ||
		!isOpaqueIdentifier(value.details.observationId) ||
		![value.details.transactionDigest, value.details.requestDigest, value.details.resultDigest, value.details.attestationDigest, value.details.previousLedgerDigest, value.details.ledgerDigest].every(isDigest) ||
		!["review_required", "incompatible"].includes(String(value.details.outcome)) ||
		typeof value.canonicalDetails !== "string" ||
		Buffer.byteLength(value.canonicalDetails, "utf8") > 4_096 ||
		!isDigest(value.commitmentDigest) ||
		typeof value.memo !== "string" ||
		Buffer.byteLength(value.memo, "utf8") > 400 ||
		typeof value.signature !== "string" ||
		!SIGNATURE.test(value.signature)
	) throw new Error("invalid");
	return value as MagicBlockAuditProofImportV1;
}

function sameIdentity(record: MagicBlockAuditProofRecord, proof: MagicBlockAuditProofImportV1): boolean {
	return record.details.auditEventId === proof.details.auditEventId &&
		record.details.observationId === proof.details.observationId &&
		record.canonicalDetails === proof.canonicalDetails &&
		(!("signature" in record.registration) || record.registration.signature === undefined || record.registration.signature === proof.signature);
}

function exactConfirmed(record: MagicBlockAuditProofRecord, proof: MagicBlockAuditProofImportV1, signer: string): boolean {
	return sameIdentity(record, proof) && record.registration.status === "confirmed" &&
		record.registration.signature === proof.signature && record.registration.signer === signer &&
		record.registration.cluster === "devnet" && record.registration.commitmentDigest === proof.commitmentDigest &&
		record.registration.memo === proof.memo;
}

function publicRecord(record: MagicBlockAuditProofRecord) {
	return { details: record.details, canonicalDetails: record.canonicalDetails, registration: record.registration };
}

async function readBoundedBody(request: Request): Promise<string> {
	const length = request.headers.get("content-length");
	if (length !== null && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) > MAGICBLOCK_AUDIT_PROOF_IMPORT_MAX_REQUEST_BYTES)) throw new Error("invalid");
	if (!request.body) return "";
	const reader = request.body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("request body deadline exceeded")), MAGICBLOCK_AUDIT_PROOF_IMPORT_BODY_TIMEOUT_MS);
	});
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await Promise.race([reader.read(), timeout]);
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAGICBLOCK_AUDIT_PROOF_IMPORT_MAX_REQUEST_BYTES) throw new Error("invalid");
			chunks.push(chunk.value);
		}
	} catch (error) {
		cancelReaderBestEffort(reader, "audit proof request stopped");
		throw error;
	} finally { if (timer) clearTimeout(timer); releaseReaderBestEffort(reader); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>, reason: string): void {
	try {
		void reader.cancel(reason).then(
			() => releaseReaderBestEffort(reader),
			() => releaseReaderBestEffort(reader),
		);
	} catch { releaseReaderBestEffort(reader); }
	queueMicrotask(() => releaseReaderBestEffort(reader));
}

function releaseReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try { reader.releaseLock(); } catch { /* A pending read releases after best-effort cancellation settles. */ }
}

function error(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status });
}
