import { createMagicBlockAuditReadIngressFromEnv } from "@hosted/magicblock/magicBlockAuditReadIngressFromEnv";
import type { MagicBlockAuditReadIngress } from "@hosted/magicblock/magicBlockAuditReadIngress";

let cachedReadIngress: MagicBlockAuditReadIngress | undefined;

export async function GET(request: Request): Promise<Response> {
	return (cachedReadIngress ??= createMagicBlockAuditReadIngressFromEnv()).handle(request);
}
