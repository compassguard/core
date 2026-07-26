import { Hono } from "hono";

import type { MetricsService } from "./metricsContracts";

export function createMetricsRoutes(service: MetricsService): Hono {
	const routes = new Hono();

	routes.get("/metrics", async (context) => context.json(await service.computeMetrics(), 200));

	return routes;
}
