import { createBoundedMagicBlockHttpsTransport } from "@back/services/magicBlockDevnetHttpsTransport";
import type { MagicBlockAuditIngress } from "@back/services/magicBlockDevnetObservationContracts";
import {
	createMagicBlockAuditSignerFromEnv,
	createMagicBlockOnchainAuditSubmitter,
} from "@back/services/magicBlockOnchainAudit";

import { createSqlExecutorFromEnv, readEnv } from "../db/sqlExecutorFromEnv";
import { createMagicBlockAuditIngress } from "./magicBlockAuditIngress";
import { createPgMagicBlockAppendOnlyAuditLedger } from "./magicBlockAuditLedgerPg";
import { createPgMagicBlockObservationStore } from "./magicBlockObservationStorePg";
import { createPgMagicBlockAuditRecordStore } from "./magicBlockAuditRecordStorePg";

const ENABLED_ENV = "COMPASS_MAGICBLOCK_AUDIT_INGRESS_ENABLED";
const API_KEY_ENV = "COMPASS_MAGICBLOCK_AUDIT_INGRESS_API_KEY";

export function createMagicBlockAuditIngressFromEnv(
	getEnv: (key: string) => string | undefined = readEnv,
): MagicBlockAuditIngress {
	if (getEnv(ENABLED_ENV)?.trim() !== "true") {
		return createMagicBlockAuditIngress({ enabled: false });
	}
	const apiKey = getEnv(API_KEY_ENV)?.trim();
	const sql = createSqlExecutorFromEnv(getEnv);
	const signer = createMagicBlockAuditSignerFromEnv(getEnv);
	if (!apiKey || !sql || !signer) {
		return {
			async handle() {
				return Response.json(
					{
						error: {
							code: "UNAVAILABLE",
							message: "Audit ingress is not fully configured.",
						},
					},
					{ status: 503 },
				);
			},
		};
	}
	return createMagicBlockAuditIngress({
		enabled: true,
		apiKey,
		runtime: {
			observations: createPgMagicBlockObservationStore({ sql }),
			createLedger: (binding) =>
				createPgMagicBlockAppendOnlyAuditLedger({ sql, ...binding }),
			post: createBoundedMagicBlockHttpsTransport(),
			onchainAudit: createMagicBlockOnchainAuditSubmitter({ signer }),
			auditRecords: createPgMagicBlockAuditRecordStore({ sql }),
		},
	});
}
