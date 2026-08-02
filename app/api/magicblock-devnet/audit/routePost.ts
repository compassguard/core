import type { MagicBlockAuditIngress } from "@back/services/magicBlockDevnetObservationContracts";
import { createMagicBlockAuditIngressFromEnv } from "@hosted/magicblock/magicBlockAuditIngressFromEnv";

let cachedIngress: MagicBlockAuditIngress | undefined;

export async function POST(request: Request): Promise<Response> {
	return (cachedIngress ??= createMagicBlockAuditIngressFromEnv()).handle(request);
}
