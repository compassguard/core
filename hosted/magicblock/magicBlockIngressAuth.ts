import { timingSafeEqual } from "node:crypto";

import type { MagicBlockBearerAuthorization } from "@back/services/magicBlockIngressAuthContracts";

export function createMagicBlockBearerAuthorization(
	expectedBearer: string,
): MagicBlockBearerAuthorization {
	if (expectedBearer.trim() === "") throw new Error("ingress authorization unavailable");
	const expected = new TextEncoder().encode(expectedBearer);
	return Object.freeze({
		authorize(header) {
			if (!header?.startsWith("Bearer ")) return false;
			const actual = new TextEncoder().encode(header.slice("Bearer ".length).trim());
			return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
		},
	});
}
