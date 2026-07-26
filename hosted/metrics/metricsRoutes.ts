import { Hono } from "hono";
import type { HostedContextVariables } from "@shared/hostedAuthMiddlewareContracts";

import type { MetricsService } from "./metricsContracts";

const FORBIDDEN_RESPONSE = {
	error: {
		code: "FORBIDDEN",
		message: "Metrics are operator-only.",
	},
} as const;

export type MetricsRoutesDependencies = {
	service: MetricsService;
	/** The shared COMPASS_HOSTED_API_KEY — held only by whoever deploys; never minted by /signup. */
	operatorKey?: string;
};

/**
 * GET /v1/metrics — operator-only, FAIL CLOSED (F15 family).
 *
 * The response carries every user's email and signup time, so the /v1 middleware's auth is
 * necessary but NOT sufficient: it admits any per-email credential, and /signup mints those
 * to anyone. The operator signal is the middleware's own split — the shared-key fast path
 * calls next() with NO identity set, a resolved credential always sets authenticatedEmail.
 *
 * Both conditions are required, because the identity check alone is not safe when no shared
 * key is configured: `expectedApiKey &&` in the middleware short-circuits, so no shared-key
 * path exists and no operator can exist either — leaving only credential callers, whom this
 * route must refuse. No configured key ⇒ no legitimate caller ⇒ 403, never a fall-through.
 */
export function createMetricsRoutes(deps: MetricsRoutesDependencies): Hono {
	const routes = new Hono<{ Variables: HostedContextVariables }>();
	const operatorKey = deps.operatorKey?.trim();

	routes.get("/metrics", async (context) => {
		if (!operatorKey) {
			return context.json(FORBIDDEN_RESPONSE, 403);
		}
		if (context.get("authenticatedEmail") !== undefined) {
			return context.json(FORBIDDEN_RESPONSE, 403);
		}

		return context.json(await deps.service.computeMetrics(), 200);
	});

	return routes;
}
