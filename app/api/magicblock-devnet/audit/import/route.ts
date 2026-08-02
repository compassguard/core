import type { MagicBlockAuditProofImportIngress } from "@back/services/magicBlockAuditProofImportContracts";
import { createMagicBlockAuditProofImportIngressFromEnv } from "@hosted/magicblock/magicBlockAuditProofImportIngressFromEnv";

export const runtime = "nodejs";
export const maxDuration = 60;

let cachedIngress: MagicBlockAuditProofImportIngress | undefined;

export async function POST(request: Request): Promise<Response> {
	return resolveIngress().handle(request);
}

function resolveIngress(): MagicBlockAuditProofImportIngress {
	return (cachedIngress ??= createMagicBlockAuditProofImportIngressFromEnv());
}
