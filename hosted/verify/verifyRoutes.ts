import { Hono } from "hono";

import type { VerifyService } from "./verifyContracts";
import { validateVerifyActionRequest } from "./verifyValidators";

export function createVerifyRoutes(verifyService: VerifyService): Hono {
	const routes = new Hono();

	routes.post("/verify", async (context) => {
		const body = await context.req.json().catch(() => undefined);
		const validation = validateVerifyActionRequest(body);

		if (validation.ok === false) {
			return context.json(
				{ error: { code: "BAD_REQUEST", message: validation.message } },
				400,
			);
		}

		const response = await verifyService.verifyAction(validation.request);
		return context.json(response, 200);
	});

	return routes;
}
