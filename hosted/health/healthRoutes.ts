import { Hono } from "hono";
import type {
	HealthResponse,
	HealthRouteDependencies,
} from "./healthContracts";

export function createHealthRoutes(deps: HealthRouteDependencies): Hono {
	const routes = new Hono();

	routes.get("/", (context) => {
		const response: HealthResponse = {
			ok: Object.values(deps.dependencies).every((status) => status === "ok"),
			service: "compass-hosted-guard",
			dependencies: deps.dependencies,
		};

		return context.json(response);
	});

	return routes;
}
