import { Hono } from "hono";

import type { HostedContextVariables } from "@shared/hostedAuthMiddlewareContracts";
import type { Mandate, MandateStore } from "@shared/mandateContracts";

import { validateMandatePutRequest } from "./mandateValidators";

export type MandateRouteDependencies = {
	mandateStore: MandateStore;
	isoNow?: () => string;
};

/**
 * Mandate registration — the trusted anchor the /verify judge compares stated intent
 * against. ownerId precedence: authenticatedEmail (credential-derived) over self-reported
 * userId — on the shared-key auth path the binding is only as strong as the self-reported
 * userId; the per-email credential path makes it real.
 */
export function createMandateRoutes(
	deps: MandateRouteDependencies,
): Hono<{ Variables: HostedContextVariables }> {
	const isoNow = deps.isoNow ?? (() => new Date().toISOString());
	const routes = new Hono<{ Variables: HostedContextVariables }>();

	routes.post("/mandate", async (context) => {
		const body = await context.req.json().catch(() => undefined);
		const validation = validateMandatePutRequest(body);
		if (validation.ok === false) {
			return context.json(
				{ error: { code: "BAD_REQUEST", message: validation.message } },
				400,
			);
		}

		const ownerId = context.get("authenticatedEmail") ?? validation.request.userId;
		if (ownerId === undefined) {
			return context.json(
				{
					error: {
						code: "BAD_REQUEST",
						message: "An identity is required: authenticate per-email or provide userId.",
					},
				},
				400,
			);
		}

		const mandate: Mandate = {
			ownerId,
			mandateText: validation.request.mandateText,
			...(validation.request.allowedRecipients
				? { allowedRecipients: validation.request.allowedRecipients }
				: {}),
			...(validation.request.maxAmountUsd !== undefined
				? { maxAmountUsd: validation.request.maxAmountUsd }
				: {}),
			updatedAt: isoNow(),
		};
		await deps.mandateStore.put(mandate);
		return context.json(mandate, 200);
	});

	routes.get("/mandate", async (context) => {
		const queryUserId = context.req.query("userId");
		const ownerId =
			context.get("authenticatedEmail") ??
			(queryUserId !== undefined && queryUserId.trim().length > 0 ? queryUserId : undefined);
		if (ownerId === undefined) {
			return context.json(
				{
					error: {
						code: "BAD_REQUEST",
						message: "An identity is required: authenticate per-email or provide ?userId=.",
					},
				},
				400,
			);
		}

		const mandate = await deps.mandateStore.get(ownerId);
		if (!mandate) {
			return context.json(
				{ error: { code: "NOT_FOUND", message: "No mandate registered for this identity." } },
				404,
			);
		}
		return context.json(mandate, 200);
	});

	return routes;
}
