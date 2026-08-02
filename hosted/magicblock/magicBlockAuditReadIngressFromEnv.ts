import { isCanonicalSolanaPublicKey } from "@back/services/magicBlockDevnetPreflightCanonical";
import { createMagicBlockFinalizedAuditProofVerifier } from "@back/services/magicBlockAuditProofVerification";

import { createSqlExecutorFromEnv, readEnv } from "../db/sqlExecutorFromEnv";
import { createPgMagicBlockAuditProofRecordStore } from "./magicBlockAuditProofRecordStorePg";
import { createMagicBlockAuditReadIngress, type MagicBlockAuditReadIngress } from "./magicBlockAuditReadIngress";

export function createMagicBlockAuditReadIngressFromEnv(getEnv: (key: string) => string | undefined = readEnv): MagicBlockAuditReadIngress {
	if (getEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED")?.trim() !== "true") return createMagicBlockAuditReadIngress({ enabled: false });
	const apiKey = getEnv("COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY")?.trim();
	const expectedSigner = getEnv("COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY")?.trim();
	const sql = createSqlExecutorFromEnv(getEnv);
	if (!apiKey || !expectedSigner || !isCanonicalSolanaPublicKey(expectedSigner) || !sql) return { async handle() { return Response.json({ error: { code: "UNAVAILABLE", message: "Audit read ingress is not fully configured." } }, { status: 503 }); } };
	return createMagicBlockAuditReadIngress({ enabled: true, apiKey, expectedSigner, verifier: createMagicBlockFinalizedAuditProofVerifier(), auditRecords: createPgMagicBlockAuditProofRecordStore({ sql }) });
}
