import type { MiddlewareHandler } from "hono";
import type {
	HostedAuthConfig,
	HostedAuthErrorResponse,
} from "@shared/hostedAuthMiddlewareContracts";

const BEARER_PREFIX = "Bearer ";

export function hostedAuthMiddleware(config: HostedAuthConfig): MiddlewareHandler {
	return async (context, next) => {
		if (context.req.path === "/health") {
			await next();
			return;
		}

		const expectedApiKey = config.apiKey?.trim();
		const authorization = context.req.header("Authorization") ?? "";
		const token = authorization.startsWith(BEARER_PREFIX)
			? authorization.slice(BEARER_PREFIX.length).trim()
			: "";

		if (!expectedApiKey || token !== expectedApiKey) {
			return context.json<HostedAuthErrorResponse>(
				{
					error: {
						code: "UNAUTHENTICATED",
						message: "Missing or invalid hosted API credentials.",
					},
				},
				401,
			);
		}

		await next();
	};
}
