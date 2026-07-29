import type { MagicBlockAuditIngress } from "@back/services/magicBlockDevnetObservationContracts";
import { createMagicBlockAuditIngressFromEnv } from "@hosted/magicblock/magicBlockAuditIngressFromEnv";

export const runtime = "nodejs";
export const maxDuration = 15;

let cachedIngress: MagicBlockAuditIngress | undefined;

export async function POST(request: Request): Promise<Response> {
	return resolveIngress().handle(request);
}

function resolveIngress(): MagicBlockAuditIngress {
	return (cachedIngress ??= createMagicBlockAuditIngressFromEnv());
}
