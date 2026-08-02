import { isOpaqueIdentifier } from "@back/services/magicBlockDevnetPreflightCanonical";
import { materializeMagicBlockAuditCommitment } from "@back/services/magicBlockAuditCommitment";
import type { MagicBlockFinalizedAuditProofVerifier } from "@back/services/magicBlockAuditProofVerificationContracts";
import type { MagicBlockAuditProofRecordStore } from "@back/services/magicBlockAuditProofImportContracts";

import { createMagicBlockBearerAuthorization } from "./magicBlockIngressAuth";

export type MagicBlockAuditReadIngress = { handle(request: Request): Promise<Response> };

export function createMagicBlockAuditReadIngress(input:
	| { readonly enabled?: false }
	| { readonly enabled: true; readonly apiKey: string; readonly expectedSigner: string; readonly verifier: MagicBlockFinalizedAuditProofVerifier; readonly auditRecords: MagicBlockAuditProofRecordStore },
): MagicBlockAuditReadIngress {
	if (input.enabled !== true) return { async handle() { return jsonError(404, "NOT_FOUND", "Not found."); } };
	const authorization = createMagicBlockBearerAuthorization(input.apiKey);
	return { async handle(request) {
		if (!authorization.authorize(request.headers.get("authorization"))) return jsonError(401, "UNAUTHENTICATED", "Missing or invalid audit-ingress credentials.");
		if (request.method !== "GET") return jsonError(405, "METHOD_NOT_ALLOWED", "GET is required.");
		const url = new URL(request.url);
		const auditId = url.searchParams.get("auditId");
		const signature = url.searchParams.get("signature");
		if ((auditId === null) === (signature === null) || (auditId !== null && !isOpaqueIdentifier(auditId)) || (signature !== null && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))) return jsonError(400, "BAD_REQUEST", "Provide exactly one auditId or signature.");
		let record;
		try { record = auditId !== null ? await input.auditRecords.findByAuditEventId(auditId) : await input.auditRecords.findBySignature(signature as string); }
		catch { return jsonError(503, "UNAVAILABLE", "Audit proof unavailable."); }
		if (!record) return jsonError(404, "NOT_FOUND", "Audit proof not found.");
		if (record.registration.status !== "confirmed" && !record.registration.signature) return Response.json(publicRecord(record), { status: 503 });
		const commitment = materializeMagicBlockAuditCommitment(record.details);
		let verified;
		try { verified = await input.verifier.verify({ signature: record.registration.signature as string, expectedSigner: input.expectedSigner, expectedCommitmentDigest: commitment.commitmentDigest, expectedMemo: commitment.memo }); }
		catch { return jsonError(503, "UNAVAILABLE", "Audit verification unavailable."); }
		if (verified.status !== "confirmed") return Response.json({ ...publicRecord(record), registration: verified }, { status: 503 });
		const refreshed = { ...record, registration: verified };
		try { await input.auditRecords.save(refreshed); }
		catch { return jsonError(503, "UNAVAILABLE", "Audit persistence unavailable."); }
		return Response.json(publicRecord(refreshed));
	} };
}

function publicRecord(record: { readonly details: unknown; readonly canonicalDetails: string; readonly registration: unknown }) {
	return { details: record.details, canonicalDetails: record.canonicalDetails, registration: record.registration };
}
function jsonError(status: number, code: string, message: string) { return Response.json({ error: { code, message } }, { status }); }
