import { Hono } from "hono";

import type { WaitlistService } from "./waitlistContracts";
import { validateWaitlistRequest } from "./waitlistValidators";

export function createWaitlistRoutes(waitlistService: WaitlistService): Hono {
	const routes = new Hono();

	routes.post("/waitlist", async (context) => {
		const body = await context.req.json().catch(() => undefined);
		const validation = validateWaitlistRequest(body);

		if (validation.ok === false) {
			return context.json(
				{ error: { code: "BAD_REQUEST", message: validation.message } },
				400,
			);
		}

		const response = await waitlistService.join(validation.request);
		return context.json(response, 200);
	});

	return routes;
}
