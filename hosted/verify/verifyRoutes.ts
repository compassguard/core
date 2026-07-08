import { Hono } from "hono";

import type { HostedContextVariables } from "@shared/hostedAuthMiddlewareContracts";

import type { VerifyService } from "./verifyContracts";
import { validateVerifyActionRequest } from "./verifyValidators";
import type { VerifyConfirmService } from "./verifyConfirmContracts";
import { validateVerifyConfirmRequest } from "./verifyConfirmValidators";

export function createVerifyRoutes(
	verifyService: VerifyService,
	verifyConfirmService: VerifyConfirmService,
): Hono<{ Variables: HostedContextVariables }> {
	const routes = new Hono<{ Variables: HostedContextVariables }>();

	routes.post("/verify", async (context) => {
		const body = await context.req.json().catch(() => undefined);
		const validation = validateVerifyActionRequest(body);

		if (validation.ok === false) {
			return context.json(
				{ error: { code: "BAD_REQUEST", message: validation.message } },
				400,
			);
		}

		// Credential-derived identity set by the /v1 auth middleware (undefined on the
		// shared-key path); passed as server-derived caller context, never from the body.
		const authenticatedEmail = context.get("authenticatedEmail");
		const response = await verifyService.verifyAction(validation.request, {
			authenticatedEmail,
		});
		return context.json(response, 200);
	});

	routes.post("/verify/confirm", async (context) => {
		const body = await context.req.json().catch(() => undefined);
		const validation = validateVerifyConfirmRequest(body);

		if (validation.ok === false) {
			return context.json(
				{ error: { code: "BAD_REQUEST", message: validation.message } },
				400,
			);
		}

		const response = await verifyConfirmService.verifyConfirm(validation.request);
		return context.json(response, 200);
	});

	return routes;
}
