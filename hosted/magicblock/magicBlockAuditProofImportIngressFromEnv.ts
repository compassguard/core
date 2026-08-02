import { isCanonicalSolanaPublicKey } from "@back/services/magicBlockDevnetPreflightCanonical";
import { createMagicBlockFinalizedAuditProofVerifier } from "@back/services/magicBlockAuditProofVerification";
import type { MagicBlockAuditProofImportIngress } from "@back/services/magicBlockAuditProofImportContracts";

import { createSqlExecutorFromEnv, readEnv } from "../db/sqlExecutorFromEnv";
import { createPgMagicBlockAuditProofRecordStore } from "./magicBlockAuditProofRecordStorePg";
import { createMagicBlockAuditProofImportIngress } from "./magicBlockAuditProofImportIngress";

const ENABLED_ENV = "COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED";
const API_KEY_ENV = "COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY";
const SIGNER_ENV = "COMPASS_MAGICBLOCK_DEVNET_AUDIT_SIGNER_PUBLIC_KEY";

export function createMagicBlockAuditProofImportIngressFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): MagicBlockAuditProofImportIngress {
	if (getEnv(ENABLED_ENV)?.trim() !== "true") {
		return createMagicBlockAuditProofImportIngress({ enabled: false });
	}
	const apiKey = getEnv(API_KEY_ENV)?.trim();
	const expectedSigner = getEnv(SIGNER_ENV)?.trim();
	const sql = createSqlExecutorFromEnv(getEnv);
	if (!apiKey || !expectedSigner || !isCanonicalSolanaPublicKey(expectedSigner) || !sql) {
		return { async handle() { return Response.json({ error: { code: "UNAVAILABLE", message: "Audit proof import is not fully configured." } }, { status: 503 }); } };
	}
	return createMagicBlockAuditProofImportIngress({
		enabled: true,
		apiKey,
		runtime: {
			expectedSigner,
			verifier: createMagicBlockFinalizedAuditProofVerifier(),
			auditRecords: createPgMagicBlockAuditProofRecordStore({ sql }),
		},
	});
}
