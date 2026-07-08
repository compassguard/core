import type { MiddlewareHandler } from "hono";
import type {
	HostedAuthConfig,
	HostedAuthErrorResponse,
	HostedContextVariables,
} from "@shared/hostedAuthMiddlewareContracts";

import { hashApiKey } from "../credential/apiKey";
import type {
	CredentialIdentity,
	CredentialStore,
} from "../credential/credentialStore";

const BEARER_PREFIX = "Bearer ";

const UNAUTHENTICATED_RESPONSE: HostedAuthErrorResponse = {
	error: {
		code: "UNAUTHENTICATED",
		message: "Missing or invalid hosted API credentials.",
	},
};

/**
 * /v1/* auth. Additive (D3/R6): the shared COMPASS_HOSTED_API_KEY is accepted on a fast
 * path (no store call, no identity), OR a per-email opaque credential is resolved to an
 * identity. The credential lookup is a boundary read that FAILS CLOSED — any resolve error
 * or absent identity is a 401, never a fall-through to next() (F15 fail-open bug). The raw
 * token is never logged.
 */
export function hostedAuthMiddleware(
	config: HostedAuthConfig,
	credentialStore: CredentialStore,
): MiddlewareHandler<{ Variables: HostedContextVariables }> {
	return async (context, next) => {
		if (context.req.path === "/health") {
			await next();
			return;
		}

		const authorization = context.req.header("Authorization") ?? "";
		const token = authorization.startsWith(BEARER_PREFIX)
			? authorization.slice(BEARER_PREFIX.length).trim()
			: "";

		if (token === "") {
			return context.json(UNAUTHENTICATED_RESPONSE, 401);
		}

		// Shared-key fast path (R6/R8): a configured shared key matches exactly — return
		// with NO identity set and NO store call, keeping the MCP-proxy hot path fast.
		const expectedApiKey = config.apiKey?.trim();
		if (expectedApiKey && token === expectedApiKey) {
			await next();
			return;
		}

		// Per-email credential path: hash the presented token and resolve an active identity.
		// FAIL CLOSED (F15) — a store/DB error must 401, never skip to next().
		let identity: CredentialIdentity | undefined;
		try {
			identity = await credentialStore.resolveActive(hashApiKey(token));
		} catch {
			return context.json(UNAUTHENTICATED_RESPONSE, 401);
		}
		if (!identity) {
			return context.json(UNAUTHENTICATED_RESPONSE, 401);
		}

		context.set("authenticatedEmail", identity.email);
		await next();
	};
}
