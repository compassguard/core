import { Hono } from "hono";

import type { SignupService } from "./signupContracts";
import { validateSignupRequest } from "./signupValidators";

export function createSignupRoutes(signupService: SignupService): Hono {
	const routes = new Hono();

	routes.post("/signup", async (context) => {
		const body = await context.req.json().catch(() => undefined);
		const validation = validateSignupRequest(body);

		if (validation.ok === false) {
			return context.json(
				{ error: { code: "BAD_REQUEST", message: validation.message } },
				400,
			);
		}

		const response = await signupService.signup(validation.request);
		return context.json(response, 200);
	});

	return routes;
}
