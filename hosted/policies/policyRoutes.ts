import { Hono } from "hono";
import type { PolicyService } from "./policyContracts";

export function createPolicyRoutes(service: PolicyService): Hono {
	const routes = new Hono();

	routes.get("/policies", (context) =>
		context.json(service.getPolicySnapshot(), 200),
	);

	return routes;
}
